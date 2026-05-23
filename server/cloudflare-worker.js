import { createCommentHandler, json } from "./core.mjs";
import { createD1Store } from "./cloudflare-d1.js";

let cachedHandler;
let cachedDb;
let cachedConfigKey;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/comments" || url.pathname.startsWith("/api/comments/")) {
      if (!env.JCOMMENT_DB) {
        return json({ error: "Bind a Cloudflare D1 database as JCOMMENT_DB before using the Worker adapter." }, { status: 500 });
      }
      const loginEnabled = env.JCOMMENT_LOGIN_ENABLED !== "0" && env.JCOMMENT_LOGIN_ENABLED !== "false";
      let handleComments;
      try {
        const configKey = workerConfigKey(env, url.hostname);
        if (!cachedHandler || cachedDb !== env.JCOMMENT_DB || cachedConfigKey !== configKey) {
          const hashers = passwordHashers(env);
          const reset = passwordResetConfig(env);
          cachedDb = env.JCOMMENT_DB;
          cachedConfigKey = configKey;
          cachedHandler = createCommentHandler({
            store: createD1Store({
              db: env.JCOMMENT_DB,
              hashPassword: hashers.hashPassword,
              verifyPassword: hashers.verifyPassword
            }),
            site: env.JCOMMENT_SITE || url.hostname,
            brokenConfig: env.BROKEN_CONFIG === "1" || env.BROKEN_CONFIG === "true",
            posting: {
              requireLogin: env.JCOMMENT_REQUIRE_LOGIN_TO_POST === "1" || env.JCOMMENT_REQUIRE_LOGIN_TO_POST === "true"
            },
            voteIdentity: {
              maxVotesPerIdentity: Number(env.JCOMMENT_MAX_VOTES_PER_IDENTITY || 1),
              voting: {
                enabled: env.JCOMMENT_VOTING_ENABLED !== "0" && env.JCOMMENT_VOTING_ENABLED !== "false"
              },
              login: {
                enabled: loginEnabled
              },
              accounts: {
                email: env.JCOMMENT_EMAIL_MODE || "none",
                session: {
                  ttlMs: Number(env.JCOMMENT_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000)
                },
                passwordReset: {
                  enabled: reset.enabled,
                  ttlMs: Number(env.JCOMMENT_PASSWORD_RESET_TTL_MS || 3600_000),
                  onToken: reset.onToken
	                },
	                discloseAccountExistence: env.JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE === "1" || env.JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE === "true",
	                reservedUsernames: splitRanges(env.JCOMMENT_RESERVED_USERNAMES || "admin,administrator,moderator,mod,staff,system,anonymous,jcomment")
	              },
              ipStorage: {
                enabled: env.JCOMMENT_IP_STORAGE_ENABLED === "1" || env.JCOMMENT_IP_STORAGE_ENABLED === "true",
                allowRanges: splitRanges(env.JCOMMENT_IP_ALLOW_RANGES),
                denyRanges: splitRanges(env.JCOMMENT_IP_DENY_RANGES)
              }
            },
            security: {
              sessionCookie: {
                enabled: env.JCOMMENT_SESSION_COOKIE_ENABLED === undefined
                  ? "auto"
                  : env.JCOMMENT_SESSION_COOKIE_ENABLED === "1" || env.JCOMMENT_SESSION_COOKIE_ENABLED === "true",
                name: env.JCOMMENT_SESSION_COOKIE_NAME || "jcomment_session",
                sameSite: env.JCOMMENT_SESSION_COOKIE_SAMESITE || "Lax",
                secure: env.JCOMMENT_SESSION_COOKIE_SECURE !== "0" && env.JCOMMENT_SESSION_COOKIE_SECURE !== "false",
                exposeToken: env.JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN === "1" || env.JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN === "true"
              },
              rateLimit: {
                enabled: env.JCOMMENT_RATE_LIMIT_ENABLED !== "0" && env.JCOMMENT_RATE_LIMIT_ENABLED !== "false",
                windowMs: Number(env.JCOMMENT_RATE_LIMIT_WINDOW_MS || 60_000),
                limits: {
                  postSite: Number(env.JCOMMENT_RATE_LIMIT_POST_SITE || 60)
                }
              },
              quotas: {
                maxCommentsPerThread: Number(env.JCOMMENT_MAX_COMMENTS_PER_THREAD || 512),
                maxCommentsPerSite: Number(env.JCOMMENT_MAX_COMMENTS_PER_SITE || 5000)
              }
            },
            getClientIp: request => request.headers.get("cf-connecting-ip") || ""
          });
        }
        handleComments = cachedHandler;
      } catch (error) {
        console.error(error);
        return json({ error: "Internal Server Error" }, { status: 500 });
      }
      return handleComments(request);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};

function splitRanges(value) {
  return String(value || "").split(",").map(range => range.trim()).filter(Boolean);
}

function workerConfigKey(env, hostname) {
  return JSON.stringify({
    site: env.JCOMMENT_SITE || hostname,
    broken: env.BROKEN_CONFIG,
    requireLoginToPost: env.JCOMMENT_REQUIRE_LOGIN_TO_POST,
    maxVotes: env.JCOMMENT_MAX_VOTES_PER_IDENTITY,
    voting: env.JCOMMENT_VOTING_ENABLED,
    login: env.JCOMMENT_LOGIN_ENABLED,
    email: env.JCOMMENT_EMAIL_MODE,
    sessionTtl: env.JCOMMENT_SESSION_TTL_MS,
    reset: env.JCOMMENT_PASSWORD_RESET_ENABLED,
    resetDelivery: Boolean(env.JCOMMENT_PASSWORD_RESET?.sendToken),
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

function passwordResetConfig(env) {
  const enabled = env.JCOMMENT_PASSWORD_RESET_ENABLED === "1" || env.JCOMMENT_PASSWORD_RESET_ENABLED === "true";
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
