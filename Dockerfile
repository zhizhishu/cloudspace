FROM node:20-alpine AS fetcher

ARG HTTP_META_VERSION=1.1.0
ARG MIHOMO_VERSION=v1.19.25

RUN apk add --no-cache ca-certificates curl unzip

WORKDIR /opt/app

RUN mkdir -p /opt/app/frontend /opt/app/data \
    && curl -fsSL -o /tmp/sub-store-frontend.zip \
        https://github.com/sub-store-org/Sub-Store-Front-End/releases/latest/download/dist.zip \
    && unzip -q /tmp/sub-store-frontend.zip -d /tmp/sub-store-frontend \
    && if [ -d /tmp/sub-store-frontend/dist ]; then \
        cp -a /tmp/sub-store-frontend/dist/. /opt/app/frontend/; \
      else \
        cp -a /tmp/sub-store-frontend/. /opt/app/frontend/; \
      fi \
    && curl -fsSL -o /opt/app/sub-store.bundle.js \
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
    PORT=3000 \
    SUB_STORE_BACKEND_API_HOST=0.0.0.0 \
    SUB_STORE_BACKEND_API_PORT=3000 \
    SUB_STORE_BACKEND_MERGE=true \
    SUB_STORE_FRONTEND_BACKEND_PATH=/2cXaAxRGfddmGz2yx1wA \
    SUB_STORE_FRONTEND_PATH=/opt/app/frontend \
    SUB_STORE_DATA_BASE_PATH=/opt/app/data \
    SUB_STORE_BODY_JSON_LIMIT=2mb \
    HTTP_META_ENABLED=true \
    HTTP_META_HOST=127.0.0.1 \
    HTTP_META_PORT=9876 \
    HTTP_META_START_DELAY_SECONDS=2 \
    HTTP_META_FOLDER=/opt/app/http-meta/meta \
    HTTP_META_TEMP_FOLDER=/tmp/http-meta \
    HTTP_META_NODE_MAX_OLD_SPACE_SIZE=96 \
    HTTP_META_RESTART_DELAY_SECONDS=5 \
    SUB_STORE_NODE_MAX_OLD_SPACE_SIZE=256 \
    SUPABASE_BACKUP_MAX_BYTES=1048576 \
    SUPABASE_BACKUP_MIN_AVAILABLE_KB=131072 \
    CURL_CONNECT_TIMEOUT=10 \
    CURL_MAX_TIME=120

WORKDIR /opt/app

COPY --from=fetcher /opt/app /opt/app
COPY start.sh /usr/local/bin/start-sub-store

RUN chmod +x /usr/local/bin/start-sub-store \
    && addgroup -S substore \
    && adduser -S -G substore substore \
    && chown -R substore:substore /opt/app

USER substore

EXPOSE 3000
VOLUME ["/opt/app/data"]

CMD ["start-sub-store"]
