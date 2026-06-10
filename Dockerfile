FROM node:20-alpine AS fetcher

ARG HTTP_META_VERSION=1.1.0
ARG MIHOMO_VERSION=v1.19.25

RUN apk add --no-cache ca-certificates curl unzip

WORKDIR /opt/app

RUN mkdir -p /opt/app/frontend /opt/app/data \
    && curl -fsSL -o /tmp/cloudspace-frontend.zip \
        https://github.com/sub-store-org/Sub-Store-Front-End/releases/latest/download/dist.zip \
    && unzip -q /tmp/cloudspace-frontend.zip -d /tmp/cloudspace-frontend \
    && if [ -d /tmp/cloudspace-frontend/dist ]; then \
        cp -a /tmp/cloudspace-frontend/dist/. /opt/app/frontend/; \
      else \
        cp -a /tmp/cloudspace-frontend/. /opt/app/frontend/; \
      fi \
    && curl -fsSL -o /opt/app/cloudspace-core.bundle.js \
        https://github.com/sub-store-org/Sub-Store/releases/latest/download/sub-store.bundle.js

RUN mkdir -p /opt/app/http-meta/meta \
    && curl -fsSL -o /opt/app/http-meta/http-meta.bundle.js \
        "https://github.com/xream/http-meta/releases/download/${HTTP_META_VERSION}/http-meta.bundle.js" \
    && curl -fsSL -o /opt/app/http-meta/meta/tpl.yaml \
        "https://github.com/xream/http-meta/releases/download/${HTTP_META_VERSION}/tpl.yaml" \
    && curl -fsSL -o /tmp/mihomo.gz \
        "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz" \
    && gunzip -c /tmp/mihomo.gz > /opt/app/http-meta/meta/http-meta \
    && chmod +x /opt/app/http-meta/meta/http-meta \
    && rm -f /tmp/mihomo.gz

FROM node:20-alpine

RUN apk add --no-cache ca-certificates curl procps tzdata

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=7860 \
    CLOUDSPACE_PRODUCT_NAME=CloudSpace \
    ACCESS_LOCK_ENABLED=true \
    ACCESS_LOCK_PORT=7860 \
    ACCESS_LOCK_DATA_PATH=/opt/app/data/cloudspace-access.json \
    ACCESS_LOCK_UPSTREAM_TIMEOUT_MS=300000 \
    ACCESS_LOCK_MAX_FRONTEND_TRANSFORM_BYTES=2097152 \
    ACCESS_LOCK_FRONTEND_CACHE_CONTROL=no-store \
    ACCESS_LOCK_API_CACHE_CONTROL=no-store \
    CLOUDSPACE_API_MAX_CONCURRENT=4 \
    CLOUDSPACE_API_MAX_BODY_BYTES=8388608 \
    CLOUDSPACE_PUBLIC_HEALTH=true \
    CLOUDSPACE_HEALTH_TIMEOUT_MS=2500 \
    CLOUDSPACE_HEALTH_CACHE_MS=10000 \
    CLOUDSPACE_UPSTREAM_HOST=127.0.0.1 \
    CLOUDSPACE_UPSTREAM_PORT=3001 \
    CLOUDSPACE_BACKEND_API_HOST=127.0.0.1 \
    CLOUDSPACE_BACKEND_API_PORT=3001 \
    CLOUDSPACE_BACKEND_MERGE=true \
    CLOUDSPACE_BACKEND_PATH=/2cXaAxRGfddmGz2yx1wA \
    CLOUDSPACE_FRONTEND_PATH=/opt/app/frontend \
    CLOUDSPACE_DATA_BASE_PATH=/opt/app/data \
    CLOUDSPACE_BODY_JSON_LIMIT=8mb \
    CLOUDSPACE_CORE_NODE_MAX_OLD_SPACE_SIZE=768 \
    CLOUDSPACE_ACCESS_NODE_MAX_OLD_SPACE_SIZE=128 \
    CLOUDSPACE_JOBS_PATH=/__cloudspace/jobs \
    CLOUDSPACE_JOB_ENABLED=true \
    CLOUDSPACE_JOB_MAX_CONCURRENT=2 \
    CLOUDSPACE_JOB_MAX_QUEUE=20 \
    CLOUDSPACE_JOB_MAX_BODY_BYTES=67108864 \
    CLOUDSPACE_JOB_RESULT_MAX_BYTES=67108864 \
    CLOUDSPACE_JOB_TIMEOUT_MS=300000 \
    CLOUDSPACE_JOB_RETENTION_MS=86400000 \
    HTTP_META_ENABLED=true \
    HTTP_META_HOST=127.0.0.1 \
    HTTP_META_PORT=9876 \
    HTTP_META_BODY_JSON_LIMIT=32mb \
    HTTP_META_NODE_MAX_OLD_SPACE_SIZE=256 \
    HTTP_META_START_DELAY_SECONDS=2 \
    HTTP_META_RESTART_ENABLED=true \
    HTTP_META_RESTART_DELAY_SECONDS=5 \
    HTTP_META_FOLDER=/opt/app/http-meta/meta \
    HTTP_META_TEMP_FOLDER=/tmp/http-meta \
    CURL_CONNECT_TIMEOUT=10 \
    CURL_MAX_TIME=180 \
    SUPABASE_BACKUP_MAX_BYTES=16777216 \
    SUPABASE_BACKUP_REQUIRE_VALID_STORAGE=true \
    SUPABASE_RESTORE_REQUIRE_VALID_STORAGE=true \
    SUPABASE_DAILY_BACKUP_ENABLED=true \
    SUPABASE_DAILY_BACKUP_PREFIX=cloudspace/daily \
    CLOUDSPACE_CACHE_CLEANUP_ENABLED=true \
    CLOUDSPACE_CACHE_CLEANUP_INTERVAL_SECONDS=600 \
    CLOUDSPACE_CACHE_MAX_AGE_MINUTES=360 \
    CLOUDSPACE_CACHE_MIN_DELETE_AGE_MINUTES=15 \
    CLOUDSPACE_CACHE_MAX_KB=262144 \
    CLOUDSPACE_CACHE_EMERGENCY_PURGE=true

WORKDIR /opt/app

COPY --from=fetcher /opt/app /opt/app
COPY start.sh /usr/local/bin/start-cloudspace
COPY cloudspace-access-proxy.js /opt/app/cloudspace-access-proxy.js
COPY cloudspace-state.js /opt/app/cloudspace-state.js

RUN chmod +x /usr/local/bin/start-cloudspace \
    && addgroup -S cloudspace \
    && adduser -S -G cloudspace cloudspace \
    && chown -R cloudspace:cloudspace /opt/app

USER cloudspace

EXPOSE 7860
VOLUME ["/opt/app/data"]

CMD ["start-cloudspace"]
