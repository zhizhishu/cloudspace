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

function nowIso() {
  return new Date().toISOString();
}

function randomPassword() {
  return crypto.randomBytes(15).toString("base64url");
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("base64url");
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

function makeConfig(password, existing = {}) {
  const passwordSalt = crypto.randomBytes(16).toString("base64url");
  return {
    version: 1,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
    passwordSalt,
    passwordHash: hashPassword(password, passwordSalt),
    sessionSecret: crypto.randomBytes(32).toString("base64url")
  };
}

function loadConfig() {
  if (fs.existsSync(dataPath)) {
    const parsed = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    if (parsed && parsed.passwordHash && parsed.passwordSalt && parsed.sessionSecret) {
      if (initialPassword && !safeEqual(hashPassword(initialPassword, parsed.passwordSalt), parsed.passwordHash)) {
        const updated = makeConfig(initialPassword, parsed);
        atomicWriteJson(dataPath, updated);
        console.log("[CLOUDSPACE ACCESS] Password synced from ACCESS_LOCK_INITIAL_PASSWORD.");
        return updated;
      }
      return parsed;
    }
  }

  const password = initialPassword || randomPassword();
  const config = makeConfig(password);
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
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
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
  if (wantsHtml(req)) {
    redirect(res, `/__lock/login?next=${encodeURIComponent(req.url || "/")}`);
  } else {
    res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "locked" }));
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

function proxyHttp(req, res) {
  const options = {
    hostname: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers: cleanHeaders(req.headers)
  };
  const upstreamReq = http.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstreamReq.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Upstream unavailable: ${error.message}\n`);
  });
  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  if (enabled && handleLockRoute(req, res)) return;
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
});
