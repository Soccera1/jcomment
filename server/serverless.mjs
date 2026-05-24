export function serverlessConfig(name, env = process.env) {
  if (env.JCOMMENT_DB !== undefined && utf8Size(env.JCOMMENT_DB) > 4096) {
    return { error: `${name} adapter JCOMMENT_DB must not exceed 4096 bytes`, publicOrigin: "", sessionCookie: {}, site: "default" };
  }
  const oversized = oversizedEnvKey(env, [
    "JCOMMENT_PUBLIC_ORIGIN",
    "JCOMMENT_SITE",
    "JCOMMENT_SESSION_COOKIE_ENABLED",
    "JCOMMENT_SESSION_COOKIE_NAME",
    "JCOMMENT_SESSION_COOKIE_SAMESITE",
    "JCOMMENT_SESSION_COOKIE_SECURE",
    "JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN"
  ]);
  if (oversized) {
    return { error: `${name} adapter ${oversized} must not exceed 8192 bytes`, publicOrigin: "", sessionCookie: {}, site: "default" };
  }
  const publicOrigin = normalizeOrigin(env.JCOMMENT_PUBLIC_ORIGIN || "");
  if (env.JCOMMENT_PUBLIC_ORIGIN && !publicOrigin) {
    return { error: `${name} adapter JCOMMENT_PUBLIC_ORIGIN must be an absolute http(s) origin`, publicOrigin: "", sessionCookie: {}, site: "default" };
  }
  const site = normalizeSiteName(env.JCOMMENT_SITE || "default");
  if (!site) {
    return { error: `${name} adapter JCOMMENT_SITE must not contain control characters, surrounding whitespace, or exceed 120 bytes`, publicOrigin: "", sessionCookie: {}, site: "default" };
  }
  const { config: sessionCookie, error: cookieError } = sessionCookieFromEnv(env);
  if (cookieError) {
    return { error: `${name} adapter ${cookieError}`, publicOrigin: "", sessionCookie: {}, site };
  }
  if (allowsSessionCookies(sessionCookie) && sessionCookie.exposeToken) {
    return { error: `${name} adapter JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN is not supported when session cookies are enabled`, publicOrigin: "", sessionCookie, site };
  }
  if (allowsSessionCookies(sessionCookie) && sessionCookie.sameSite === "None" && sessionCookie.secure === false) {
    return { error: `${name} adapter JCOMMENT_SESSION_COOKIE_SAMESITE=None requires JCOMMENT_SESSION_COOKIE_SECURE=1`, publicOrigin: "", sessionCookie, site };
  }
  if (allowsSessionCookies(sessionCookie) && !publicOrigin) {
    return { error: `${name} adapter requires JCOMMENT_PUBLIC_ORIGIN when session cookies are enabled or auto-enabled`, publicOrigin: "", sessionCookie, site };
  }
  return { error: "", publicOrigin, sessionCookie, site };
}

export function canonicalRequest(request, publicOrigin) {
  if (!publicOrigin) return request;
  const url = new URL(request.url);
  return new Request(new URL(`${url.pathname}${url.search}`, publicOrigin), request);
}

export function publicOriginMatchesRequest(request, publicOrigin) {
  if (!publicOrigin) return true;
  return new URL(request.url).origin === publicOrigin;
}

export function validServerlessRequestMetadata(request, maxBytes = 8192) {
  let total = utf8Size(request.url);
  if (total > maxBytes) return false;
  for (const [name, value] of request.headers) {
    const size = utf8Size(name) + utf8Size(value);
    if (size > maxBytes) return false;
    total += size;
    if (total > maxBytes) return false;
  }
  return true;
}

export function validServerlessApiPath(request) {
  const pathname = new URL(request.url).pathname;
  return pathname === "/api/comments" ||
    pathname === "/api/comments/signup" ||
    pathname === "/api/comments/login" ||
    pathname === "/api/comments/reset/request" ||
    pathname === "/api/comments/reset/confirm";
}

export function methodAllowedForServerlessApiPath(request) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (method === "OPTIONS") return true;
  if (pathname === "/api/comments") return method === "GET" || method === "POST" || method === "PATCH";
  return method === "POST";
}

function sessionCookieFromEnv(env) {
  const config = {};
  if (env.JCOMMENT_SESSION_COOKIE_ENABLED !== undefined) {
    const enabled = envBool(env.JCOMMENT_SESSION_COOKIE_ENABLED, { allowAuto: true });
    if (enabled === undefined) return { config: {}, error: "JCOMMENT_SESSION_COOKIE_ENABLED must be auto, 1, true, on, yes, 0, false, off, or no" };
    config.enabled = enabled;
  }
  if (env.JCOMMENT_SESSION_COOKIE_NAME) {
    if (!validCookieName(env.JCOMMENT_SESSION_COOKIE_NAME)) return { config: {}, error: "JCOMMENT_SESSION_COOKIE_NAME must be a valid cookie name" };
    config.name = env.JCOMMENT_SESSION_COOKIE_NAME;
  }
  if (env.JCOMMENT_SESSION_COOKIE_SAMESITE) {
    if (!["Strict", "Lax", "None"].includes(env.JCOMMENT_SESSION_COOKIE_SAMESITE)) return { config: {}, error: "JCOMMENT_SESSION_COOKIE_SAMESITE must be Strict, Lax, or None" };
    config.sameSite = env.JCOMMENT_SESSION_COOKIE_SAMESITE;
  }
  if (env.JCOMMENT_SESSION_COOKIE_SECURE !== undefined) {
    const secure = envBool(env.JCOMMENT_SESSION_COOKIE_SECURE);
    if (secure === undefined) return { config: {}, error: "JCOMMENT_SESSION_COOKIE_SECURE must be 1, true, on, yes, 0, false, off, or no" };
    config.secure = secure;
  }
  if (env.JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN !== undefined) {
    const exposeToken = envBool(env.JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN);
    if (exposeToken === undefined) return { config: {}, error: "JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN must be 1, true, on, yes, 0, false, off, or no" };
    config.exposeToken = exposeToken;
  }
  return { config, error: "" };
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

function normalizeSiteName(value) {
  const text = String(value || "");
  if (/\p{C}/u.test(text)) return "";
  if (text !== text.trim() || new TextEncoder().encode(text).length > 120) return "";
  return text || "default";
}

function allowsSessionCookies(config = {}) {
  return config.enabled !== false;
}

function validCookieName(value) {
  const text = String(value || "");
  return utf8Size(text) <= 256 && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(text);
}

function oversizedEnvKey(env, keys, maxBytes = 8192) {
  for (const key of keys) {
    if (env[key] !== undefined && utf8Size(env[key]) > maxBytes) return key;
  }
  return "";
}

function utf8Size(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function envBool(value, { allowAuto = false } = {}) {
  const text = String(value || "").toLowerCase();
  if (allowAuto && text === "auto") return "auto";
  if (text === "1" || text === "true" || text === "on" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "off" || text === "no") return false;
  return undefined;
}
