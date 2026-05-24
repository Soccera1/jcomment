import { createCommentHandler, createSqliteStore, matchRoute, methodAllowedForRoute, normalizeRouteConfig } from "./core.mjs";

export function jcommentExpress({
  store = createSqliteStore(),
  cors = false,
  getClientIp,
  publicOrigin = process.env.JCOMMENT_PUBLIC_ORIGIN || "",
  allowedHosts = splitList(process.env.JCOMMENT_ALLOWED_HOSTS),
  ...options
} = {}) {
  const configuredOrigin = normalizeOrigin(publicOrigin);
  if (publicOrigin && !configuredOrigin) throw new Error("jcommentExpress publicOrigin must be an absolute http(s) origin");
  allowedHosts = normalizeAllowedHosts(allowedHosts);
  if (configuredOrigin && allowedHosts.length === 0) allowedHosts = [new URL(configuredOrigin).host.toLowerCase()];
  if (usesAutoSessionCookies(options.security?.sessionCookie) && !configuredOrigin) {
    throw new Error("jcommentExpress requires publicOrigin when session cookies are auto-enabled");
  }
  if (allowsSessionCookies(options.security?.sessionCookie) && allowedHosts.length === 0) {
    throw new Error("jcommentExpress requires publicOrigin or allowedHosts when session cookies are enabled or auto-enabled");
  }
  const routeConfig = normalizeRouteConfig(options.apiPath);
  const handleComments = createCommentHandler({
    ...options,
    store,
    cors,
    getClientIp: request => request.headers.get("x-jcomment-client-ip") || ""
  });

  return async function route(req, res, next) {
    try {
      const host = String(req.get("host") || "");
      if (allowedHosts.length > 0 && !allowedHosts.includes(host.toLowerCase())) {
        sendJsonError(res, 400, "Bad Request");
        return;
      }
      if (!validExpressRequestMetadata(req)) {
        sendJsonError(res, 400, "Request metadata is too large");
        return;
      }
      if (!validExpressMethod(req.method)) {
        sendJsonError(res, 405, "Method not allowed");
        return;
      }
      const origin = configuredOrigin || `${req.protocol}://${host}`;
      const requestUrl = canonicalRequestUrl(req.originalUrl || req.url, origin);
      if (!requestUrl) {
        sendJsonError(res, 400, "Bad Request");
        return;
      }
      const routeName = matchRoute(requestUrl.pathname, routeConfig);
      if (!routeName) {
        sendJsonError(res, 404, "Not found");
        return;
      }
      if (req.method !== "OPTIONS" && !methodAllowedForRoute(req.method, routeName)) {
        sendJsonError(res, 405, "Method not allowed");
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body || {});
      const headers = new Headers(req.headers);
      headers.set("x-jcomment-client-ip", getClientIp?.(req) || req.socket?.remoteAddress || "");
      if (body === undefined) {
        headers.delete("content-length");
      } else {
        headers.set("content-length", String(Buffer.byteLength(body)));
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
      const request = new Request(requestUrl, {
        method: req.method,
        headers,
        body,
        duplex: "half"
      });
      const response = await handleComments(request);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.send(response.status === 204 ? undefined : await response.text());
    } catch (error) {
      next(error);
    }
  };
}

function sendJsonError(res, status, error) {
  res.status(status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
  res.setHeader("x-content-type-options", "nosniff");
  res.send(JSON.stringify({ error }));
}

function validExpressMethod(method) {
  return method === "GET" || method === "HEAD" || method === "POST" || method === "PATCH" || method === "OPTIONS";
}

function validExpressRequestMetadata(req, maxBytes = 8192) {
  let total = utf8Size(req.originalUrl || req.url || "");
  if (total > maxBytes) return false;
  for (const [name, value] of Object.entries(req.headers || {})) {
    const nameSize = utf8Size(name);
    if (nameSize > maxBytes) return false;
    total += nameSize;
    if (total > maxBytes) return false;
    if (Array.isArray(value)) {
      for (const item of value) {
        const itemSize = utf8Size(item);
        if (itemSize > maxBytes) return false;
        total += itemSize;
        if (total > maxBytes) return false;
      }
    } else {
      const valueSize = utf8Size(value || "");
      if (valueSize > maxBytes) return false;
      total += valueSize;
      if (total > maxBytes) return false;
    }
  }
  return true;
}

function canonicalRequestUrl(value, origin) {
  const raw = String(value || "/");
  try {
    const url = new URL(raw, origin);
    if ((/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.startsWith("//")) && url.origin !== new URL(origin).origin) {
      return null;
    }
    return new URL(`${url.pathname}${url.search}`, origin);
  } catch {
    return null;
  }
}

function splitList(value) {
  return String(value || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
}

function normalizeAllowedHosts(value) {
  if (!Array.isArray(value)) throw new Error("jcommentExpress allowedHosts must be an array of host names");
  return value.map(item => {
    const host = String(item || "").trim().toLowerCase();
    if (!validHostName(host)) throw new Error("jcommentExpress allowedHosts must contain host names without schemes, paths, queries, or control characters");
    return host;
  });
}

function validHostName(value) {
  if (!value || /[\x00-\x1F\x7F/?#@]/.test(value)) return false;
  try {
    return new URL(`http://${value}/`).host === value;
  } catch {
    return false;
  }
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.origin !== value) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function utf8Size(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function allowsSessionCookies(config = {}) {
  return !isDisabledSessionCookie(config.enabled);
}

function usesAutoSessionCookies(config = {}) {
  const value = config.enabled;
  return value === undefined || value === null || value === "" || (typeof value === "string" && value.toLowerCase() === "auto");
}

function isDisabledSessionCookie(value) {
  return value === false || (typeof value === "string" && ["0", "false", "off", "no"].includes(value.toLowerCase()));
}
