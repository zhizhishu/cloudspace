#!/bin/sh
set -eu

export ACCESS_LOCK_ENABLED="${ACCESS_LOCK_ENABLED:-true}"
export ACCESS_LOCK_PORT="${PORT:-${ACCESS_LOCK_PORT:-3000}}"
export SUB_STORE_UPSTREAM_HOST="${SUB_STORE_UPSTREAM_HOST:-127.0.0.1}"
export SUB_STORE_UPSTREAM_PORT="${SUB_STORE_UPSTREAM_PORT:-3001}"

if [ "$ACCESS_LOCK_ENABLED" = "true" ]; then
  export SUB_STORE_BACKEND_API_HOST="${SUB_STORE_BACKEND_API_HOST:-127.0.0.1}"
  export SUB_STORE_BACKEND_API_PORT="${SUB_STORE_BACKEND_API_PORT:-$SUB_STORE_UPSTREAM_PORT}"
else
  export SUB_STORE_BACKEND_API_HOST="${SUB_STORE_PUBLIC_HOST:-0.0.0.0}"
  export SUB_STORE_BACKEND_API_PORT="${PORT:-${SUB_STORE_BACKEND_API_PORT:-3000}}"
fi

export SUB_STORE_BACKEND_MERGE="${SUB_STORE_BACKEND_MERGE:-true}"
export SUB_STORE_FRONTEND_BACKEND_PATH="${SUB_STORE_FRONTEND_BACKEND_PATH:-/2cXaAxRGfddmGz2yx1wA}"
export SUB_STORE_FRONTEND_PATH="${SUB_STORE_FRONTEND_PATH:-/opt/app/frontend}"
export SUB_STORE_DATA_BASE_PATH="${SUB_STORE_DATA_BASE_PATH:-/opt/app/data}"
export SUB_STORE_INTERNAL_API_BASE="${SUB_STORE_INTERNAL_API_BASE:-http://127.0.0.1:${SUB_STORE_BACKEND_API_PORT}${SUB_STORE_FRONTEND_BACKEND_PATH}}"
export ACCESS_LOCK_UPSTREAM_HOST="${ACCESS_LOCK_UPSTREAM_HOST:-127.0.0.1}"
export ACCESS_LOCK_UPSTREAM_PORT="${ACCESS_LOCK_UPSTREAM_PORT:-$SUB_STORE_BACKEND_API_PORT}"
export ACCESS_LOCK_DATA_PATH="${ACCESS_LOCK_DATA_PATH:-$SUB_STORE_DATA_BASE_PATH/access-lock.json}"

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

  tmp_state="/tmp/sub-store-supabase-state.json"
  tmp_storage="/tmp/sub-store-supabase-storage.json"
  if curl -fsS \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    "$(supabase_storage_url)" \
    -o "$tmp_state"; then
    if ! node /opt/app/supabase-state.js restore "$tmp_state" "$SUB_STORE_DATA_BASE_PATH" "$tmp_storage"; then
      echo "Failed to unpack Supabase state; starting with current local data" >&2
      return 0
    fi

    if [ ! -s "$tmp_storage" ]; then
      echo "Supabase state has no Sub-Store storage; skipping restore"
      return 0
    fi

    if [ "$(wc -c < "$tmp_storage" | tr -d ' ')" -lt "${SUPABASE_BACKUP_MIN_BYTES:-200}" ]; then
      echo "Supabase backup is too small; skipping Sub-Store storage restore"
      return 0
    fi

    if { printf '{"content":"'; base64 "$tmp_storage" | tr -d '\n'; printf '"}'; } | curl -fsS \
      -X POST \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "${SUB_STORE_INTERNAL_API_BASE}/api/storage" >/dev/null; then
      echo "Restored Sub-Store data from Supabase state"
    else
      echo "Failed to restore Sub-Store data from Supabase state" >&2
    fi
  else
    echo "No readable Supabase state found; starting with current local data"
  fi
}

backup_to_supabase_once() {
  wait_for_sub_store || return 0
  ensure_supabase_bucket || return 0

  tmp_storage="/tmp/sub-store-supabase-storage.json"
  tmp_state="/tmp/sub-store-supabase-state.json"
  if ! curl -fsS "${SUB_STORE_INTERNAL_API_BASE}/api/storage" -o "$tmp_storage"; then
    echo "Failed to export Sub-Store storage for Supabase backup" >&2
    return 0
  fi

  bytes="$(wc -c < "$tmp_storage" | tr -d ' ')"
  if [ "$bytes" -lt "${SUPABASE_BACKUP_MIN_BYTES:-200}" ] && [ "${SUPABASE_BACKUP_ALLOW_EMPTY:-false}" != "true" ]; then
    echo "Sub-Store export is ${bytes} bytes; skipping backup to avoid overwriting with empty data"
    return 0
  fi

  if ! node /opt/app/supabase-state.js backup "$tmp_storage" "$SUB_STORE_DATA_BASE_PATH" "$tmp_state"; then
    echo "Failed to pack Supabase state" >&2
    return 0
  fi

  new_hash="$(sha256sum "$tmp_state" | awk '{print $1}')"
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
    --data-binary @"$tmp_state" \
    "$(supabase_storage_url)" >/dev/null; then
    printf '%s' "$new_hash" > /tmp/sub-store-supabase-backup.sha256
    echo "Backed up Sub-Store state to Supabase Storage (${bytes} storage bytes)"
  else
    echo "Failed to upload Sub-Store state to Supabase Storage" >&2
  fi
}

supabase_backup_loop() {
  sleep "${SUPABASE_BACKUP_INITIAL_DELAY_SECONDS:-60}"
  while true; do
    backup_to_supabase_once
    sleep "${SUPABASE_BACKUP_INTERVAL_SECONDS:-300}"
  done
}

start_http_meta() {
  [ "${HTTP_META_ENABLED:-true}" = "true" ] || return 0
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
}

start_sub_store() {
  node /opt/app/sub-store.bundle.js &
  SUB_STORE_PID="$!"
}

start_access_lock() {
  [ "$ACCESS_LOCK_ENABLED" = "true" ] || return 0
  node /opt/app/access-lock-proxy.js &
  ACCESS_LOCK_PID="$!"
  sleep 1
  if ! kill -0 "$ACCESS_LOCK_PID" 2>/dev/null; then
    echo "Access lock proxy failed to start" >&2
    exit 1
  fi
  echo "Access lock proxy listening on 0.0.0.0:${ACCESS_LOCK_PORT}"
}

stop_children() {
  for pid in "${ACCESS_LOCK_PID:-}" "${SUPABASE_BACKUP_PID:-}" "${SUB_STORE_PID:-}" "${HTTP_META_PID:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  wait "${ACCESS_LOCK_PID:-}" 2>/dev/null || true
  wait "${SUB_STORE_PID:-}" 2>/dev/null || true
}
trap stop_children INT TERM

HTTP_META_PID=""
SUB_STORE_PID=""
SUPABASE_BACKUP_PID=""
ACCESS_LOCK_PID=""

start_http_meta

if [ "$ACCESS_LOCK_ENABLED" = "true" ] || supabase_backup_enabled; then
  start_sub_store

  if supabase_backup_enabled; then
    restore_from_supabase
    supabase_backup_loop &
    SUPABASE_BACKUP_PID="$!"
  fi

  if [ "$ACCESS_LOCK_ENABLED" = "true" ]; then
    start_access_lock
    wait "$ACCESS_LOCK_PID"
  else
    wait "$SUB_STORE_PID"
  fi
else
  exec node /opt/app/sub-store.bundle.js
fi
