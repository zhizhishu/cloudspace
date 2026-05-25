#!/bin/sh
set -eu

export SUB_STORE_BACKEND_API_HOST="${SUB_STORE_BACKEND_API_HOST:-0.0.0.0}"
export SUB_STORE_BACKEND_API_PORT="${PORT:-${SUB_STORE_BACKEND_API_PORT:-3000}}"
export SUB_STORE_BACKEND_MERGE="${SUB_STORE_BACKEND_MERGE:-true}"
export SUB_STORE_FRONTEND_BACKEND_PATH="${SUB_STORE_FRONTEND_BACKEND_PATH:-/2cXaAxRGfddmGz2yx1wA}"
export SUB_STORE_FRONTEND_PATH="${SUB_STORE_FRONTEND_PATH:-/opt/app/frontend}"
export SUB_STORE_DATA_BASE_PATH="${SUB_STORE_DATA_BASE_PATH:-/opt/app/data}"
export SUB_STORE_BODY_JSON_LIMIT="${SUB_STORE_BODY_JSON_LIMIT:-2mb}"
export SUB_STORE_INTERNAL_API_BASE="${SUB_STORE_INTERNAL_API_BASE:-http://127.0.0.1:${SUB_STORE_BACKEND_API_PORT}${SUB_STORE_FRONTEND_BACKEND_PATH}}"
export SUB_STORE_NODE_MAX_OLD_SPACE_SIZE="${SUB_STORE_NODE_MAX_OLD_SPACE_SIZE:-256}"
export HTTP_META_NODE_MAX_OLD_SPACE_SIZE="${HTTP_META_NODE_MAX_OLD_SPACE_SIZE:-96}"
export CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-10}"
export CURL_MAX_TIME="${CURL_MAX_TIME:-120}"

mkdir -p "$SUB_STORE_DATA_BASE_PATH"

curl_with_limits() {
  curl -fsS \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" \
    --max-time "$CURL_MAX_TIME" \
    "$@"
}

curl_to_file_with_limit() {
  output_file="$1"
  shift
  max_bytes="${SUPABASE_BACKUP_MAX_BYTES:-1048576}"

  if [ "$max_bytes" -gt 0 ] 2>/dev/null; then
    curl_with_limits --max-filesize "$max_bytes" "$@" -o "$output_file"
  else
    curl_with_limits "$@" -o "$output_file"
  fi
}

file_bytes() {
  wc -c < "$1" | tr -d ' '
}

is_over_byte_limit() {
  bytes="$1"
  limit="$2"
  [ "$limit" -gt 0 ] 2>/dev/null && [ "$bytes" -gt "$limit" ]
}

memory_guard_ok() {
  min_kb="${SUPABASE_BACKUP_MIN_AVAILABLE_KB:-131072}"
  [ "$min_kb" = "0" ] && return 0

  available_kb="$(awk '/MemAvailable:/ { print $2; exit }' /proc/meminfo 2>/dev/null || true)"
  if [ -n "$available_kb" ] && [ "$available_kb" -lt "$min_kb" ] 2>/dev/null; then
    echo "Available memory is ${available_kb}KB; skipping Supabase backup below guard ${min_kb}KB"
    return 1
  fi

  return 0
}

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
  if curl_with_limits \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    "$(supabase_bucket_url)" >/dev/null 2>&1; then
    return 0
  fi

  bucket="${SUPABASE_STORAGE_BUCKET}"
  if printf '{"id":"%s","name":"%s","public":false}' "$bucket" "$bucket" | curl_with_limits \
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
    if curl -fsS --connect-timeout 2 --max-time 5 "${SUB_STORE_INTERNAL_API_BASE}/api/utils/env" >/dev/null 2>&1; then
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
  if curl_to_file_with_limit "$tmp_file" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    "$(supabase_storage_url)"; then
    bytes="$(file_bytes "$tmp_file")"
    if [ "$bytes" -lt "${SUPABASE_BACKUP_MIN_BYTES:-200}" ]; then
      echo "Supabase backup is too small; skipping restore"
      return 0
    fi

    if is_over_byte_limit "$bytes" "${SUPABASE_BACKUP_MAX_BYTES:-1048576}"; then
      echo "Supabase backup is ${bytes} bytes; skipping restore above limit ${SUPABASE_BACKUP_MAX_BYTES:-1048576}"
      return 0
    fi

    if { printf '{"content":"'; base64 "$tmp_file" | tr -d '\n'; printf '"}'; } | curl_with_limits \
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
  memory_guard_ok || return 0

  tmp_file="/tmp/sub-store-supabase-backup.json"
  if ! curl_to_file_with_limit "$tmp_file" "${SUB_STORE_INTERNAL_API_BASE}/api/storage"; then
    echo "Failed to export Sub-Store storage for Supabase backup, or export exceeded ${SUPABASE_BACKUP_MAX_BYTES:-1048576} bytes" >&2
    return 0
  fi

  bytes="$(file_bytes "$tmp_file")"
  if [ "$bytes" -lt "${SUPABASE_BACKUP_MIN_BYTES:-200}" ] && [ "${SUPABASE_BACKUP_ALLOW_EMPTY:-false}" != "true" ]; then
    echo "Sub-Store export is ${bytes} bytes; skipping backup to avoid overwriting with empty data"
    return 0
  fi

  if is_over_byte_limit "$bytes" "${SUPABASE_BACKUP_MAX_BYTES:-1048576}"; then
    echo "Sub-Store export is ${bytes} bytes; skipping backup above limit ${SUPABASE_BACKUP_MAX_BYTES:-1048576}"
    return 0
  fi

  new_hash="$(sha256sum "$tmp_file" | awk '{print $1}')"
  old_hash=""
  [ -f /tmp/sub-store-supabase-backup.sha256 ] && old_hash="$(cat /tmp/sub-store-supabase-backup.sha256)"
  if [ "$new_hash" = "$old_hash" ]; then
    return 0
  fi

  if curl_with_limits \
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

run_http_meta() {
  child_pid=""

  stop_http_meta() {
    [ -n "$child_pid" ] && kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
    exit 0
  }

  trap stop_http_meta INT TERM

  while true; do
    META_TEMP_FOLDER="${HTTP_META_TEMP_FOLDER:-/tmp/http-meta}" \
    META_FOLDER="${HTTP_META_FOLDER:-/opt/app/http-meta/meta}" \
    HOST="${HTTP_META_HOST:-127.0.0.1}" \
    PORT="${HTTP_META_PORT:-9876}" \
    node --max-old-space-size="${HTTP_META_NODE_MAX_OLD_SPACE_SIZE}" /opt/app/http-meta/http-meta.bundle.js &

    child_pid="$!"
    wait "$child_pid" || status="$?"
    status="${status:-0}"
    echo "HTTP META exited with status ${status}; restarting in ${HTTP_META_RESTART_DELAY_SECONDS:-5}s" >&2
    child_pid=""
    status=""
    sleep "${HTTP_META_RESTART_DELAY_SECONDS:-5}"
  done
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

  run_http_meta &
  HTTP_META_PID="$!"
  sleep "${HTTP_META_START_DELAY_SECONDS:-2}"

  if ! kill -0 "$HTTP_META_PID" 2>/dev/null; then
    echo "HTTP META failed to start" >&2
    exit 1
  fi

  echo "HTTP META listening on ${HTTP_META_HOST:-127.0.0.1}:${HTTP_META_PORT:-9876}"
fi

if supabase_backup_enabled; then
  node --max-old-space-size="${SUB_STORE_NODE_MAX_OLD_SPACE_SIZE}" /opt/app/sub-store.bundle.js &
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
  exec node --max-old-space-size="${SUB_STORE_NODE_MAX_OLD_SPACE_SIZE}" /opt/app/sub-store.bundle.js
fi
