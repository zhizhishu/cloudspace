# sub-store

Minimal Docker deployment for Sub-Store on Northflank.

Repository: https://github.com/zhizhishu/sub-store

The image downloads the latest Sub-Store frontend and backend release artifacts at build time. By default, Sub-Store runs as a merged frontend/backend service on an internal port, and a small access-lock proxy listens on `0.0.0.0:$PORT`.

## Runtime

- Public port: `3000` by default, or Northflank `PORT` when provided.
- Internal Sub-Store port: `3001` by default.
- Data path: `/opt/app/data`.
- Frontend path: `/opt/app/frontend`.
- Backend path: `/2cXaAxRGfddmGz2yx1wA`.
- Container listen host: the access-lock proxy listens on `0.0.0.0`; Sub-Store listens on `127.0.0.1`.
- Access lock: enabled by default. The first start generates an initial password if `ACCESS_LOCK_INITIAL_PASSWORD` is not set, then stores a hashed config in `/opt/app/data/access-lock.json`. After login, open `/__lock` to change the password.
- HTTP META: enabled by default on internal `127.0.0.1:9876` for Sub-Store Node.js script operations.

## Environment variables

| Name | Default |
| --- | --- |
| `ACCESS_LOCK_ENABLED` | `true` |
| `ACCESS_LOCK_PORT` | `$PORT` or `3000` |
| `ACCESS_LOCK_DATA_PATH` | `/opt/app/data/access-lock.json` |
| `ACCESS_LOCK_INITIAL_PASSWORD` | empty, generated on first start |
| `SUB_STORE_UPSTREAM_HOST` | `127.0.0.1` |
| `SUB_STORE_UPSTREAM_PORT` | `3001` |
| `SUB_STORE_BACKEND_API_HOST` | `127.0.0.1` |
| `SUB_STORE_BACKEND_API_PORT` | `3001` |
| `SUB_STORE_BACKEND_MERGE` | `true` |
| `SUB_STORE_FRONTEND_BACKEND_PATH` | `/2cXaAxRGfddmGz2yx1wA` |
| `SUB_STORE_FRONTEND_PATH` | `/opt/app/frontend` |
| `SUB_STORE_DATA_BASE_PATH` | `/opt/app/data` |
| `SUB_STORE_INTERNAL_API_BASE` | `http://127.0.0.1:$SUB_STORE_BACKEND_API_PORT$SUB_STORE_FRONTEND_BACKEND_PATH` |
| `HTTP_META_ENABLED` | `true` |
| `HTTP_META_HOST` | `127.0.0.1` |
| `HTTP_META_PORT` | `9876` |
| `HTTP_META_FOLDER` | `/opt/app/http-meta/meta` |
| `HTTP_META_TEMP_FOLDER` | `/tmp/http-meta` |
| `SUPABASE_BACKUP_ENABLED` | `false` |
| `SUPABASE_URL` | empty |
| `SUPABASE_SERVICE_ROLE_KEY` | empty |
| `SUPABASE_STORAGE_BUCKET` | empty |
| `SUPABASE_STORAGE_OBJECT` | `sub-store/storage.json` |
| `SUPABASE_RESTORE_ON_START` | `true` |
| `SUPABASE_BACKUP_INTERVAL_SECONDS` | `300` |
| `SUPABASE_BACKUP_INITIAL_DELAY_SECONDS` | `60` |
| `SUPABASE_BACKUP_MIN_BYTES` | `200` |
| `SUPABASE_BACKUP_ALLOW_EMPTY` | `false` |
| `SUPABASE_STATE_FILE_MAX_BYTES` | `262144` |

## Supabase Storage backup

Northflank persistent volumes are paid storage, so this image can use Supabase Storage as an external backup target instead. It is not a POSIX container volume; the container starts Sub-Store, verifies or creates a private Supabase Storage bucket, restores `storage.json` when present, then periodically exports `/api/storage` and uploads a state bundle back with upsert enabled.

The state bundle stores:

- Sub-Store's server-side `/api/storage` export.
- Small state files from `/opt/app/data`, including Sub-Store's own GitHub restore/sync config and the access-lock config file.

Browser-local OAuth sessions, browser localStorage, and GitHub website login cookies are not server-side Sub-Store data. Those cannot be restored by Supabase on another browser. The access lock avoids relying on a browser's GitHub login for basic private access.

Create a Supabase project, then set:

```env
SUPABASE_BACKUP_ENABLED=true
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-side service role key>
SUPABASE_STORAGE_BUCKET=sub-store
SUPABASE_STORAGE_OBJECT=sub-store/storage.json
```

Keep `SUPABASE_SERVICE_ROLE_KEY` only in Northflank runtime environment secrets. Do not expose it in the frontend or commit it to Git.

## Local build

```bash
docker build -t sub-store .
docker run --rm -p 3000:3000 sub-store
```

Open `http://localhost:3000/`. The generated initial password is printed once in the container logs. After login, open `http://localhost:3000/__lock` to change it.

## Sub-Store Node.js availability script

This image includes HTTP META and the mihomo core, so the Node.js version of the Sub-Store availability script can use the default internal endpoint:

```text
http_meta_protocol=http
http_meta_host=127.0.0.1
http_meta_port=9876
```

Example script link:

```text
https://raw.githubusercontent.com/xream/scripts/main/surge/modules/sub-store-scripts/check/http_meta_availability.js#show_latency=true&keep_incompatible=true&status=204&url=http%3A%2F%2Fconnectivitycheck.platform.hicloud.com%2Fgenerate_204&timeout=1000&retries=1&retry_delay=1000&concurrency=10&http_meta_protocol=http&http_meta_host=127.0.0.1&http_meta_port=9876&http_meta_start_delay=3000&http_meta_proxy_timeout=10000
```

## Northflank

Use a deployment service when deploying a published Docker image. Use a build service only if Northflank is linked to GitHub and should build this repository directly.

The intended source repository is:

```text
https://github.com/zhizhishu/sub-store
```

Published container image:

```text
ghcr.io/zhizhishu/sub-store:latest
```
