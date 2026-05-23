import { createCommentHandler, createMemoryStore, createSqliteStore } from "../server/core.mjs";
import { jcommentExpress } from "../server/express.mjs";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const handler = createCommentHandler({ store: createMemoryStore(), cors: true, site: "check-site", getClientIp: () => "203.0.113.10" });
const url = "http://example.test/api/comments?thread=check";

try {
  createCommentHandler({
    store: createMemoryStore(),
    posting: { requireLogin: true },
    voteIdentity: { login: { enabled: false } }
  });
  throw new Error("expected invalid config to throw");
} catch (error) {
  if (!String(error.message).includes("Invalid jcomment configuration")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      sessionCookie: {
        enabled: true,
        exposeToken: true
      }
    }
  });
  throw new Error("expected exposed cookie token config to throw");
} catch (error) {
  if (!String(error.message).includes("token exposure")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      accounts: {
        email: "required",
        passwordReset: {
          enabled: true
        }
      }
    }
  });
  throw new Error("expected missing reset delivery config to throw");
} catch (error) {
  if (!String(error.message).includes("password reset requires voteIdentity.accounts.passwordReset.onToken")) throw error;
}

try {
  createCommentHandler({
    store: {
      async list() {
        return { comments: [], count: 0, nextCursor: null };
      },
      async add() {
        return { comments: [], count: 0, nextCursor: null };
      }
    }
  });
  throw new Error("expected custom store without durable rate limits to throw");
} catch (error) {
  if (!String(error.message).includes("security.rateLimit requires store.checkRateLimit")) throw error;
}

const configWarnings = [];
const originalWarn = console.warn;
console.warn = message => configWarnings.push(message);
createCommentHandler({
  store: createMemoryStore(),
  brokenConfig: true,
  posting: { requireLogin: true },
  voteIdentity: { login: { enabled: false } }
});
console.warn = originalWarn;
if (!configWarnings.some(message => message.includes("BROKEN_CONFIG=1 is unsupported"))) {
  throw new Error("expected broken config warning");
}

{
  const tmp = mkdtempSync(join(tmpdir(), "jcomment-mode-"));
  try {
    const dbPath = join(tmp, "jcomment.sqlite3");
    const store = createSqliteStore({ path: dbPath });
    await store.list("default", "noop");
    if ((statSync(dbPath).mode & 0o777) !== 0o600) {
      throw new Error("expected SQLite database file to be chmod 0600");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

let response = await handler(new Request(url));
let payload = await response.json();
if (response.status !== 200 || payload.comments.length !== 0 || payload.count !== 0) {
  throw new Error("expected an empty comment list");
}

response = await handler(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "Hello from test" })
}));
payload = await response.json();
if (response.status !== 201 || payload.comments.length !== 1) {
  throw new Error("expected comment creation");
}
const parentId = payload.comments[0].id;

response = await handler(new Request(`${url}&sort=oldest`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Grace", body: "A reply", parentId })
}));
payload = await response.json();
if (response.status !== 201 || payload.comments.length !== 2 || payload.comments[0].replyCount !== 1) {
  throw new Error("expected reply creation");
}

response = await handler(new Request(url, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: parentId, action: "downvote" })
}));
if (response.status !== 400) {
  throw new Error("expected unsupported vote action to be rejected");
}

response = await handler(new Request(url, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: parentId, action: "upvote" })
}));
if (response.status !== 401) {
  throw new Error("expected login requirement for voting without IP tracking");
}

response = await handler(new Request("http://localhost/api/comments?thread=check", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: parentId, action: "upvote" })
}));
if (response.status !== 401) {
  throw new Error("expected localhost Host header not to create vote identity");
}

response = await handler(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "x".repeat(9000) })
}));
if (response.status !== 413) {
  throw new Error("expected oversized JSON body rejection");
}

const localHandler = createCommentHandler({
  store: createMemoryStore({
    local: [{ id: "local-comment", author: "Ada", body: "Local", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  getClientIp: () => "127.0.0.1",
  voteIdentity: {
    maxVotesPerIdentity: 1,
    ipStorage: {
      localhost: true
    }
  }
});
response = await localHandler(new Request("http://localhost/api/comments?thread=local", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "local-comment", action: "upvote" })
}));
payload = await response.json();
if (response.status !== 200 || payload.comments[0].score !== 1) {
  throw new Error("expected explicit localhost vote opt-in");
}
response = await localHandler(new Request("http://localhost/api/comments?thread=local", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "local-comment", action: "upvote" })
}));
if (response.status !== 429) {
  throw new Error("expected localhost vote limit");
}

response = await handler(new Request("http://example.test/api/comments/signup?site=check-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "correct horse battery staple" })
}));
if (response.status !== 400) {
  throw new Error("expected reserved username to be rejected");
}

response = await handler(new Request("http://example.test/api/comments/signup?site=check-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
if (response.status !== 202 || payload.token || payload.ok !== true) {
  throw new Error("expected non-disclosing signup response");
}

response = await handler(new Request("http://example.test/api/comments/login?site=check-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
const token = payload.token;
if (response.status !== 201 || !token) {
  throw new Error("expected account login token");
}

response = await handler(new Request(url, {
  method: "PATCH",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ id: parentId, action: "upvote" })
}));
payload = await response.json();
if (response.status !== 200 || payload.comments.find(comment => comment.id === parentId).score !== 1) {
  throw new Error("expected vote update");
}

response = await handler(new Request("http://example.test/api/comments/signup?site=check-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "ADA", password: "correct horse battery staple" })
}));
payload = await response.json();
if (response.status !== 202 || payload.token || payload.ok !== true) {
  throw new Error("expected duplicate signup to avoid account existence disclosure");
}

const postLoginHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.20",
  cors: true,
  site: "post-site",
  posting: {
    requireLogin: true
  }
});
response = await postLoginHandler(new Request("http://example.test/api/comments?thread=post-login&site=post-site", {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
  body: JSON.stringify({ author: "Ada", body: "Should fail without login" })
}));
payload = await response.json();
if (response.status !== 401 || payload.error !== "Login is required to post comments") {
  throw new Error("expected login requirement for posting");
}
response = await postLoginHandler(new Request("http://example.test/api/comments/signup?site=post-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
if (response.status !== 202) {
  throw new Error("expected non-disclosing signup before login");
}
response = await postLoginHandler(new Request("http://example.test/api/comments/login?site=post-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
const postToken = payload.token;
response = await postLoginHandler(new Request("http://example.test/api/comments?thread=post-login&site=post-site", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${postToken}`, "x-forwarded-for": "203.0.113.7" },
  body: JSON.stringify({ author: "Mallory", body: "Posted with login" })
}));
payload = await response.json();
if (response.status !== 201 || payload.comments[0].body !== "Posted with login" || payload.comments[0].author !== "Ada") {
  throw new Error("expected logged-in posting to bind the account username as author");
}

const cookieHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.21",
  site: "cookie-site",
  posting: { requireLogin: true },
  voteIdentity: {
    accounts: {
      discloseAccountExistence: true
    }
  },
  security: {
    sessionCookie: {
      enabled: true,
      secure: false
    }
  }
});
response = await cookieHandler(new Request("http://example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "CookieUser", password: "correct horse battery staple" })
}));
payload = await response.json();
const sessionCookie = response.headers.get("set-cookie");
if (response.status !== 201 || payload.token || !sessionCookie?.includes("HttpOnly")) {
  throw new Error("expected HttpOnly cookie session without exposed bearer token");
}
response = await cookieHandler(new Request("http://example.test/api/comments?thread=cookie-post", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: sessionCookie.split(";")[0], "sec-fetch-site": "same-origin" },
  body: JSON.stringify({ author: "Mallory", body: "Posted with cookie" })
}));
payload = await response.json();
if (response.status !== 201 || payload.comments[0].author !== "CookieUser") {
  throw new Error("expected cookie session to authenticate posting");
}
response = await cookieHandler(new Request("http://example.test/api/comments?thread=cookie-post", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: sessionCookie.split(";")[0] },
  body: JSON.stringify({ author: "Mallory", body: "Cookie post without metadata should fail" })
}));
if (response.status !== 403) {
  throw new Error("expected cookie-authenticated post without origin metadata to be rejected");
}
response = await cookieHandler(new Request("http://example.test/api/comments?thread=cookie-post", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie: sessionCookie.split(";")[0],
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site"
  },
  body: JSON.stringify({ author: "Mallory", body: "Cross-site post should fail" })
}));
if (response.status !== 403) {
  throw new Error("expected cross-site cookie-authenticated post to be rejected");
}
response = await cookieHandler(new Request("http://example.test/api/comments?thread=cookie-post", {
  method: "POST",
  headers: {
    "content-type": "text/plain",
    cookie: sessionCookie.split(";")[0]
  },
  body: JSON.stringify({ author: "Mallory", body: "Plain text post should fail" })
}));
if (response.status !== 415) {
  throw new Error("expected non-JSON unsafe request to be rejected");
}

const expiredSessionHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.22",
  site: "expired-site",
  posting: { requireLogin: true },
  voteIdentity: {
    accounts: {
      discloseAccountExistence: true,
      session: { ttlMs: 1 }
    }
  }
});
response = await expiredSessionHandler(new Request("http://example.test/api/comments/signup?site=expired-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
await new Promise(resolve => setTimeout(resolve, 5));
response = await expiredSessionHandler(new Request("http://example.test/api/comments?thread=expired&site=expired-site", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${payload.token}` },
  body: JSON.stringify({ author: "Ada", body: "Expired token should fail" })
}));
if (response.status !== 401) {
  throw new Error("expected expired session token to be rejected");
}

const sharedStore = createMemoryStore();
const attackerSiteHandler = createCommentHandler({
  store: sharedStore,
  getClientIp: () => "203.0.113.23",
  site: "attacker-site",
  voteIdentity: {
    accounts: {
      discloseAccountExistence: true
    }
  }
});
const victimSiteHandler = createCommentHandler({
  store: sharedStore,
  getClientIp: () => "203.0.113.24",
  site: "victim-site",
  posting: { requireLogin: true }
});
response = await attackerSiteHandler(new Request("http://example.test/api/comments/signup?site=victim-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Mallory", password: "correct horse battery staple" })
}));
payload = await response.json();
response = await victimSiteHandler(new Request("http://example.test/api/comments?thread=victim-thread&site=attacker-site", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${payload.token}` },
  body: JSON.stringify({ author: "Mallory", body: "Cross-site post should fail" })
}));
if (response.status !== 401) {
  throw new Error("expected server-owned site to reject cross-site token replay");
}

const limitedPostHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.25",
  security: {
    rateLimit: {
      limits: { post: 1 }
    }
  }
});
for (const expectedStatus of [201, 429]) {
  response = await limitedPostHandler(new Request("http://example.test/api/comments?thread=limited", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "rate-limit-check" },
    body: JSON.stringify({ author: "Ada", body: `Post ${expectedStatus}` })
  }));
  if (response.status !== expectedStatus) {
    throw new Error("expected post rate limiting");
  }
}

const limitedSitePostHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.26",
  security: {
    rateLimit: {
      limits: { post: 100, postSite: 1 }
    }
  }
});
for (const [thread, expectedStatus] of [["one", 201], ["two", 429]]) {
  response = await limitedSitePostHandler(new Request(`http://example.test/api/comments?thread=${thread}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ author: "Ada", body: `Site limited ${thread}` })
  }));
  if (response.status !== expectedStatus) {
    throw new Error("expected site-wide post rate limiting across rotated threads");
  }
}

const quotaHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.27",
  security: {
    quotas: {
      maxCommentsPerThread: 1,
      maxCommentsPerSite: 2
    }
  }
});
for (const [thread, expectedStatus] of [["quota-a", 201], ["quota-a", 507], ["quota-b", 201], ["quota-c", 507]]) {
  response = await quotaHandler(new Request(`http://example.test/api/comments?thread=${thread}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ author: "Ada", body: `Quota ${thread}` })
  }));
  if (response.status !== expectedStatus) {
    throw new Error("expected comment quotas to be enforced");
  }
}

const resetTokens = [];
const resetHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.28",
  cors: true,
  site: "reset-site",
  voteIdentity: {
    accounts: {
      email: "required",
      passwordReset: {
        enabled: true,
        onToken: ({ token }) => {
          resetTokens.push(token);
        }
      }
    }
  },
  security: {
    rateLimit: {
      limits: { reset: 10 }
    }
  }
});
response = await resetHandler(new Request("http://example.test/api/comments/signup?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Lin", email: "lin@example.test", password: "old password value" })
}));
if (response.status !== 202) {
  throw new Error("expected required-email signup");
}
response = await resetHandler(new Request("http://example.test/api/comments/reset/request?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Lin", email: "lin@example.test" })
}));
payload = await response.json();
if (response.status !== 201 || resetTokens.length !== 1 || payload.token) {
  throw new Error("expected reset token to be delivered out of band only");
}
response = await resetHandler(new Request("http://example.test/api/comments/reset/request?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Lin", email: "lin@example.test" })
}));
if (response.status !== 201 || resetTokens.length !== 1) {
  throw new Error("expected second reset request to reuse the pending reset window");
}
response = await resetHandler(new Request("http://example.test/api/comments/reset/confirm?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: resetTokens[0], password: "new password value" })
}));
if (response.status !== 201) {
  throw new Error("expected password reset confirmation");
}
response = await resetHandler(new Request("http://example.test/api/comments/reset/confirm?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: resetTokens[0], password: "second reset should fail" })
}));
if (response.status !== 400) {
  throw new Error("expected password reset token to be single-use");
}
response = await resetHandler(new Request("http://example.test/api/comments/login?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Lin", password: "new password value" })
}));
payload = await response.json();
if (response.status !== 201 || !payload.token) {
  throw new Error("expected login after reset");
}

{
  const failedResetTokens = [];
  const failedResetHandler = createCommentHandler({
    store: createMemoryStore(),
    getClientIp: () => "203.0.113.29",
    site: "failed-reset-site",
    voteIdentity: {
      accounts: {
        email: "required",
        passwordReset: {
          enabled: true,
          onToken: ({ token }) => {
            failedResetTokens.push(token);
            throw new Error("delivery failed");
          }
        }
      }
    },
    security: {
      rateLimit: {
        limits: { reset: 10 }
      }
    }
  });
  response = await failedResetHandler(new Request("http://example.test/api/comments/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Lin", email: "lin@example.test", password: "old password value" })
  }));
  if (response.status !== 202) {
    throw new Error("expected failed-reset signup");
  }
  const savedError = console.error;
  console.error = () => {};
  response = await failedResetHandler(new Request("http://example.test/api/comments/reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Lin", email: "lin@example.test" })
  }));
  console.error = savedError;
  if (response.status !== 500 || failedResetTokens.length !== 1) {
    throw new Error("expected failed reset delivery to fail closed");
  }
  response = await failedResetHandler(new Request("http://example.test/api/comments/reset/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: failedResetTokens[0], password: "new password value" })
  }));
  if (response.status !== 400) {
    throw new Error("expected failed reset delivery token to be cleaned up");
  }
}

const resetLimitHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.30",
  site: "reset-limit-site",
  voteIdentity: {
    accounts: {
      email: "required",
      passwordReset: {
        enabled: true,
        onToken: () => {}
      }
    }
  },
  security: {
    rateLimit: {
      limits: { reset: 1 }
    }
  }
});
for (const expectedStatus of [400, 429]) {
  response = await resetLimitHandler(new Request("http://example.test/api/comments/reset/confirm?site=reset-limit-site", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "reset-limit-check" },
    body: JSON.stringify({ token: "not-a-token", password: "new password value" })
  }));
  if (response.status !== expectedStatus) {
    throw new Error("expected reset confirmation rate limiting");
  }
}

const warnings = [];
console.warn = message => warnings.push(message);
const anonymousHandler = createCommentHandler({
  store: createMemoryStore({
    anon: [{ id: "anon-comment", author: "Ada", body: "Anonymous voting", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  getClientIp: () => "203.0.113.31",
  voteIdentity: {
    login: { enabled: false }
  }
});
console.warn = originalWarn;
if (!warnings.some(message => message.includes("no durable server-side identity is available"))) {
  throw new Error("expected unidentified voting warning");
}

const missingIdentityHandler = createCommentHandler({
  store: createMemoryStore()
});
response = await missingIdentityHandler(new Request("http://example.test/api/comments?thread=missing-rate-identity", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "Missing IP should fail closed" })
}));
if (response.status !== 503) {
  throw new Error("expected missing rate-limit identity to fail closed");
}

response = await anonymousHandler(new Request("http://example.test/api/comments/login?site=anon", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
if (response.status !== 403) {
  throw new Error("expected disabled login endpoint");
}

response = await anonymousHandler(new Request("http://example.test/api/comments?thread=anon", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "anon-comment", action: "upvote" })
}));
payload = await response.json();
if (response.status !== 403 || payload.error !== "Voting is unavailable from this network") {
  throw new Error("expected voting without login or IP storage to be unavailable");
}

const disabledHandler = createCommentHandler({
  store: createMemoryStore({
    off: [{ id: "off-comment", author: "Ada", body: "Disabled voting", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  getClientIp: () => "203.0.113.32",
  voteIdentity: {
    voting: { enabled: false },
    login: { enabled: false }
  }
});
response = await disabledHandler(new Request("http://example.test/api/comments?thread=off", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "off-comment", action: "upvote" })
}));
if (response.status !== 403) {
  throw new Error("expected disabled voting");
}

warnings.length = 0;
console.warn = message => warnings.push(message);
const ipHandler = createCommentHandler({
  store: createMemoryStore({
    ip: [{ id: "ip-comment", author: "Ada", body: "IP-limited", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  voteIdentity: {
    maxVotesPerIdentity: 2,
    ipStorage: {
      enabled: true,
      allowRanges: ["203.0.113.0/24"],
      denyRanges: ["203.0.113.8"]
    }
  },
  getClientIp: request => request.headers.get("x-test-client-ip") || ""
});
console.warn = originalWarn;
if (!warnings.some(message => message.includes("stores upvoter IP addresses indefinitely"))) {
  throw new Error("expected IP storage warning");
}

const ipUrl = "http://example.test/api/comments?thread=ip";
const untrustedIpHandler = createCommentHandler({
  store: createMemoryStore({
    ip: [{ id: "ip-comment", author: "Ada", body: "IP-limited", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  getClientIp: () => "198.51.100.1",
  voteIdentity: {
    ipStorage: {
      enabled: true,
      trustForwardedHeaders: true,
      allowRanges: ["203.0.113.0/24"]
    }
  }
});
response = await untrustedIpHandler(new Request(ipUrl, {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
  body: JSON.stringify({ id: "ip-comment", action: "upvote" })
}));
if (response.status !== 401) {
  throw new Error("expected untrusted forwarded IP header to be ignored");
}

for (const expectedScore of [1, 2]) {
  response = await ipHandler(new Request(ipUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-client-ip": "203.0.113.7" },
    body: JSON.stringify({ id: "ip-comment", action: "upvote" })
  }));
  payload = await response.json();
  if (response.status !== 200 || payload.comments[0].score !== expectedScore) {
    throw new Error("expected IP vote to count within configured limit");
  }
}
response = await ipHandler(new Request(ipUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-client-ip": "203.0.113.7" },
  body: JSON.stringify({ id: "ip-comment", action: "upvote" })
}));
if (response.status !== 429) {
  throw new Error("expected IP vote limit");
}

response = await ipHandler(new Request(ipUrl, {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-test-client-ip": "203.0.113.8" },
  body: JSON.stringify({ id: "ip-comment", action: "upvote" })
}));
if (response.status !== 401) {
  throw new Error("expected denied IP range to require login");
}

warnings.length = 0;
console.warn = message => warnings.push(message);
const ipNoLoginHandler = createCommentHandler({
  store: createMemoryStore({
    ip: [{ id: "ip-comment", author: "Ada", body: "IP-limited", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  voteIdentity: {
    login: { enabled: false },
    ipStorage: {
      enabled: true,
      allowRanges: ["203.0.113.0/24"]
    }
  },
  getClientIp: request => request.headers.get("x-test-client-ip") || ""
});
console.warn = originalWarn;
response = await ipNoLoginHandler(new Request(ipUrl, {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-test-client-ip": "198.51.100.7" },
  body: JSON.stringify({ id: "ip-comment", action: "upvote" })
}));
payload = await response.json();
if (response.status !== 403 || payload.error !== "Voting is unavailable from this network") {
  throw new Error("expected denied IP range without login to get unavailable message");
}

response = await handler(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "" })
}));
if (response.status !== 400) {
  throw new Error("expected empty body validation");
}

const failingHandler = createCommentHandler({
  store: {
    async list() {
      return { comments: [], count: 0, nextCursor: null };
    },
    async add() {
      throw new Error("sqlite path /secret/jcomment.sqlite3 exploded");
    }
  },
  security: {
    rateLimit: {
      allowInMemory: true,
      allowAnonymousIdentity: true
    }
  }
});
const originalError = console.error;
const errors = [];
console.error = message => errors.push(message);
response = await failingHandler(new Request("http://example.test/api/comments?thread=failing", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "Failure should be generic" })
}));
console.error = originalError;
payload = await response.json();
if (response.status !== 500 || payload.error !== "Internal Server Error") {
  throw new Error("expected unexpected server errors to be generic");
}
if (!errors.some(error => String(error?.message || error).includes("/secret/jcomment.sqlite3"))) {
  throw new Error("expected unexpected server errors to be logged");
}

const multiHandler = createCommentHandler({ store: createMemoryStore(), cors: true, site: "multi-site", getClientIp: () => "203.0.113.33" });
for (const [thread, body] of [["article-a", "Comment for A"], ["article-b", "Comment for B"]]) {
  response = await multiHandler(new Request(`http://example.test/api/comments?thread=${thread}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ author: "Ada", body })
  }));
  if (response.status !== 201) {
    throw new Error(`expected comment creation for ${thread}`);
  }
}
response = await multiHandler(new Request("http://example.test/api/comments?thread=article-a"));
payload = await response.json();
if (payload.count !== 1 || payload.comments[0].body !== "Comment for A") {
  throw new Error("expected article-a comments to stay isolated");
}
response = await multiHandler(new Request("http://example.test/api/comments?thread=article-b"));
payload = await response.json();
if (payload.count !== 1 || payload.comments[0].body !== "Comment for B") {
  throw new Error("expected article-b comments to stay isolated");
}

{
  const route = jcommentExpress({
    store: createMemoryStore(),
    publicOrigin: "https://comments.example.test",
    allowedHosts: ["comments.example.test"]
  });
  const badHostRes = fakeExpressResponse();
  await route(fakeExpressRequest({ host: "attacker.example.test" }), badHostRes, error => { throw error; });
  if (badHostRes.statusCode !== 400) {
    throw new Error("expected Express adapter to reject unlisted Host headers");
  }
  const okRes = fakeExpressResponse();
  await route(fakeExpressRequest({ host: "comments.example.test" }), okRes, error => { throw error; });
  if (okRes.statusCode !== 200 || !String(okRes.body || "").includes("\"comments\"")) {
    throw new Error("expected Express adapter to use configured public origin with allowed Host");
  }
}

console.log("server handler ok");

function fakeExpressRequest({ host }) {
  return {
    method: "GET",
    protocol: "http",
    originalUrl: "/api/comments?thread=express",
    url: "/api/comments?thread=express",
    headers: { host },
    socket: { remoteAddress: "127.0.0.1" },
    get(name) {
      return String(name).toLowerCase() === "host" ? host : "";
    }
  };
}

function fakeExpressResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}
