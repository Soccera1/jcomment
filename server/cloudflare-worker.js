import { createCommentHandler, json } from "./core.mjs";
import { createD1Store } from "./cloudflare-d1.js";

let cachedHandler;
let cachedDb;
let cachedConfigKey;
const bindingIds = new WeakMap();
let nextBindingId = 1;

export default {
  async fetch(request, env) {
    if (!validRequestMetadata(request)) {
      return json({ error: "Request metadata is too large" }, { status: 400 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/comments" || url.pathname.startsWith("/api/comments/")) {
      if (!validApiPath(url.pathname)) {
        return json({ error: "Not found" }, { status: 404 });
      }
      if (!methodAllowedForApiPath(request.method, url.pathname)) {
        return json({ error: "Method not allowed" }, { status: 405, allow: "GET, POST, PATCH, OPTIONS" });
      }
      if (!env.JCOMMENT_DB) {
        return json({ error: "Bind a Cloudflare D1 database as JCOMMENT_DB before using the Worker adapter." }, { status: 500 });
      }
      let handleComments;
      let publicOrigin = "";
      try {
        validateWorkerEnvMetadata(env);
        const sessionCookie = sessionCookieConfig(env);
        publicOrigin = workerPublicOrigin(env);
        validateFixedSiteOrigin(env, sessionCookie, publicOrigin);
        if (publicOrigin && !publicOriginMatchesRequest(request, publicOrigin)) {
          return json({ error: "Bad Request" }, { status: 400 });
        }
        const configKey = workerConfigKey(env, url.hostname, publicOrigin);
        if (!cachedHandler || cachedDb !== env.JCOMMENT_DB || cachedConfigKey !== configKey) {
          const loginEnabled = envFlag(env, "JCOMMENT_LOGIN_ENABLED", true);
          const requireLoginToPost = envFlag(env, "JCOMMENT_REQUIRE_LOGIN_TO_POST", false);
          const votingEnabled = envFlag(env, "JCOMMENT_VOTING_ENABLED", true);
          const discloseAccountExistence = envFlag(env, "JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE", false);
          const ipStorageEnabled = envFlag(env, "JCOMMENT_IP_STORAGE_ENABLED", false);
          const rateLimitEnabled = envFlag(env, "JCOMMENT_RATE_LIMIT_ENABLED", true);
          const emailMode = envChoice(env, "JCOMMENT_EMAIL_MODE", "none", ["none", "optional", "required"]);
          const hashers = passwordHashers(env);
          const reset = passwordResetConfig(env);
          const nextHandler = createCommentHandler({
            store: createD1Store({
              db: env.JCOMMENT_DB,
              hashPassword: hashers.hashPassword,
              verifyPassword: hashers.verifyPassword
            }),
            site: env.JCOMMENT_SITE || url.hostname,
            brokenConfig: envFlag(env, "BROKEN_CONFIG", false),
            posting: {
              requireLogin: requireLoginToPost
            },
            voteIdentity: {
              maxVotesPerIdentity: envPositiveInteger(env, "JCOMMENT_MAX_VOTES_PER_IDENTITY", 1),
              voting: {
                enabled: votingEnabled
              },
              login: {
                enabled: loginEnabled
              },
              accounts: {
                email: emailMode,
                session: {
                  ttlMs: envPositiveInteger(env, "JCOMMENT_SESSION_TTL_MS", 30 * 24 * 60 * 60 * 1000)
                },
                passwordReset: {
                  enabled: reset.enabled,
                  ttlMs: envPositiveInteger(env, "JCOMMENT_PASSWORD_RESET_TTL_MS", 3600_000),
                  onToken: reset.onToken
	                },
	                discloseAccountExistence,
	                reservedUsernames: splitRanges(env.JCOMMENT_RESERVED_USERNAMES || "admin,administrator,moderator,mod,staff,system,anonymous,jcomment")
	              },
              ipStorage: {
                enabled: ipStorageEnabled,
                allowRanges: splitRanges(env.JCOMMENT_IP_ALLOW_RANGES),
                denyRanges: splitRanges(env.JCOMMENT_IP_DENY_RANGES)
              }
            },
            security: {
              sessionCookie,
              rateLimit: {
                enabled: rateLimitEnabled,
                windowMs: envPositiveInteger(env, "JCOMMENT_RATE_LIMIT_WINDOW_MS", 60_000),
                limits: {
                  postSite: envPositiveInteger(env, "JCOMMENT_RATE_LIMIT_POST_SITE", 60)
                }
              },
              quotas: {
                maxCommentsPerThread: envPositiveInteger(env, "JCOMMENT_MAX_COMMENTS_PER_THREAD", 512),
                maxCommentsPerSite: envPositiveInteger(env, "JCOMMENT_MAX_COMMENTS_PER_SITE", 5000)
              }
            },
            getClientIp: request => request.headers.get("cf-connecting-ip") || ""
          });
          cachedDb = env.JCOMMENT_DB;
          cachedConfigKey = configKey;
          cachedHandler = nextHandler;
        }
        handleComments = cachedHandler;
      } catch (error) {
        console.error(error);
        return json({ error: "Internal Server Error" }, { status: 500 });
      }
      return handleComments(canonicalRequest(request, publicOrigin));
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return json({ error: "Not found" }, { status: 404 });
  }
};

function validApiPath(pathname) {
  return pathname === "/api/comments" ||
    pathname === "/api/comments/signup" ||
    pathname === "/api/comments/login" ||
    pathname === "/api/comments/reset/request" ||
    pathname === "/api/comments/reset/confirm";
}

function methodAllowedForApiPath(method, pathname) {
  if (method === "OPTIONS") return true;
  if (pathname === "/api/comments") return method === "GET" || method === "POST" || method === "PATCH";
  return method === "POST";
}

function validRequestMetadata(request, maxBytes = 8192) {
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

function utf8Size(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function splitRanges(value) {
  return String(value || "").split(",").map(range => range.trim()).filter(Boolean);
}

function validateWorkerEnvMetadata(env, maxBytes = 8192) {
  for (const key of [
    "BROKEN_CONFIG",
    "JCOMMENT_PUBLIC_ORIGIN",
    "JCOMMENT_SITE",
    "JCOMMENT_REQUIRE_LOGIN_TO_POST",
    "JCOMMENT_MAX_VOTES_PER_IDENTITY",
    "JCOMMENT_VOTING_ENABLED",
    "JCOMMENT_LOGIN_ENABLED",
    "JCOMMENT_EMAIL_MODE",
    "JCOMMENT_SESSION_TTL_MS",
    "JCOMMENT_PASSWORD_RESET_ENABLED",
    "JCOMMENT_PASSWORD_RESET_TTL_MS",
    "JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE",
    "JCOMMENT_RESERVED_USERNAMES",
    "JCOMMENT_IP_STORAGE_ENABLED",
    "JCOMMENT_IP_ALLOW_RANGES",
    "JCOMMENT_IP_DENY_RANGES",
    "JCOMMENT_SESSION_COOKIE_ENABLED",
    "JCOMMENT_SESSION_COOKIE_NAME",
    "JCOMMENT_SESSION_COOKIE_SAMESITE",
    "JCOMMENT_SESSION_COOKIE_SECURE",
    "JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN",
    "JCOMMENT_RATE_LIMIT_ENABLED",
    "JCOMMENT_RATE_LIMIT_WINDOW_MS",
    "JCOMMENT_RATE_LIMIT_POST_SITE",
    "JCOMMENT_MAX_COMMENTS_PER_THREAD",
    "JCOMMENT_MAX_COMMENTS_PER_SITE"
  ]) {
    if (env[key] !== undefined && utf8Size(env[key]) > maxBytes) {
      throw new Error(`${key} must not exceed ${maxBytes} bytes.`);
    }
  }
}

function workerConfigKey(env, hostname, publicOrigin = "") {
  return JSON.stringify({
    publicOrigin,
    site: env.JCOMMENT_SITE || hostname,
    broken: env.BROKEN_CONFIG,
    requireLoginToPost: env.JCOMMENT_REQUIRE_LOGIN_TO_POST,
    maxVotes: env.JCOMMENT_MAX_VOTES_PER_IDENTITY,
    voting: env.JCOMMENT_VOTING_ENABLED,
    login: env.JCOMMENT_LOGIN_ENABLED,
    email: env.JCOMMENT_EMAIL_MODE,
    argon2id: bindingKey(env.JCOMMENT_ARGON2ID),
    sessionTtl: env.JCOMMENT_SESSION_TTL_MS,
    reset: env.JCOMMENT_PASSWORD_RESET_ENABLED,
    resetDelivery: bindingKey(env.JCOMMENT_PASSWORD_RESET),
    resetTtl: env.JCOMMENT_PASSWORD_RESET_TTL_MS,
	    discloseAccounts: env.JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE,
	    reservedUsernames: env.JCOMMENT_RESERVED_USERNAMES,
    ipStorage: env.JCOMMENT_IP_STORAGE_ENABLED,
    ipAllow: env.JCOMMENT_IP_ALLOW_RANGES,
    ipDeny: env.JCOMMENT_IP_DENY_RANGES,
    sessionCookie: env.JCOMMENT_SESSION_COOKIE_ENABLED,
    sessionCookieName: env.JCOMMENT_SESSION_COOKIE_NAME,
    sessionCookieSameSite: env.JCOMMENT_SESSION_COOKIE_SAMESITE,
    sessionCookieSecure: env.JCOMMENT_SESSION_COOKIE_SECURE,
    sessionCookieExpose: env.JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN,
    rateLimit: env.JCOMMENT_RATE_LIMIT_ENABLED,
    rateWindow: env.JCOMMENT_RATE_LIMIT_WINDOW_MS,
    ratePostSite: env.JCOMMENT_RATE_LIMIT_POST_SITE,
    maxThreadComments: env.JCOMMENT_MAX_COMMENTS_PER_THREAD,
    maxSiteComments: env.JCOMMENT_MAX_COMMENTS_PER_SITE,
  });
}

function workerPublicOrigin(env) {
  if (!env.JCOMMENT_PUBLIC_ORIGIN) return "";
  const publicOrigin = normalizeOrigin(env.JCOMMENT_PUBLIC_ORIGIN);
  if (!publicOrigin) {
    throw new Error("JCOMMENT_PUBLIC_ORIGIN must be an absolute http(s) origin.");
  }
  return publicOrigin;
}

function validateFixedSiteOrigin(env, sessionCookie, publicOrigin) {
  if (!env.JCOMMENT_SITE || !allowsSessionCookies(sessionCookie) || publicOrigin) return;
  if (!validSiteName(env.JCOMMENT_SITE)) {
    throw new Error("site must not contain control characters, surrounding whitespace, or exceed 120 bytes.");
  }
  throw new Error("JCOMMENT_PUBLIC_ORIGIN is required when JCOMMENT_SITE is set and session cookies are enabled or auto-enabled.");
}

function canonicalRequest(request, publicOrigin) {
  if (!publicOrigin) return request;
  const url = new URL(request.url);
  return new Request(new URL(`${url.pathname}${url.search}`, publicOrigin), request);
}

function publicOriginMatchesRequest(request, publicOrigin) {
  return new URL(request.url).origin === publicOrigin;
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.origin !== value) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function validSiteName(value) {
  const text = String(value || "");
  return text !== "" && !/\p{C}/u.test(text) && text === text.trim() && utf8Size(text) <= 120;
}

function allowsSessionCookies(config = {}) {
  return config.enabled !== false;
}

function bindingKey(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return "";
  if (!bindingIds.has(value)) {
    bindingIds.set(value, nextBindingId);
    nextBindingId += 1;
  }
  return bindingIds.get(value);
}

function passwordResetConfig(env) {
  const enabled = envFlag(env, "JCOMMENT_PASSWORD_RESET_ENABLED", false);
  if (!enabled) return { enabled: false };
  const delivery = env.JCOMMENT_PASSWORD_RESET;
  if (typeof delivery?.sendToken !== "function") {
    throw new Error("Cloudflare password reset requires a JCOMMENT_PASSWORD_RESET service binding with sendToken({ site, username, email, token }).");
  }
  return {
    enabled: true,
    onToken: payload => delivery.sendToken(payload)
  };
}

function envFlag(env, key, fallback) {
  if (env[key] === undefined) return fallback;
  const value = envBool(env[key]);
  if (value === undefined) {
    throw new Error(`${key} must be 1, true, on, yes, 0, false, off, or no.`);
  }
  return value;
}

function envPositiveInteger(env, key, fallback) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const text = String(env[key]);
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`${key} must be a positive integer.`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
}

function envChoice(env, key, fallback, choices) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const value = String(env[key]);
  if (!choices.includes(value)) {
    throw new Error(`${key} must be one of: ${choices.join(", ")}.`);
  }
  return value;
}

function sessionCookieConfig(env) {
  const enabled = env.JCOMMENT_SESSION_COOKIE_ENABLED === undefined
    ? "auto"
    : envBool(env.JCOMMENT_SESSION_COOKIE_ENABLED, { allowAuto: true });
  if (enabled === undefined) {
    throw new Error("JCOMMENT_SESSION_COOKIE_ENABLED must be auto, 1, true, on, yes, 0, false, off, or no.");
  }
  const secure = env.JCOMMENT_SESSION_COOKIE_SECURE === undefined
    ? true
    : envBool(env.JCOMMENT_SESSION_COOKIE_SECURE);
  if (secure === undefined) {
    throw new Error("JCOMMENT_SESSION_COOKIE_SECURE must be 1, true, on, yes, 0, false, off, or no.");
  }
  const exposeToken = env.JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN === undefined
    ? false
    : envBool(env.JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN);
  if (exposeToken === undefined) {
    throw new Error("JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN must be 1, true, on, yes, 0, false, off, or no.");
  }
  const name = env.JCOMMENT_SESSION_COOKIE_NAME || "jcomment_session";
  if (!validCookieName(name)) {
    throw new Error("JCOMMENT_SESSION_COOKIE_NAME must be a valid cookie name.");
  }
  const sameSite = env.JCOMMENT_SESSION_COOKIE_SAMESITE || "Lax";
  if (!["Strict", "Lax", "None"].includes(sameSite)) {
    throw new Error("JCOMMENT_SESSION_COOKIE_SAMESITE must be Strict, Lax, or None.");
  }
  if (enabled && exposeToken) {
    throw new Error("JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN is not supported when session cookies are enabled.");
  }
  if (enabled && sameSite === "None" && !secure) {
    throw new Error("JCOMMENT_SESSION_COOKIE_SAMESITE=None requires JCOMMENT_SESSION_COOKIE_SECURE=1.");
  }
  return {
    enabled,
    name,
    sameSite,
    secure,
    exposeToken
  };
}

function validCookieName(value) {
  const text = String(value || "");
  return utf8Size(text) <= 256 && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(text);
}

function envBool(value, { allowAuto = false } = {}) {
  const text = String(value || "").toLowerCase();
  if (allowAuto && text === "auto") return "auto";
  if (text === "1" || text === "true" || text === "on" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "off" || text === "no") return false;
  return undefined;
}

function passwordHashers(env) {
  const argon2id = env.JCOMMENT_ARGON2ID;
  if (argon2id?.hashPassword && argon2id?.verifyPassword) {
    return {
      hashPassword: argon2id.hashPassword.bind(argon2id),
      verifyPassword: argon2id.verifyPassword.bind(argon2id)
    };
  }
  return {
    hashPassword: undefined,
    verifyPassword: undefined
  };
}
