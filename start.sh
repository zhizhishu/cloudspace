#!/bin/sh
set -eu

export SUB_STORE_BACKEND_API_HOST="${SUB_STORE_BACKEND_API_HOST:-0.0.0.0}"
export SUB_STORE_BACKEND_API_PORT="${PORT:-${SUB_STORE_BACKEND_API_PORT:-3000}}"
export SUB_STORE_BACKEND_MERGE="${SUB_STORE_BACKEND_MERGE:-true}"
export SUB_STORE_FRONTEND_BACKEND_PATH="${SUB_STORE_FRONTEND_BACKEND_PATH:-/2cXaAxRGfddmGz2yx1wA}"
export SUB_STORE_FRONTEND_PATH="${SUB_STORE_FRONTEND_PATH:-/opt/app/frontend}"
export SUB_STORE_DATA_BASE_PATH="${SUB_STORE_DATA_BASE_PATH:-/opt/app/data}"

mkdir -p "$SUB_STORE_DATA_BASE_PATH"

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

exec node /opt/app/sub-store.bundle.js
