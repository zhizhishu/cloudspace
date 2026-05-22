FROM node:20-alpine AS fetcher

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

FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    SUB_STORE_BACKEND_API_HOST=0.0.0.0 \
    SUB_STORE_BACKEND_API_PORT=3000 \
    SUB_STORE_BACKEND_MERGE=true \
    SUB_STORE_FRONTEND_BACKEND_PATH=/2cXaAxRGfddmGz2yx1wA \
    SUB_STORE_FRONTEND_PATH=/opt/app/frontend \
    SUB_STORE_DATA_BASE_PATH=/opt/app/data

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
