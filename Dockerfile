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
    ACCESS_LOCK_ENABLED=true \
    ACCESS_LOCK_PORT=3000 \
    ACCESS_LOCK_DATA_PATH=/opt/app/data/access-lock.json \
    SUB_STORE_UPSTREAM_HOST=127.0.0.1 \
    SUB_STORE_UPSTREAM_PORT=3001 \
    SUB_STORE_BACKEND_API_HOST=127.0.0.1 \
    SUB_STORE_BACKEND_API_PORT=3001 \
    SUB_STORE_BACKEND_MERGE=true \
    SUB_STORE_FRONTEND_BACKEND_PATH=/2cXaAxRGfddmGz2yx1wA \
    SUB_STORE_FRONTEND_PATH=/opt/app/frontend \
    SUB_STORE_DATA_BASE_PATH=/opt/app/data \
    HTTP_META_ENABLED=true \
    HTTP_META_HOST=127.0.0.1 \
    HTTP_META_PORT=9876 \
    HTTP_META_START_DELAY_SECONDS=2 \
    HTTP_META_FOLDER=/opt/app/http-meta/meta \
    HTTP_META_TEMP_FOLDER=/tmp/http-meta

WORKDIR /opt/app

COPY --from=fetcher /opt/app /opt/app
COPY start.sh /usr/local/bin/start-sub-store
COPY access-lock-proxy.js /opt/app/access-lock-proxy.js
COPY supabase-state.js /opt/app/supabase-state.js

RUN chmod +x /usr/local/bin/start-sub-store \
    && addgroup -S substore \
    && adduser -S -G substore substore \
    && chown -R substore:substore /opt/app

USER substore

EXPOSE 3000
VOLUME ["/opt/app/data"]

CMD ["start-sub-store"]
