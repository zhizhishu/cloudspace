---
title: CloudSpace
emoji: ☁️
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
---

# CloudSpace

CloudSpace is a private subscription workspace image for `zhizhishu`. It packages a merged web UI, backend API, HTTP META helper, external state backup, and a password-protected access gateway into one Docker container.

Repository: https://github.com/zhizhishu/cloudspace

Published image:

```text
ghcr.io/zhizhishu/cloudspace:latest
```

## Runtime

- Public port: `7860` by default for Hugging Face Spaces, or platform `PORT` when provided.
- Internal core port: `3001` by default.
- Data path: `/opt/app/data`.
- Frontend path: `/opt/app/frontend`.
- Backend path: `/2cXaAxRGfddmGz2yx1wA`.
- Container listen host: the CloudSpace access gateway listens on `0.0.0.0`; the internal core listens on `127.0.0.1`.
- Access lock: enabled by default. The first start generates an initial password if `ACCESS_LOCK_INITIAL_PASSWORD` is not set, then stores a hashed config in `/opt/app/data/cloudspace-access.json`. After login, open `/__lock` to change the password.
- HTTP META: enabled by default on internal `127.0.0.1:9876` for Node.js script operations.

## Environment Variables

| Name | Default |
| --- | --- |
| `CLOUDSPACE_PRODUCT_NAME` | `CloudSpace` |
| `ACCESS_LOCK_ENABLED` | `true` |
| `ACCESS_LOCK_PORT` | `$PORT` or `3000` |
| `ACCESS_LOCK_DATA_PATH` | `/opt/app/data/cloudspace-access.json` |
| `ACCESS_LOCK_INITIAL_PASSWORD` | empty, generated on first start |
| `ACCESS_LOCK_UPSTREAM_TIMEOUT_MS` | `300000` |
| `ACCESS_LOCK_REQUEST_TIMEOUT_MS` | upstream timeout + `30000` |
| `ACCESS_LOCK_MAX_FRONTEND_TRANSFORM_BYTES` | `2097152` |
| `CLOUDSPACE_UPSTREAM_HOST` | `127.0.0.1` |
| `CLOUDSPACE_UPSTREAM_PORT` | `3001` |
| `CLOUDSPACE_BACKEND_API_HOST` | `127.0.0.1` |
| `CLOUDSPACE_BACKEND_API_PORT` | `3001` |
| `CLOUDSPACE_BACKEND_MERGE` | `true` |
| `CLOUDSPACE_BACKEND_PATH` | `/2cXaAxRGfddmGz2yx1wA` |
| `CLOUDSPACE_FRONTEND_PATH` | `/opt/app/frontend` |
| `CLOUDSPACE_DATA_BASE_PATH` | `/opt/app/data` |
| `CLOUDSPACE_INTERNAL_API_BASE` | `http://127.0.0.1:$CLOUDSPACE_BACKEND_API_PORT$CLOUDSPACE_BACKEND_PATH` |
| `CLOUDSPACE_BODY_JSON_LIMIT` | `8mb` |
| `CLOUDSPACE_CORE_NODE_MAX_OLD_SPACE_SIZE` | `768` |
| `CLOUDSPACE_ACCESS_NODE_MAX_OLD_SPACE_SIZE` | `128` |
| `HTTP_META_ENABLED` | `true` |
| `HTTP_META_HOST` | `127.0.0.1` |
| `HTTP_META_PORT` | `9876` |
| `HTTP_META_FOLDER` | `/opt/app/http-meta/meta` |
| `HTTP_META_TEMP_FOLDER` | `/tmp/http-meta` |
| `HTTP_META_NODE_MAX_OLD_SPACE_SIZE` | `128` |
| `CURL_CONNECT_TIMEOUT` | `10` |
| `CURL_MAX_TIME` | `180` |
| `SUPABASE_BACKUP_ENABLED` | `false` |
| `SUPABASE_URL` | empty |
| `SUPABASE_SERVICE_ROLE_KEY` | empty |
| `SUPABASE_STORAGE_BUCKET` | empty |
| `SUPABASE_STORAGE_OBJECT` | `cloudspace/storage.json` |
| `SUPABASE_RESTORE_ON_START` | `true` |
| `SUPABASE_BACKUP_INTERVAL_SECONDS` | `300` |
| `SUPABASE_BACKUP_INITIAL_DELAY_SECONDS` | `60` |
| `SUPABASE_BACKUP_MIN_BYTES` | `200` |
| `SUPABASE_BACKUP_MAX_BYTES` | `16777216` |
| `SUPABASE_BACKUP_ALLOW_EMPTY` | `false` |
| `SUPABASE_STATE_FILE_MAX_BYTES` | `262144` |

CloudSpace still maps a small set of internal compatibility variables for the bundled upstream core at container startup. Keep the public deployment configuration on the `CLOUDSPACE_*` variables unless you are debugging the core process directly.

## Subscription Stall Guards

Hugging Face Spaces can still hang on very large subscription import/export, conversion, or availability-test requests when the upstream core waits on slow remote URLs. CloudSpace now adds guardrails so a bad subscription job fails with a bounded error instead of pinning the whole access gateway forever:

- The access gateway gives upstream API calls up to `ACCESS_LOCK_UPSTREAM_TIMEOUT_MS` milliseconds, default `300000` (5 minutes), then returns `504`.
- The gateway only buffers up to `ACCESS_LOCK_MAX_FRONTEND_TRANSFORM_BYTES` while branding frontend HTML/JS; larger frontend assets pass through without transformation to avoid memory spikes.
- The bundled core, access gateway, and HTTP META helper start with separate Node heap caps.
- Supabase restore/backup curl calls use connection/total timeouts and skip state exports above `SUPABASE_BACKUP_MAX_BYTES`.

For extremely large subscription work, prefer lowering script-side `concurrency` and increasing script-side `timeout` in the CloudSpace/subscription task itself. Raising `ACCESS_LOCK_UPSTREAM_TIMEOUT_MS` is useful only when the request is slow but still making progress; if a provider URL is dead, letting it wait longer just makes the spinner feel more dramatic, which is adorable but useless.

## Access Password

Use `/__lock` for normal password changes after login.

`ACCESS_LOCK_INITIAL_PASSWORD` is an initial/reset seed, not a value that should overwrite the user-managed password on every restart. CloudSpace stores only a hash of the password plus a fingerprint of the last applied initial secret in `/opt/app/data/cloudspace-access.json`.

- First start: if `ACCESS_LOCK_INITIAL_PASSWORD` is set, CloudSpace uses it as the initial password.
- Normal change: changing the password from `/__lock` survives restarts and Supabase restore.
- Forced reset: changing `ACCESS_LOCK_INITIAL_PASSWORD` in Hugging Face or another platform secret, then restarting the container, applies the new secret once as a password reset.

If Supabase restore is enabled, the restored access-lock config is loaded before the access gateway starts. That means the password stored in the restored state remains active unless the platform secret has changed since the last applied reset.

## Supabase Storage Backup

CloudSpace can use Supabase Storage as an external backup target. It is not a POSIX container volume; the container starts the core service, verifies or creates a private Supabase Storage bucket, restores `storage.json` when present, then periodically exports `/api/storage` and uploads a CloudSpace state bundle back with upsert enabled.

The state bundle stores:

- CloudSpace server-side `/api/storage` export.
- Small state files from `/opt/app/data`, including CloudSpace restore/sync config and the access-lock config file.

Browser-local OAuth sessions, browser localStorage, and GitHub website login cookies are not server-side CloudSpace data. Those cannot be restored by Supabase on another browser or device, so GitHub may still ask for login again there. The access lock avoids relying on a browser's GitHub login for basic private access.

Create a Supabase project, then set:

```env
SUPABASE_BACKUP_ENABLED=true
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-side service role key>
SUPABASE_STORAGE_BUCKET=cloudspace
SUPABASE_STORAGE_OBJECT=cloudspace/storage.json
```

Keep `SUPABASE_SERVICE_ROLE_KEY` only in runtime environment secrets. Do not expose it in the frontend or commit it to Git.

## Local Build

```bash
docker build -t cloudspace .
docker run --rm -p 3000:3000 cloudspace
```

Open `http://localhost:3000/`. The generated initial password is printed once in the container logs. After login, open `http://localhost:3000/__lock` to change it.

## Node.js Availability Script

This image includes HTTP META and the mihomo core, so Node.js availability and geo scripts can use the default internal endpoint:

```text
http_meta_protocol=http
http_meta_host=127.0.0.1
http_meta_port=9876
```

## Northflank

Use a deployment service when deploying the published Docker image. Use a build service only if Northflank is linked to GitHub and should build this repository directly.

Source repository:

```text
https://github.com/zhizhishu/cloudspace
```

Published container image:

```text
ghcr.io/zhizhishu/cloudspace:latest
```

## Hugging Face Spaces

Create a Docker Space and push this repository to it, or use a minimal Space repository that points at the published GHCR image. Hugging Face reads the Space configuration from the YAML block at the top of this README:

```yaml
sdk: docker
app_port: 7860
```

Keep the same Supabase environment variables in Space secrets if you want CloudSpace server-side state to restore after restarts. Free Spaces have more memory than the current Northflank free container, but their default runtime disk is still ephemeral.

When updating the Space manually, make sure the target is `Echocq/cloudspace`. Older local remotes or browser tabs may still point at previous test Spaces and should not be reused for deployment.
