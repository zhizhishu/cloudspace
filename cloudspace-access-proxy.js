const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { URLSearchParams } = require("url");

const productName = process.env.CLOUDSPACE_PRODUCT_NAME || "CloudSpace";
const enabled = process.env.ACCESS_LOCK_ENABLED !== "false";
const listenPort = Number(process.env.ACCESS_LOCK_PORT || process.env.PORT || 3000);
const upstreamHost = process.env.ACCESS_LOCK_UPSTREAM_HOST || process.env.CLOUDSPACE_UPSTREAM_HOST || "127.0.0.1";
const upstreamPort = Number(process.env.ACCESS_LOCK_UPSTREAM_PORT || process.env.CLOUDSPACE_BACKEND_API_PORT || 3001);
const dataPath = process.env.ACCESS_LOCK_DATA_PATH || path.join(process.env.CLOUDSPACE_DATA_BASE_PATH || "/opt/app/data", "cloudspace-access.json");
const cookieName = process.env.ACCESS_LOCK_COOKIE_NAME || "cloudspace_access";
const initialPassword = process.env.ACCESS_LOCK_INITIAL_PASSWORD || process.env.ACCESS_LOCK_PASSWORD || "";
const backendPath = normalizeBackendPath(process.env.CLOUDSPACE_BACKEND_PATH || process.env.SUB_STORE_FRONTEND_BACKEND_PATH || "/2cXaAxRGfddmGz2yx1wA");
const upstreamTimeoutMs = positiveNumber(
  process.env.ACCESS_LOCK_UPSTREAM_TIMEOUT_MS || process.env.CLOUDSPACE_UPSTREAM_TIMEOUT_MS,
  300000
);
const requestTimeoutMs = positiveNumber(
  process.env.ACCESS_LOCK_REQUEST_TIMEOUT_MS || process.env.CLOUDSPACE_REQUEST_TIMEOUT_MS,
  upstreamTimeoutMs + 30000
);
const maxFrontendTransformBytes = positiveNumber(
  process.env.ACCESS_LOCK_MAX_FRONTEND_TRANSFORM_BYTES || process.env.CLOUDSPACE_MAX_FRONTEND_TRANSFORM_BYTES,
  2097152
);
const frontendCacheControl = process.env.ACCESS_LOCK_FRONTEND_CACHE_CONTROL || process.env.CLOUDSPACE_FRONTEND_CACHE_CONTROL || "no-store";
const apiCacheControl = process.env.ACCESS_LOCK_API_CACHE_CONTROL || process.env.CLOUDSPACE_API_CACHE_CONTROL || "no-store";
const cloudspaceConfigPath = process.env.CLOUDSPACE_CONFIG_PATH || "/__cloudspace/config.json";
const cloudspaceHealthPath = process.env.CLOUDSPACE_HEALTH_PATH || "/__cloudspace/health";
const apiMaxConcurrent = positiveNumber(process.env.CLOUDSPACE_API_MAX_CONCURRENT || process.env.ACCESS_LOCK_API_MAX_CONCURRENT, 4);
const apiMaxBodyBytes = positiveNumber(process.env.CLOUDSPACE_API_MAX_BODY_BYTES || process.env.ACCESS_LOCK_API_MAX_BODY_BYTES, 8 * 1024 * 1024);
const httpMetaEnabled = process.env.HTTP_META_ENABLED !== "false";
const httpMetaHost = process.env.HTTP_META_HOST || "127.0.0.1";
const httpMetaPort = Number(process.env.HTTP_META_PORT || 9876);
const healthTimeoutMs = positiveNumber(process.env.CLOUDSPACE_HEALTH_TIMEOUT_MS, 2500);
const healthCacheMs = positiveNumber(process.env.CLOUDSPACE_HEALTH_CACHE_MS, 10000);
let activeApiRequests = 0;
let cachedHealth = null;
let cachedHealthAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBackendPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function randomPassword() {
  return crypto.randomBytes(15).toString("base64url");
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("base64url");
}

function initialPasswordFingerprint(password) {
  if (!password) return "";
  return crypto.createHash("sha256").update(`cloudspace-access-initial-password:${password}`).digest("base64url");
}

function sign(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function makeConfig(password, existing = {}, options = {}) {
  const passwordSalt = crypto.randomBytes(16).toString("base64url");
  return {
    version: 1,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
    passwordSalt,
    passwordHash: hashPassword(password, passwordSalt),
    sessionSecret: crypto.randomBytes(32).toString("base64url"),
    initialPasswordFingerprint: options.initialPasswordFingerprint || existing.initialPasswordFingerprint || ""
  };
}

function loadConfig() {
  const initialFingerprint = initialPasswordFingerprint(initialPassword);
  if (fs.existsSync(dataPath)) {
    const parsed = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    if (parsed && parsed.passwordHash && parsed.passwordSalt && parsed.sessionSecret) {
      if (initialPassword && parsed.initialPasswordFingerprint !== initialFingerprint) {
        const updated = makeConfig(initialPassword, parsed, { initialPasswordFingerprint: initialFingerprint });
        atomicWriteJson(dataPath, updated);
        console.log("[CLOUDSPACE ACCESS] Password reset from updated ACCESS_LOCK_INITIAL_PASSWORD.");
        return updated;
      }
      return parsed;
    }
  }

  const password = initialPassword || randomPassword();
  const config = makeConfig(password, {}, { initialPasswordFingerprint: initialFingerprint });
  atomicWriteJson(dataPath, config);

  if (initialPassword) {
    console.log("[CLOUDSPACE ACCESS] Initial password loaded from ACCESS_LOCK_INITIAL_PASSWORD.");
  } else {
    console.log(`[CLOUDSPACE ACCESS] Generated initial password: ${password}`);
    console.log("[CLOUDSPACE ACCESS] Change it from /__lock after logging in.");
  }

  return config;
}

let config = enabled ? loadConfig() : null;

function verifyPassword(password) {
  if (!config) return true;
  return safeEqual(hashPassword(password, config.passwordSalt), config.passwordHash);
}

function makeToken() {
  const payload = "access";
  return `${payload}.${sign(config.sessionSecret, payload)}`;
}

function verifyToken(token) {
  if (!config || !token) return false;
  const [payload, signature] = String(token).split(".");
  if (payload !== "access" || !signature) return false;
  return safeEqual(sign(config.sessionSecret, payload), signature);
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  if (!enabled) return true;
  return verifyToken(parseCookies(req)[cookieName]);
}

function cookieOptions(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
  const secure = forwardedProto === "https" || req.socket.encrypted || forwardedHost.endsWith(".hf.space");
  const configuredSameSite = String(process.env.ACCESS_LOCK_COOKIE_SAMESITE || "").trim().toLowerCase();
  const sameSite = configuredSameSite || (secure ? "none" : "lax");
  const normalizedSameSite = sameSite === "none" ? "None" : sameSite === "strict" ? "Strict" : "Lax";
  return `Path=/; HttpOnly; SameSite=${normalizedSameSite}${secure || normalizedSameSite === "None" ? "; Secure" : ""}`;
}

function setAuthCookie(res, req) {
  res.setHeader("Set-Cookie", `${cookieName}=${encodeURIComponent(makeToken())}; ${cookieOptions(req)}`);
}

function clearAuthCookie(res, req) {
  res.setHeader("Set-Cookie", `${cookieName}=; Max-Age=0; ${cookieOptions(req)}`);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

function htmlPage(req, message = "") {
  const loggedIn = isAuthenticated(req);
  const next = new URL(req.url, "http://local").searchParams.get("next") || "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(productName)} Access</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101820; color: #eef4f8; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid rgba(255,255,255,.16); border-radius: 8px; padding: 24px; background: #17232d; box-shadow: 0 16px 50px rgba(0,0,0,.28); }
    h1 { margin: 0 0 16px; font-size: 22px; font-weight: 650; letter-spacing: 0; }
    p { margin: 0 0 16px; color: #b9c7d1; line-height: 1.5; }
    form { display: grid; gap: 12px; margin: 16px 0 0; }
    label { display: grid; gap: 6px; color: #d8e2e9; font-size: 14px; }
    input { min-height: 40px; border-radius: 6px; border: 1px solid rgba(255,255,255,.18); background: #0d141b; color: #fff; padding: 0 12px; font-size: 16px; }
    button, a.button { min-height: 40px; border: 0; border-radius: 6px; padding: 0 14px; background: #48c6a8; color: #08110f; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-grid; place-items: center; }
    .secondary { background: #243543; color: #eef4f8; }
    .message { padding: 10px 12px; border-radius: 6px; background: rgba(72,198,168,.14); color: #b9ffe8; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    hr { border: 0; border-top: 1px solid rgba(255,255,255,.14); margin: 22px 0; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(productName)} Access</h1>
    ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
    ${loggedIn ? `
      <p>Access is unlocked. You can open ${escapeHtml(productName)} or change the access password here.</p>
      <div class="row">
        <a class="button" href="/">Open ${escapeHtml(productName)}</a>
        <form method="post" action="/__lock/logout"><button class="secondary" type="submit">Sign out</button></form>
      </div>
      <hr>
      <form method="post" action="/__lock/password">
        <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
        <label>New password<input name="newPassword" type="password" autocomplete="new-password" minlength="8" required></label>
        <label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required></label>
        <button type="submit">Update password</button>
      </form>
    ` : `
      <p>Enter the access password to continue.</p>
      <form method="post" action="/__lock/login">
        <input type="hidden" name="next" value="${escapeHtml(safeNext)}">
        <label>Access password<input name="password" type="password" autocomplete="current-password" autofocus required></label>
        <button type="submit">Unlock</button>
      </form>
    `}
  </main>
</body>
</html>`;
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function redirect(res, location) {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

function readForm(req, callback) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 65536) req.destroy();
  });
  req.on("end", () => callback(new URLSearchParams(body)));
}

function handleLockRoute(req, res) {
  const url = new URL(req.url, "http://local");

  if (req.method === "GET" && (url.pathname === "/__lock" || url.pathname === "/__lock/")) {
    sendHtml(res, 200, htmlPage(req));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/__lock/login") {
    sendHtml(res, 200, htmlPage(req));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/__lock/status") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ authenticated: isAuthenticated(req), enabled }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/__lock/login") {
    readForm(req, (form) => {
      const next = form.get("next") || "/";
      if (!verifyPassword(form.get("password") || "")) {
        sendHtml(res, 401, htmlPage(req, "Password is incorrect."));
        return;
      }
      setAuthCookie(res, req);
      redirect(res, next.startsWith("/") && !next.startsWith("//") ? next : "/");
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/__lock/logout") {
    clearAuthCookie(res, req);
    redirect(res, "/__lock/login");
    return true;
  }

  if (req.method === "POST" && url.pathname === "/__lock/password") {
    if (!isAuthenticated(req)) {
      redirect(res, `/__lock/login?next=${encodeURIComponent("/__lock")}`);
      return true;
    }
    readForm(req, (form) => {
      const currentPassword = form.get("currentPassword") || "";
      const newPassword = form.get("newPassword") || "";
      const confirmPassword = form.get("confirmPassword") || "";
      if (!verifyPassword(currentPassword)) {
        sendHtml(res, 400, htmlPage(req, "Current password is incorrect."));
        return;
      }
      if (newPassword.length < 8) {
        sendHtml(res, 400, htmlPage(req, "New password must be at least 8 characters."));
        return;
      }
      if (newPassword !== confirmPassword) {
        sendHtml(res, 400, htmlPage(req, "New password confirmation does not match."));
        return;
      }
      const passwordSalt = crypto.randomBytes(16).toString("base64url");
      config = {
        ...config,
        updatedAt: nowIso(),
        passwordSalt,
        passwordHash: hashPassword(newPassword, passwordSalt),
        sessionSecret: crypto.randomBytes(32).toString("base64url")
      };
      atomicWriteJson(dataPath, config);
      setAuthCookie(res, req);
      sendHtml(res, 200, htmlPage(req, "Password updated."));
    });
    return true;
  }

  return false;
}

function wantsHtml(req) {
  const accept = req.headers.accept || "";
  return accept.includes("text/html") || accept.includes("*/*");
}

function unauthorized(req, res) {
  const url = new URL(req.url, "http://local");
  if (!isApiPath(url.pathname) && wantsHtml(req)) {
    redirect(res, `/__lock/login?next=${encodeURIComponent(req.url || "/")}`);
  } else {
    sendJson(res, 401, { error: "locked" });
  }
}

function cleanHeaders(headers) {
  const out = { ...headers };
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) {
    delete out[name];
  }
  out.host = `${upstreamHost}:${upstreamPort}`;
  return out;
}

function upstreamPath(rawPath) {
  if (backendPath && (rawPath === "/api" || rawPath.startsWith("/api/") || rawPath.startsWith("/api?"))) {
    return `${backendPath}${rawPath}`;
  }
  return rawPath;
}

function isApiPath(rawPath) {
  return rawPath === "/api" || rawPath.startsWith("/api/") || rawPath.startsWith("/api?");
}

function routeKind(req) {
  const url = new URL(req.url, "http://local");
  if (url.pathname.startsWith("/__lock")) return "lock";
  if (url.pathname.startsWith("/__cloudspace")) return "cloudspace";
  if (isApiPath(url.pathname)) return "api";
  return "frontend";
}

function cloudspaceConfig() {
  return {
    productName,
    backend: {
      apiBase: "/",
      backendPath,
      sameOrigin: true
    },
    routes: {
      lock: "/__lock",
      health: cloudspaceHealthPath,
      config: cloudspaceConfigPath,
      api: "/api"
    },
    httpMeta: {
      enabled: httpMetaEnabled,
      host: "127.0.0.1",
      port: httpMetaPort
    }
  };
}

function healthProbe(options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = http.request(options, (res) => {
      res.resume();
      res.on("end", () => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode, ms: Date.now() - startedAt });
      });
    });
    req.setTimeout(healthTimeoutMs, () => req.destroy(new Error(`timeout after ${healthTimeoutMs} ms`)));
    req.on("error", (error) => resolve({ ok: false, error: error.message, ms: Date.now() - startedAt }));
    req.end();
  });
}

async function buildHealth() {
  const now = Date.now();
  if (cachedHealth && now - cachedHealthAt < healthCacheMs) return cachedHealth;

  const [core, httpMeta] = await Promise.all([
    healthProbe({
      hostname: upstreamHost,
      port: upstreamPort,
      method: "GET",
      path: `${backendPath}/api/utils/env`
    }),
    httpMetaEnabled
      ? healthProbe({
          hostname: httpMetaHost,
          port: httpMetaPort,
          method: "GET",
          path: "/test"
        })
      : Promise.resolve({ ok: true, disabled: true })
  ]);

  const value = {
    productName,
    ok: Boolean(core.ok && httpMeta.ok),
    timestamp: nowIso(),
    gateway: {
      ok: true,
      routeModel: "single-container-layered-gateway",
      uptimeSeconds: Math.round(process.uptime())
    },
    access: {
      enabled,
      authenticatedSessions: "cookie"
    },
    api: {
      ok: core.ok,
      active: activeApiRequests,
      maxConcurrent: apiMaxConcurrent,
      maxBodyBytes: apiMaxBodyBytes,
      upstream: `${upstreamHost}:${upstreamPort}${backendPath}`,
      probe: core
    },
    httpMeta: {
      ok: httpMeta.ok,
      enabled: httpMetaEnabled,
      upstream: `${httpMetaHost}:${httpMetaPort}`,
      probe: httpMeta
    }
  };
  cachedHealth = value;
  cachedHealthAt = now;
  return value;
}

function handleCloudspaceRoute(req, res) {
  const url = new URL(req.url, "http://local");
  if (req.method === "GET" && url.pathname === cloudspaceConfigPath) {
    sendJson(res, 200, cloudspaceConfig());
    return true;
  }

  if (req.method === "GET" && url.pathname === cloudspaceHealthPath) {
    buildHealth()
      .then((health) => sendJson(res, health.ok ? 200 : 503, health))
      .catch((error) => sendJson(res, 503, { ok: false, error: error.message, timestamp: nowIso() }));
    return true;
  }

  return false;
}

function frontendBootstrapScript() {
  const apiName = `${productName} Local`;
  return `<script>
(() => {
  try {
    const desiredHostAPI = { current: ${JSON.stringify(apiName)}, apis: [{ name: ${JSON.stringify(apiName)}, url: "/" }] };
    const desiredHostAPIValue = JSON.stringify(desiredHostAPI);
    const syncCloudspaceBackend = () => {
      Storage.prototype.setItem.call(localStorage, "hostAPI", desiredHostAPIValue);
      Storage.prototype.setItem.call(localStorage, "backendConfigured", "true");
      Storage.prototype.setItem.call(localStorage, "magicPathConfigured", "true");
    };
    const shouldRewriteHostAPI = (value) => {
      try {
        const parsed = JSON.parse(value || "{}");
        if (!parsed.current || !Array.isArray(parsed.apis) || parsed.apis.length === 0) return true;
        return JSON.stringify(parsed).includes("sub.store");
      } catch (_) {
        return true;
      }
    };
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const originalClear = Storage.prototype.clear;
    Storage.prototype.setItem = function (key, value) {
      if (key === "hostAPI" && shouldRewriteHostAPI(value)) value = desiredHostAPIValue;
      return originalSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (this === localStorage && ["hostAPI", "backendConfigured", "magicPathConfigured"].includes(key)) {
        setTimeout(syncCloudspaceBackend, 0);
      }
      return originalRemoveItem.call(this, key);
    };
    Storage.prototype.clear = function () {
      const result = originalClear.call(this);
      if (this === localStorage) setTimeout(syncCloudspaceBackend, 0);
      return result;
    };
    syncCloudspaceBackend();
    window.addEventListener("storage", syncCloudspaceBackend);
    document.addEventListener("DOMContentLoaded", syncCloudspaceBackend);
    setInterval(() => {
      if (shouldRewriteHostAPI(localStorage.getItem("hostAPI")) || localStorage.getItem("backendConfigured") !== "true" || localStorage.getItem("magicPathConfigured") !== "true") {
        syncCloudspaceBackend();
      }
    }, 250);
    document.title = ${JSON.stringify(productName)};
  } catch (_) {}
})();
</script>`;
}

function applyCloudspaceBranding(body) {
  return body
    .replaceAll("Sub Store", productName)
    .replaceAll("Sub-Store", productName)
    .replaceAll("SubStore", productName)
    .replaceAll("sub-store", "cloudspace")
    .replaceAll("sub.store", "cloudspace.local");
}

function shouldTransformFrontendResponse(req, upstreamRes) {
  if (req.method !== "GET") return false;
  const status = upstreamRes.statusCode || 200;
  if (status < 200 || status >= 300) return false;
  const contentType = String(upstreamRes.headers["content-type"] || "");
  return contentType.includes("text/html") || contentType.includes("javascript");
}

function applyCacheHeaders(headers, cacheControl) {
  if (!cacheControl || cacheControl === "pass") return headers;
  headers["cache-control"] = cacheControl;
  if (cacheControl.includes("no-store")) {
    delete headers.etag;
    delete headers["last-modified"];
  }
  return headers;
}

function responseHeaders(req, upstreamRes, options = {}) {
  const headers = { ...upstreamRes.headers };
  if (options.dropContentLength) delete headers["content-length"];
  if (options.frontend) applyCacheHeaders(headers, frontendCacheControl);
  if (isApiPath(req.url)) applyCacheHeaders(headers, apiCacheControl);
  return headers;
}

function transformFrontendBody(req, upstreamRes, body) {
  const contentType = String(upstreamRes.headers["content-type"] || "");
  if (contentType.includes("text/html")) {
    const script = frontendBootstrapScript();
    body = applyCloudspaceBranding(body);
    if (body.includes("<head>")) {
      return body.replace("<head>", `<head>${script}`);
    }
    if (body.includes("</head>")) {
      return body.replace("</head>", `${script}</head>`);
    }
    return `${script}${body}`;
  }

  if (contentType.includes("javascript")) {
    return applyCloudspaceBranding(body).replaceAll("https://cloudspace.local", "");
  }

  return body;
}

function pipeTransformedFrontend(req, res, upstreamRes) {
  const chunks = [];
  let totalBytes = 0;
  let passthrough = false;
  upstreamRes.on("data", (chunk) => {
    if (passthrough) {
      res.write(chunk);
      return;
    }

    totalBytes += chunk.length;
    if (maxFrontendTransformBytes > 0 && totalBytes > maxFrontendTransformBytes) {
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders(req, upstreamRes, { frontend: true }));
      for (const buffered of chunks) res.write(buffered);
      chunks.length = 0;
      res.write(chunk);
      passthrough = true;
      return;
    }

    chunks.push(chunk);
  });
  upstreamRes.on("end", () => {
    if (passthrough) {
      res.end();
      return;
    }

    let body = Buffer.concat(chunks).toString("utf8");
    body = transformFrontendBody(req, upstreamRes, body);

    const headers = responseHeaders(req, upstreamRes, { frontend: true, dropContentLength: true });
    res.writeHead(upstreamRes.statusCode || 200, headers);
    res.end(body);
  });
}

function proxyHttp(req, res) {
  const kind = routeKind(req);
  if (kind === "api") {
    if (activeApiRequests >= apiMaxConcurrent) {
      sendJson(res, 429, {
        error: "busy",
        message: `${productName} is processing too many API requests; retry shortly.`,
        active: activeApiRequests,
        maxConcurrent: apiMaxConcurrent
      });
      return;
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (apiMaxBodyBytes > 0 && contentLength > apiMaxBodyBytes) {
      sendJson(res, 413, { error: "request_too_large", maxBodyBytes: apiMaxBodyBytes });
      return;
    }
    activeApiRequests += 1;
  }

  let released = false;
  const release = () => {
    if (!released && kind === "api") {
      activeApiRequests = Math.max(0, activeApiRequests - 1);
      released = true;
    }
  };

  const options = {
    hostname: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path: upstreamPath(req.url),
    headers: cleanHeaders(req.headers)
  };
  const upstreamReq = http.request(options, (upstreamRes) => {
    res.on("finish", release);
    res.on("close", release);
    if (shouldTransformFrontendResponse(req, upstreamRes)) {
      pipeTransformedFrontend(req, res, upstreamRes);
      return;
    }
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders(req, upstreamRes));
    upstreamRes.pipe(res);
  });
  upstreamReq.setTimeout(upstreamTimeoutMs, () => {
    upstreamReq.destroy(new Error(`upstream timeout after ${upstreamTimeoutMs} ms`));
  });
  upstreamReq.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const status = error.message.includes("upstream timeout") ? 504 : 502;
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(`Upstream unavailable: ${error.message}\n`);
    release();
  });

  let bodyBytes = 0;
  let bodyRejected = false;
  req.on("data", (chunk) => {
    if (bodyRejected) return;
    bodyBytes += chunk.length;
    if (kind === "api" && apiMaxBodyBytes > 0 && bodyBytes > apiMaxBodyBytes) {
      bodyRejected = true;
      upstreamReq.destroy(new Error("request body too large"));
      if (!res.headersSent) sendJson(res, 413, { error: "request_too_large", maxBodyBytes: apiMaxBodyBytes });
      req.destroy();
      release();
      return;
    }
    upstreamReq.write(chunk);
  });
  req.on("end", () => {
    if (!bodyRejected) upstreamReq.end();
  });
  req.on("error", (error) => {
    upstreamReq.destroy(error);
    release();
  });
}

const server = http.createServer((req, res) => {
  if (enabled && handleLockRoute(req, res)) return;
  if (handleCloudspaceRoute(req, res)) return;
  if (enabled && !isAuthenticated(req)) {
    unauthorized(req, res);
    return;
  }
  proxyHttp(req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (enabled && !isAuthenticated(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(req.headers)) {
      upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write("\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
});

server.listen(listenPort, "0.0.0.0", () => {
  console.log(`[CLOUDSPACE ACCESS] ${enabled ? "enabled" : "disabled"} on 0.0.0.0:${listenPort}, upstream ${upstreamHost}:${upstreamPort}`);
  console.log(`[CLOUDSPACE ACCESS] upstream timeout ${upstreamTimeoutMs} ms, request timeout ${requestTimeoutMs} ms`);
});

server.requestTimeout = requestTimeoutMs;
server.headersTimeout = Math.max(60000, requestTimeoutMs + 5000);
server.keepAliveTimeout = positiveNumber(process.env.ACCESS_LOCK_KEEP_ALIVE_TIMEOUT_MS, 5000);
