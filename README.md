# sub-store

Minimal Docker deployment for Sub-Store on Northflank.

Repository: https://github.com/zhizhishu/sub-store

The image downloads the latest Sub-Store frontend and backend release artifacts at build time, then runs the merged frontend/backend service on `0.0.0.0:$PORT`.

## Runtime

- Port: `3000` by default, or Northflank `PORT` when provided.
- Data path: `/opt/app/data`.
- Frontend path: `/opt/app/frontend`.
- Backend path: `/2cXaAxRGfddmGz2yx1wA`.
- Container listen host: `0.0.0.0`, so Northflank can route traffic into the container.
- HTTP META: enabled by default on internal `127.0.0.1:9876` for Sub-Store Node.js script operations.

## Environment variables

| Name | Default |
| --- | --- |
| `SUB_STORE_BACKEND_API_HOST` | `0.0.0.0` |
| `SUB_STORE_BACKEND_API_PORT` | `$PORT` or `3000` |
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

## Supabase Storage backup

Northflank persistent volumes are paid storage, so this image can use Supabase Storage as an external backup target instead. It is not a POSIX container volume; the container starts Sub-Store, restores `storage.json` from Supabase Storage when present, then periodically exports `/api/storage` and uploads it back with upsert enabled.

Create a private Supabase Storage bucket, then set:

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

Open `http://localhost:3000/`.

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
