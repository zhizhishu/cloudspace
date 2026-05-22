#!/bin/sh
set -eu

export SUB_STORE_BACKEND_API_HOST="${SUB_STORE_BACKEND_API_HOST:-0.0.0.0}"
export SUB_STORE_BACKEND_API_PORT="${PORT:-${SUB_STORE_BACKEND_API_PORT:-3000}}"
export SUB_STORE_BACKEND_MERGE="${SUB_STORE_BACKEND_MERGE:-true}"
export SUB_STORE_FRONTEND_BACKEND_PATH="${SUB_STORE_FRONTEND_BACKEND_PATH:-/2cXaAxRGfddmGz2yx1wA}"
export SUB_STORE_FRONTEND_PATH="${SUB_STORE_FRONTEND_PATH:-/opt/app/frontend}"
export SUB_STORE_DATA_BASE_PATH="${SUB_STORE_DATA_BASE_PATH:-/opt/app/data}"
export SUB_STORE_INTERNAL_API_BASE="${SUB_STORE_INTERNAL_API_BASE:-http://127.0.0.1:${SUB_STORE_BACKEND_API_PORT}${SUB_STORE_FRONTEND_BACKEND_PATH}}"

mkdir -p "$SUB_STORE_DATA_BASE_PATH"

supabase_backup_enabled() {
  [ "${SUPABASE_BACKUP_ENABLED:-false}" = "true" ] \
    && [ -n "${SUPABASE_URL:-}" ] \
    && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] \
    && [ -n "${SUPABASE_STORAGE_BUCKET:-}" ]
}

supabase_object_path() {
  printf '%s' "${SUPABASE_STORAGE_OBJECT:-sub-store/storage.json}"
}

supabase_storage_url() {
  bucket="${SUPABASE_STORAGE_BUCKET}"
  object_path="$(supabase_object_path)"
  printf '%s/storage/v1/object/%s/%s' "${SUPABASE_URL%/}" "$bucket" "$object_path"
}

supabase_bucket_url() {
  printf '%s/storage/v1/bucket/%s' "${SUPABASE_URL%/}" "${SUPABASE_STORAGE_BUCKET}"
}

ensure_supabase_bucket() {
  if curl -fsS \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    "$(supabase_bucket_url)" >/dev/null 2>&1; then
    return 0
  fi

  bucket="${SUPABASE_STORAGE_BUCKET}"
  if printf '{"id":"%s","name":"%s","public":false}' "$bucket" "$bucket" | curl -fsS \
    -X POST \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "${SUPABASE_URL%/}/storage/v1/bucket" >/dev/null; then
    echo "Created private Supabase Storage bucket: ${bucket}"
    return 0
  fi

  echo "Failed to verify or create Supabase Storage bucket: ${bucket}" >&2
  return 1
}

wait_for_sub_store() {
  timeout="${SUB_STORE_BACKUP_WAIT_SECONDS:-60}"
  i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -fsS "${SUB_STORE_INTERNAL_API_BASE}/api/utils/env" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "Sub-Store API did not become ready within ${timeout}s" >&2
  return 1
}

restore_from_supabase() {
  [ "${SUPABASE_RESTORE_ON_START:-true}" = "true" ] || return 0
  wait_for_sub_store || return 0
  ensure_supabase_bucket || return 0

  tmp_file="/tmp/sub-store-supabase-restore.json"
  if curl -fsS \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    "$(supabase_storage_url)" \
    -o "$tmp_file"; then
    if [ "$(wc -c < "$tmp_file" | tr -d ' ')" -lt "${SUPABASE_BACKUP_MIN_BYTES:-200}" ]; then
      echo "Supabase backup is too small; skipping restore"
      return 0
    fi

    content="$(base64 "$tmp_file" | tr -d '\n')"
    if printf '{"content":"%s"}' "$content" | curl -fsS \
      -X POST \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "${SUB_STORE_INTERNAL_API_BASE}/api/storage" >/dev/null; then
      echo "Restored Sub-Store data from Supabase Storage"
    else
      echo "Failed to restore Sub-Store data from Supabase Storage" >&2
    fi
  else
    echo "No readable Supabase backup found; starting with current local data"
  fi
}

backup_to_supabase_once() {
  wait_for_sub_store || return 0
  ensure_supabase_bucket || return 0

  tmp_file="/tmp/sub-store-supabase-backup.json"
  if ! curl -fsS "${SUB_STORE_INTERNAL_API_BASE}/api/storage" -o "$tmp_file"; then
    echo "Failed to export Sub-Store storage for Supabase backup" >&2
    return 0
  fi

  bytes="$(wc -c < "$tmp_file" | tr -d ' ')"
  if [ "$bytes" -lt "${SUPABASE_BACKUP_MIN_BYTES:-200}" ] && [ "${SUPABASE_BACKUP_ALLOW_EMPTY:-false}" != "true" ]; then
    echo "Sub-Store export is ${bytes} bytes; skipping backup to avoid overwriting with empty data"
    return 0
  fi

  new_hash="$(sha256sum "$tmp_file" | awk '{print $1}')"
  old_hash=""
  [ -f /tmp/sub-store-supabase-backup.sha256 ] && old_hash="$(cat /tmp/sub-store-supabase-backup.sha256)"
  if [ "$new_hash" = "$old_hash" ]; then
    return 0
  fi

  if curl -fsS \
    -X POST \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "x-upsert: true" \
    -H "Content-Type: application/json" \
    --data-binary @"$tmp_file" \
    "$(supabase_storage_url)" >/dev/null; then
    printf '%s' "$new_hash" > /tmp/sub-store-supabase-backup.sha256
    echo "Backed up Sub-Store data to Supabase Storage (${bytes} bytes)"
  else
    echo "Failed to upload Sub-Store backup to Supabase Storage" >&2
  fi
}

supabase_backup_loop() {
  sleep "${SUPABASE_BACKUP_INITIAL_DELAY_SECONDS:-60}"
  while true; do
    backup_to_supabase_once
    sleep "${SUPABASE_BACKUP_INTERVAL_SECONDS:-300}"
  done
}

if [ "${HTTP_META_ENABLED:-true}" = "true" ]; then
  mkdir -p "${HTTP_META_TEMP_FOLDER:-/tmp/http-meta}"

  META_TEMP_FOLDER="${HTTP_META_TEMP_FOLDER:-/tmp/http-meta}" \
  META_FOLDER="${HTTP_META_FOLDER:-/opt/app/http-meta/meta}" \
  HOST="${HTTP_META_HOST:-127.0.0.1}" \
  PORT="${HTTP_META_PORT:-9876}" \
  node /opt/app/http-meta/http-meta.bundle.js &

  HTTP_META_PID="$!"
  sleep "${HTTP_META_START_DELAY_SECONDS:-2}"

  if ! kill -0 "$HTTP_META_PID" 2>/dev/null; then
    echo "HTTP META failed to start" >&2
    exit 1
  fi

  echo "HTTP META listening on ${HTTP_META_HOST:-127.0.0.1}:${HTTP_META_PORT:-9876}"
fi

if supabase_backup_enabled; then
  node /opt/app/sub-store.bundle.js &
  SUB_STORE_PID="$!"
  SUPABASE_BACKUP_PID=""

  stop_children() {
    for pid in "$SUB_STORE_PID" "${SUPABASE_BACKUP_PID:-}" "${HTTP_META_PID:-}"; do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    wait "$SUB_STORE_PID" 2>/dev/null || true
  }
  trap stop_children INT TERM

  restore_from_supabase

  supabase_backup_loop &
  SUPABASE_BACKUP_PID="$!"

  wait "$SUB_STORE_PID"
else
  exec node /opt/app/sub-store.bundle.js
fi
