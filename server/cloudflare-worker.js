import { createCommentHandler, json } from "./core.mjs";
import { createD1Store } from "./cloudflare-d1.js";

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
        handleComments = createCommentHandler({
          store: createD1Store({
            db: env.JCOMMENT_DB,
            hashPassword: env.JCOMMENT_ARGON2ID?.hashPassword?.bind(env.JCOMMENT_ARGON2ID) || hashPasswordPbkdf2,
            verifyPassword: env.JCOMMENT_ARGON2ID?.verifyPassword?.bind(env.JCOMMENT_ARGON2ID) || verifyPasswordPbkdf2
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
              passwordReset: {
                enabled: env.JCOMMENT_PASSWORD_RESET_ENABLED === "1" || env.JCOMMENT_PASSWORD_RESET_ENABLED === "true",
                exposeTokens: env.JCOMMENT_PASSWORD_RESET_EXPOSE_TOKEN === "1" || env.JCOMMENT_PASSWORD_RESET_EXPOSE_TOKEN === "true"
              }
            },
            ipStorage: {
              enabled: env.JCOMMENT_IP_STORAGE_ENABLED === "1" || env.JCOMMENT_IP_STORAGE_ENABLED === "true",
              allowRanges: splitRanges(env.JCOMMENT_IP_ALLOW_RANGES),
              denyRanges: splitRanges(env.JCOMMENT_IP_DENY_RANGES)
            }
          }
        });
      } catch (error) {
        return json({ error: error.message }, { status: 500 });
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

async function hashPasswordPbkdf2(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 310000;
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$i=${iterations}$${base64url(salt)}$${base64url(hash)}`;
}

async function verifyPasswordPbkdf2(password, stored) {
  const match = String(stored || "").match(/^pbkdf2-sha256\$i=(\d+)\$([^$]+)\$([^$]+)$/);
  if (!match) return false;
  const [, iterationsText, saltText, hashText] = match;
  const expected = unbase64url(hashText);
  const actual = await pbkdf2(password, unbase64url(saltText), Number(iterationsText));
  return timingSafeEqual(actual, expected);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations
  }, key, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unbase64url(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
