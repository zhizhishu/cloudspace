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

## Environment variables

| Name | Default |
| --- | --- |
| `SUB_STORE_BACKEND_API_HOST` | `0.0.0.0` |
| `SUB_STORE_BACKEND_API_PORT` | `$PORT` or `3000` |
| `SUB_STORE_BACKEND_MERGE` | `true` |
| `SUB_STORE_FRONTEND_BACKEND_PATH` | `/2cXaAxRGfddmGz2yx1wA` |
| `SUB_STORE_FRONTEND_PATH` | `/opt/app/frontend` |
| `SUB_STORE_DATA_BASE_PATH` | `/opt/app/data` |

## Local build

```bash
docker build -t sub-store .
docker run --rm -p 3000:3000 sub-store
```

Open `http://localhost:3000/`.

## Northflank

Use a deployment service when deploying a published Docker image. Use a build service only if Northflank is linked to GitHub and should build this repository directly.

The intended source repository is:

```text
https://github.com/zhizhishu/sub-store
```

If a container image is published from this repository, the expected image name is:

```text
ghcr.io/zhizhishu/sub-store:latest
```
