import { createCommentHandler } from "../server/core.mjs";
import { createD1Store } from "../server/cloudflare-d1.js";
import worker from "../server/cloudflare-worker.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const originalConsoleError = console.error;

class D1Compat {
  constructor() {
    this.db = new DatabaseSync(":memory:");
  }

  prepare(sql) {
    const db = this.db;
    let values = [];
    return {
      bind(...args) {
        values = args;
        return this;
      },
      async first() {
        return db.prepare(sql).get(...values) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...values) };
      },
      async run() {
        const result = db.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result?.changes || 0) } };
      }
    };
  }

  async batch(statements) {
    this.db.exec("begin immediate");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("commit");
      return results;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
}

const d1 = new D1Compat();
const testArgon2id = {
  async hashPassword(password) {
    return `test:${password}`;
  },
  async verifyPassword(password, stored) {
    return stored === `test:${password}`;
  }
};

try {
  createCommentHandler({
    store: createD1Store({ db: new D1Compat() }),
    security: {
      quotas: {
        maxCommentsPerThread: "1e3"
      }
    }
  });
  throw new Error("expected D1 scientific-notation quota config to throw");
} catch (error) {
  if (!String(error.message).includes("security.quotas.maxCommentsPerThread must be an integer")) throw error;
}

const handler = createCommentHandler({
  store: createD1Store({ db: d1 }),
  getClientIp: () => "203.0.113.40",
  site: "worker-site",
  voteIdentity: {
    login: { enabled: false }
  }
});

let response = await handler(new Request("https://example.test/api/comments?thread=worker", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.44" },
  body: JSON.stringify({ author: "Ada", body: "Stored in D1" })
}));
assertNoStore(response, "D1 comment creation response");
let payload = await response.json();
if (response.status !== 201 || payload.count !== 1) {
  throw new Error("expected D1-backed comment creation");
}
const id = payload.comments[0].id;

response = await worker.fetch(new Request(`https://example.test/api/comments?thread=${"x".repeat(9000)}`, {
  headers: { "cf-connecting-ip": "203.0.113.44" }
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id
});
payload = await response.json();
if (response.status !== 400 || payload.error !== "Request metadata is too large") {
  throw new Error("expected Worker adapter to reject oversized request URLs before routing");
}

response = await worker.fetch(new Request("https://example.test/api/comments", {
  headers: {
    "cf-connecting-ip": "203.0.113.44",
    cookie: `jcomment_session=${"x".repeat(9000)}`
  }
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id
});
payload = await response.json();
if (response.status !== 400 || payload.error !== "Request metadata is too large") {
  throw new Error("expected Worker adapter to reject oversized request headers before routing");
}

const aggregateWorkerHeaders = new Headers();
for (let i = 0; i < 140; i += 1) aggregateWorkerHeaders.set(`x-pad-${i}`, "x".repeat(80));
response = await worker.fetch(new Request("https://example.test/api/comments", {
  headers: aggregateWorkerHeaders
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id
});
payload = await response.json();
if (response.status !== 400 || payload.error !== "Request metadata is too large") {
  throw new Error("expected Worker adapter to reject oversized aggregate request metadata before routing");
}

response = await worker.fetch(new Request("https://example.test/api/comments", {
  method: "PUT",
  headers: { "content-type": "text/plain" },
  body: "ignored"
}), new Proxy({}, {
  get(_target, property) {
    if (property === "JCOMMENT_DB") {
      throw new Error("unsupported Worker methods must not inspect storage bindings");
    }
    return undefined;
  }
}));
payload = await response.json();
if (response.status !== 405 || payload.error !== "Method not allowed") {
  throw new Error("expected Worker adapter to reject unsupported methods before storage binding access");
}
if (response.headers.get("allow") !== "GET, POST, PATCH, OPTIONS") {
  throw new Error("expected Worker unsupported method response to include Allow header");
}

response = await worker.fetch(new Request("https://example.test/not-api"), {});
assertNoStore(response, "Worker fallback 404 response");
payload = await response.json();
if (response.status !== 404 || payload.error !== "Not found") {
  throw new Error("expected Worker fallback 404 to be a hardened JSON response");
}

response = await handler(new Request("https://example.test/api/comments?thread=worker"));
payload = await response.json();
if (response.status !== 200 || payload.comments[0].body !== "Stored in D1") {
  throw new Error("expected D1-backed comment listing");
}

response = await handler(new Request("https://example.test/api/comments?thread=worker", {
  method: "PATCH",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.45" },
  body: JSON.stringify({ id, action: "upvote" })
}));
payload = await response.json();
if (response.status !== 403 || payload.error !== "Voting is unavailable from this network") {
  throw new Error("expected D1-backed voting without login or IP storage to be unavailable");
}

const quotaHandler = createCommentHandler({
  store: createD1Store({ db: new D1Compat() }),
  getClientIp: () => "203.0.113.41",
  site: "worker-quota-site",
  voteIdentity: {
    login: { enabled: false }
  },
  security: {
    quotas: {
      maxCommentsPerThread: 1,
      maxCommentsPerSite: 2
    }
  }
});
for (const [thread, expectedStatus] of [["quota-a", 201], ["quota-a", 507], ["quota-b", 201], ["quota-c", 507]]) {
  response = await quotaHandler(new Request(`https://example.test/api/comments?thread=${thread}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ author: "Ada", body: `Quota ${thread}` })
  }));
  if (response.status !== expectedStatus) {
    throw new Error("expected D1-backed comment quotas");
  }
}

{
  const directStore = createD1Store({ db: new D1Compat() });
  await directStore.add("direct-d1-site", "direct-d1-thread", {
    author: "Ada",
    body: "First direct D1 comment",
    quotas: { maxCommentsPerThread: 10, maxCommentsPerSite: 10 }
  });
  await directStore.add("direct-d1-site", "direct-d1-thread", {
    author: "Grace",
    body: "Second direct D1 comment",
    quotas: { maxCommentsPerThread: 10, maxCommentsPerSite: 10 }
  });
  const directPayload = await directStore.list("direct-d1-site", "direct-d1-thread", {
    sort: "oldest",
    cursor: "1e2",
    limit: 1
  });
  if (directPayload.comments[0]?.body !== "First direct D1 comment") {
    throw new Error("expected direct D1 scientific-notation cursor to fall back");
  }
}

{
  const legacyD1 = new D1Compat();
  legacyD1.db.exec(`
    create table comments (id text primary key, site text not null default 'default', thread text not null, author text not null, body text not null, created_at text not null, score integer not null default 0);
    insert into comments (id, site, thread, author, body, created_at, score) values
      ('legacy-d1-comment', 'default', 'legacy-d1-thread', 'Ada', 'Legacy D1 root', '2026-01-01T00:00:00.000Z', 0);
  `);
  const legacyStore = createD1Store({ db: legacyD1 });
  const legacyPayload = await legacyStore.list("default", "legacy-d1-thread");
  if (legacyPayload.comments[0]?.id !== "legacy-d1-comment" || legacyPayload.comments[0]?.parentId !== "") {
    throw new Error("expected D1 comments parent_id migration to preserve legacy root comments");
  }
}

const accountHandler = createCommentHandler({
  store: createD1Store({
    db: new D1Compat(),
    hashPassword: async password => `test:${password}`,
    verifyPassword: async (password, stored) => stored === `test:${password}`
  }),
  getClientIp: () => "203.0.113.42",
  site: "worker-site",
  voteIdentity: {
    accounts: {
      session: { ttlMs: 1 }
    }
  },
  security: {
    rateLimit: {
      limits: { signup: 10 }
    }
  }
});
response = await accountHandler(new Request("https://example.test/api/comments/signup?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.46" },
  body: JSON.stringify({ username: "admin", password: "correct horse battery staple" })
}));
if (response.status !== 400) {
  throw new Error("expected D1 reserved username rejection");
}
response = await accountHandler(new Request("https://example.test/api/comments/signup?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.46" },
  body: JSON.stringify({ username: "ad\nmin", password: "correct horse battery staple" })
}));
if (response.status !== 400) {
  throw new Error("expected D1 control characters in account username to be rejected");
}
response = await accountHandler(new Request("https://example.test/api/comments/signup?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.46" },
  body: JSON.stringify({ username: "bad\u007fname", password: "correct horse battery staple" })
}));
if (response.status !== 400) {
  throw new Error("expected D1 DEL control character in account username to be rejected");
}
response = await accountHandler(new Request("https://example.test/api/comments/signup?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.46" },
  body: JSON.stringify({ username: "ad\u200dmin", password: "correct horse battery staple" })
}));
if (response.status !== 400) {
  throw new Error("expected D1 Unicode format characters in account username to be rejected");
}
response = await accountHandler(new Request("https://example.test/api/comments/signup?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.46" },
  body: JSON.stringify({ username: "admin\uFE0F", password: "correct horse battery staple" })
}));
if (response.status !== 400) {
  throw new Error("expected D1 variation selectors in account username to be rejected");
}
response = await accountHandler(new Request("https://example.test/api/comments/signup?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.46" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
if (response.status !== 202 || payload.token || payload.ok !== true || response.headers.get("set-cookie")) {
  throw new Error("expected D1-backed non-disclosing signup response");
}
response = await accountHandler(new Request("https://example.test/api/comments/login?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.46" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
const loginCookie = response.headers.get("set-cookie")?.split(";")[0];
if (response.status !== 201 || payload.token || !loginCookie) {
  throw new Error("expected D1-backed login with cookie session");
}
response = await accountHandler(new Request("https://example.test/api/comments/signup?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "ADA", password: "correct horse battery staple" })
}));
payload = await response.json();
if (response.status !== 202 || payload.token || payload.ok !== true) {
  throw new Error("expected D1 duplicate signup to avoid account existence disclosure");
}
await new Promise(resolve => setTimeout(resolve, 5));
response = await accountHandler(new Request("https://example.test/api/comments?thread=worker", {
  method: "PATCH",
  headers: { "content-type": "application/json", cookie: loginCookie, "sec-fetch-site": "same-origin" },
  body: JSON.stringify({ id, action: "upvote" })
}));
if (response.status !== 401) {
  throw new Error("expected D1 expired session token to be rejected");
}

response = await worker.fetch(new Request("https://example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "WorkerUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id
});
assertNoStore(response, "Worker signup response");
payload = await response.json();
if (response.status !== 202 || payload.token || payload.ok !== true || response.headers.get("set-cookie")) {
  throw new Error("expected Worker HTTPS signup to avoid account existence disclosure by default");
}

const workerConfigErrors = [];
console.error = error => workerConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-cookie-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "CookieBoolUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SESSION_COOKIE_ENABLED: "maybe"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_SESSION_COOKIE_ENABLED"))) {
  throw new Error("expected Worker to fail closed on malformed cookie enabled env");
}

const workerPaddedBoolConfigErrors = [];
console.error = error => workerPaddedBoolConfigErrors.push(error);
response = await worker.fetch(new Request("https://padded-cookie-bool-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "PaddedCookieBoolUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SESSION_COOKIE_SECURE: "0 "
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerPaddedBoolConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_SESSION_COOKIE_SECURE"))) {
  throw new Error("expected Worker to fail closed on whitespace-padded boolean env");
}

const workerCookieNameConfigErrors = [];
console.error = error => workerCookieNameConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-cookie-name-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "CookieNameUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SESSION_COOKIE_NAME: "bad name"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerCookieNameConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_SESSION_COOKIE_NAME"))) {
  throw new Error("expected Worker to fail closed on malformed cookie name env");
}

const workerPaddedCookieNameConfigErrors = [];
console.error = error => workerPaddedCookieNameConfigErrors.push(error);
response = await worker.fetch(new Request("https://padded-cookie-name-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "PaddedCookieNameUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SESSION_COOKIE_NAME: " jcomment_session"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerPaddedCookieNameConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_SESSION_COOKIE_NAME"))) {
  throw new Error("expected Worker to fail closed on whitespace-padded cookie name env");
}

const workerLongCookieNameConfigErrors = [];
console.error = error => workerLongCookieNameConfigErrors.push(error);
response = await worker.fetch(new Request("https://long-cookie-name-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "LongCookieNameUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SESSION_COOKIE_NAME: `jcomment_${"x".repeat(300)}`
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerLongCookieNameConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_SESSION_COOKIE_NAME"))) {
  throw new Error("expected Worker to fail closed on oversized cookie name env");
}

const workerCookieSameSiteConfigErrors = [];
console.error = error => workerCookieSameSiteConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-cookie-samesite-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "CookieSameSiteUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SESSION_COOKIE_SAMESITE: "Sometimes"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerCookieSameSiteConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_SESSION_COOKIE_SAMESITE"))) {
  throw new Error("expected Worker to fail closed on malformed cookie SameSite env");
}

const workerCookieExposeConfigErrors = [];
console.error = error => workerCookieExposeConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-cookie-expose-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "CookieExposeUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN: "1"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerCookieExposeConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN is not supported"))) {
  throw new Error("expected Worker to fail closed on exposed cookie token env");
}

const workerCookieNoneConfigErrors = [];
console.error = error => workerCookieNoneConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-cookie-none-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "CookieNoneUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SESSION_COOKIE_SAMESITE: "None",
  JCOMMENT_SESSION_COOKIE_SECURE: "0"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerCookieNoneConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_SESSION_COOKIE_SAMESITE=None requires JCOMMENT_SESSION_COOKIE_SECURE=1"))) {
  throw new Error("expected Worker to fail closed on insecure SameSite=None cookie env");
}

const workerPostConfigErrors = [];
console.error = error => workerPostConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-post-env.example.test/api/comments", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ author: "Ada", body: "bad post env" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_REQUIRE_LOGIN_TO_POST: "maybe"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerPostConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_REQUIRE_LOGIN_TO_POST"))) {
  throw new Error("expected Worker to fail closed on malformed require-login-to-post env");
}

const workerBrokenConfigErrors = [];
console.error = error => workerBrokenConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-broken-env.example.test/api/comments", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ author: "Ada", body: "bad broken env" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  BROKEN_CONFIG: "maybe"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerBrokenConfigErrors.some(error => String(error?.message || error).includes("BROKEN_CONFIG"))) {
  throw new Error("expected Worker to fail closed on malformed BROKEN_CONFIG env");
}

const workerNumericConfigErrors = [];
console.error = error => workerNumericConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-numeric-env.example.test/api/comments", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ author: "Ada", body: "bad numeric env" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_RATE_LIMIT_WINDOW_MS: "soon"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerNumericConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_RATE_LIMIT_WINDOW_MS"))) {
  throw new Error("expected Worker to fail closed on malformed numeric env");
}

const workerScientificNumericConfigErrors = [];
console.error = error => workerScientificNumericConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-scientific-numeric-env.example.test/api/comments", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ author: "Ada", body: "bad scientific numeric env" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_RATE_LIMIT_WINDOW_MS: "1e3"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerScientificNumericConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_RATE_LIMIT_WINDOW_MS"))) {
  throw new Error("expected Worker to fail closed on scientific-notation numeric env");
}

const workerPaddedNumericConfigErrors = [];
console.error = error => workerPaddedNumericConfigErrors.push(error);
response = await worker.fetch(new Request("https://padded-numeric-env.example.test/api/comments", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ author: "Ada", body: "padded numeric env" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_RATE_LIMIT_WINDOW_MS: "60000 "
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerPaddedNumericConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_RATE_LIMIT_WINDOW_MS"))) {
  throw new Error("expected Worker to fail closed on whitespace-padded numeric env");
}

const workerOversizedConfigErrors = [];
console.error = error => workerOversizedConfigErrors.push(error);
response = await worker.fetch(new Request("https://oversized-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "OversizedEnvUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_RESERVED_USERNAMES: "admin," + "x".repeat(9000)
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerOversizedConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_RESERVED_USERNAMES must not exceed"))) {
  throw new Error("expected Worker to fail closed on oversized env metadata");
}

const workerEmailModeConfigErrors = [];
console.error = error => workerEmailModeConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-email-mode-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "BadEmailModeUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_EMAIL_MODE: "mandatory"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerEmailModeConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_EMAIL_MODE"))) {
  throw new Error("expected Worker to fail closed on malformed email mode env");
}

const workerPaddedEmailModeConfigErrors = [];
console.error = error => workerPaddedEmailModeConfigErrors.push(error);
response = await worker.fetch(new Request("https://padded-email-mode-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "PaddedEmailModeUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_EMAIL_MODE: "required "
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerPaddedEmailModeConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_EMAIL_MODE"))) {
  throw new Error("expected Worker to fail closed on whitespace-padded email mode env");
}

const workerSiteConfigErrors = [];
console.error = error => workerSiteConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-site-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "BadSiteUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SITE: "bad\tsite"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerSiteConfigErrors.some(error => String(error?.message || error).includes("site must not contain control characters"))) {
  throw new Error("expected Worker to fail closed on malformed site env");
}

const workerPaddedSiteConfigErrors = [];
console.error = error => workerPaddedSiteConfigErrors.push(error);
response = await worker.fetch(new Request("https://padded-site-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "PaddedSiteUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SITE: " padded-site"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerPaddedSiteConfigErrors.some(error => String(error?.message || error).includes("site must not contain control characters"))) {
  throw new Error("expected Worker to fail closed on whitespace-padded site env");
}

const workerFixedSiteOriginErrors = [];
console.error = error => workerFixedSiteOriginErrors.push(error);
response = await worker.fetch(new Request("https://fixed-site-worker.example.test/api/comments", {
  headers: { "cf-connecting-ip": "203.0.113.47" }
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SITE: "fixed-worker-site"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerFixedSiteOriginErrors.some(error => String(error?.message || error).includes("JCOMMENT_PUBLIC_ORIGIN is required"))) {
  throw new Error("expected Worker fixed-site cookies to require a public origin");
}

response = await worker.fetch(new Request("https://alternate-worker.example.test/api/comments", {
  headers: { "cf-connecting-ip": "203.0.113.47" }
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SITE: "fixed-worker-site",
  JCOMMENT_PUBLIC_ORIGIN: "https://fixed-site-worker.example.test"
});
payload = await response.json();
if (response.status !== 400 || payload.error !== "Bad Request") {
  throw new Error("expected Worker fixed-site cookies to reject alternate request origins");
}

const workerIpRangeConfigErrors = [];
console.error = error => workerIpRangeConfigErrors.push(error);
response = await worker.fetch(new Request("https://bad-ip-range-env.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "BadIpRangeUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_IP_DENY_RANGES: "203.0.113.0/not-a-prefix"
});
console.error = originalConsoleError;
payload = await response.json();
if (response.status !== 500 || !workerIpRangeConfigErrors.some(error => String(error?.message || error).includes("denyRanges contains invalid range"))) {
  throw new Error("expected Worker to fail closed on malformed IP deny range env");
}

response = await worker.fetch(new Request("https://example.test/api/comments/anything/login", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "WorkerUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id
});
payload = await response.json();
if (response.status !== 404 || payload.error !== "Not found") {
  throw new Error("expected Worker to reject nested API login path");
}

response = await worker.fetch(new Request("https://example.test/api/comments/login", {
  method: "PATCH",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.47" },
  body: JSON.stringify({ username: "WorkerUser", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id
});
payload = await response.json();
if (response.status !== 405 || payload.error !== "Method not allowed") {
  throw new Error("expected Worker to reject route-specific unsupported methods before handler dispatch");
}

const originalError = console.error;
const expectedConfigErrors = [];
console.error = error => expectedConfigErrors.push(error);
response = await worker.fetch(new Request("https://reset-missing.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.48" },
  body: JSON.stringify({ username: "ResetUser", email: "reset@example.test", password: "correct horse battery staple" })
}), {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_EMAIL_MODE: "required",
  JCOMMENT_PASSWORD_RESET_ENABLED: "1"
});
console.error = originalError;
if (response.status !== 500 || !expectedConfigErrors.some(error => String(error?.message || error).includes("JCOMMENT_PASSWORD_RESET service binding"))) {
  throw new Error("expected Worker password reset without delivery binding to fail closed");
}

const deliveredResetTokens = [];
const resetBoundEnv = {
  JCOMMENT_DB: new D1Compat(),
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_EMAIL_MODE: "required",
  JCOMMENT_PASSWORD_RESET_ENABLED: "1",
  JCOMMENT_PASSWORD_RESET: {
    async sendToken(payload) {
      deliveredResetTokens.push(payload);
    }
  }
};
response = await worker.fetch(new Request("https://reset-bound.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.49" },
  body: JSON.stringify({ username: "ResetUser", email: "reset@example.test", password: "correct horse battery staple" })
}), resetBoundEnv);
if (response.status !== 202) {
  throw new Error("expected Worker password reset delivery binding to satisfy config");
}
response = await worker.fetch(new Request("https://reset-bound.example.test/api/comments/reset/request", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.49" },
  body: JSON.stringify({ username: "ResetUser", email: "reset@example.test" })
}), resetBoundEnv);
payload = await response.json();
if (response.status !== 201 || payload.token || deliveredResetTokens.length !== 1) {
  throw new Error("expected Worker password reset token to be delivered through binding only");
}

const cacheBindingDb = new D1Compat();
const firstBindingTokens = [];
const secondBindingTokens = [];
const cacheBindingBaseEnv = {
  JCOMMENT_DB: cacheBindingDb,
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SITE: "worker-binding-cache",
  JCOMMENT_PUBLIC_ORIGIN: "https://binding-cache.example.test",
  JCOMMENT_EMAIL_MODE: "required",
  JCOMMENT_PASSWORD_RESET_ENABLED: "1"
};
const firstBindingEnv = {
  ...cacheBindingBaseEnv,
  JCOMMENT_PASSWORD_RESET: {
    async sendToken(payload) {
      firstBindingTokens.push(payload);
    }
  }
};
const secondBindingEnv = {
  ...cacheBindingBaseEnv,
  JCOMMENT_PASSWORD_RESET: {
    async sendToken(payload) {
      secondBindingTokens.push(payload);
    }
  }
};
response = await worker.fetch(new Request("https://binding-cache.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
  body: JSON.stringify({ username: "BindingOne", email: "binding-one@example.test", password: "correct horse battery staple" })
}), firstBindingEnv);
if (response.status !== 202) {
  throw new Error("expected Worker signup with first reset binding");
}
response = await worker.fetch(new Request("https://binding-cache.example.test/api/comments/reset/request", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
  body: JSON.stringify({ username: "BindingOne", email: "binding-one@example.test" })
}), firstBindingEnv);
if (response.status !== 201 || firstBindingTokens.length !== 1 || secondBindingTokens.length !== 0) {
  throw new Error("expected first Worker reset binding to receive first token");
}
response = await worker.fetch(new Request("https://binding-cache.example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.51" },
  body: JSON.stringify({ username: "BindingTwo", email: "binding-two@example.test", password: "correct horse battery staple" })
}), secondBindingEnv);
if (response.status !== 202) {
  throw new Error("expected Worker signup with second reset binding");
}
response = await worker.fetch(new Request("https://binding-cache.example.test/api/comments/reset/request", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.51" },
  body: JSON.stringify({ username: "BindingTwo", email: "binding-two@example.test" })
}), secondBindingEnv);
if (response.status !== 201 || firstBindingTokens.length !== 1 || secondBindingTokens.length !== 1) {
  throw new Error("expected Worker cache to rebuild when reset delivery binding changes");
}

const poisonCacheDb = new D1Compat();
const poisonGoodEnv = {
  JCOMMENT_DB: poisonCacheDb,
  JCOMMENT_ARGON2ID: testArgon2id,
  JCOMMENT_SITE: "worker-cache-good",
  JCOMMENT_PUBLIC_ORIGIN: "https://poison-cache.example.test"
};
response = await worker.fetch(new Request("https://poison-cache.example.test/api/comments", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.52" },
  body: JSON.stringify({ author: "Ada", body: "good cache entry" })
}), poisonGoodEnv);
if (response.status !== 201) {
  throw new Error("expected Worker good config to prime cache");
}
const poisonConfigErrors = [];
console.error = error => poisonConfigErrors.push(error);
const poisonBadEnv = {
  ...poisonGoodEnv,
  JCOMMENT_SITE: "bad\tsite"
};
response = await worker.fetch(new Request("https://poison-cache.example.test/api/comments", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.52" },
  body: JSON.stringify({ author: "Ada", body: "bad config first request" })
}), poisonBadEnv);
if (response.status !== 500 || !poisonConfigErrors.some(error => String(error?.message || error).includes("site must not contain control characters"))) {
  console.error = originalConsoleError;
  throw new Error("expected bad Worker config to fail before cache assignment");
}
response = await worker.fetch(new Request("https://poison-cache.example.test/api/comments", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.52" },
  body: JSON.stringify({ author: "Ada", body: "bad config second request" })
}), poisonBadEnv);
console.error = originalConsoleError;
if (response.status !== 500 || poisonConfigErrors.length < 2) {
  throw new Error("expected repeated bad Worker config not to reuse previous cached handler");
}

const successfulD1ResetTokens = [];
const successfulD1ResetHandler = createCommentHandler({
  store: createD1Store({
    db: new D1Compat(),
    hashPassword: async password => `test:${password}`,
    verifyPassword: async (password, stored) => stored === `test:${password}`
  }),
  getClientIp: () => "203.0.113.44",
  site: "successful-d1-reset",
  posting: { requireLogin: true },
  voteIdentity: {
    accounts: {
      email: "required",
      passwordReset: {
        enabled: true,
        onToken: ({ token }) => {
          successfulD1ResetTokens.push(token);
        }
      }
    }
  },
  security: {
    rateLimit: {
      enabled: false,
      limits: { reset: 10 }
    }
  }
});
response = await successfulD1ResetHandler(new Request("http://example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1SessionReset", email: "d1-session-reset@example.test", password: "old password value" })
}));
if (response.status !== 202) {
  throw new Error("expected D1 session-reset signup");
}
response = await successfulD1ResetHandler(new Request("http://example.test/api/comments/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1SessionReset", password: "old password value" })
}));
payload = await response.json();
const preResetD1Token = payload.token;
if (response.status !== 201 || !preResetD1Token) {
  throw new Error("expected D1 login before reset");
}
response = await successfulD1ResetHandler(new Request("http://example.test/api/comments/reset/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1SessionReset", email: "d1-session-reset@example.test" })
}));
if (response.status !== 201 || successfulD1ResetTokens.length !== 1) {
  throw new Error("expected D1 reset request to deliver a token");
}
response = await successfulD1ResetHandler(new Request("http://example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1PendingResetRace", email: "d1-pending-reset-race@example.test", password: "old password value" })
}));
if (response.status !== 202) {
  throw new Error("expected D1 pending-reset-race signup");
}
const pendingStart = successfulD1ResetTokens.length;
const pendingResetResults = await Promise.all([
  successfulD1ResetHandler(new Request("http://example.test/api/comments/reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "D1PendingResetRace", email: "d1-pending-reset-race@example.test" })
  })),
  successfulD1ResetHandler(new Request("http://example.test/api/comments/reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "D1PendingResetRace", email: "d1-pending-reset-race@example.test" })
  }))
]);
if (pendingResetResults.some(result => result.status !== 201) || successfulD1ResetTokens.length !== pendingStart + 1) {
  throw new Error("expected concurrent D1 password reset requests to create one pending token");
}
response = await successfulD1ResetHandler(new Request("http://example.test/api/comments/reset/confirm", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: successfulD1ResetTokens[0], password: "new password value" })
}));
if (response.status !== 201) {
  throw new Error("expected D1 reset confirmation");
}
response = await successfulD1ResetHandler(new Request("http://example.test/api/comments?thread=d1-reset-post", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${preResetD1Token}` },
  body: JSON.stringify({ author: "D1SessionReset", body: "Old D1 session should fail" })
}));
if (response.status !== 401) {
  throw new Error("expected D1 password reset to invalidate existing sessions");
}

response = await successfulD1ResetHandler(new Request("http://example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1ResetRace", email: "d1-reset-race@example.test", password: "old password value" })
}));
if (response.status !== 202) {
  throw new Error("expected D1 reset-race signup");
}
response = await successfulD1ResetHandler(new Request("http://example.test/api/comments/reset/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1ResetRace", email: "d1-reset-race@example.test" })
}));
const d1RaceResetToken = successfulD1ResetTokens.at(-1);
if (response.status !== 201 || !d1RaceResetToken) {
  throw new Error("expected D1 reset-race token");
}
const d1RaceResults = await Promise.all([
  successfulD1ResetHandler(new Request("http://example.test/api/comments/reset/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: d1RaceResetToken, password: "first race password" })
  })),
  successfulD1ResetHandler(new Request("http://example.test/api/comments/reset/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: d1RaceResetToken, password: "second race password" })
  }))
]);
const d1RaceStatuses = d1RaceResults.map(result => result.status).sort();
if (d1RaceStatuses[0] !== 201 || d1RaceStatuses[1] !== 400) {
  throw new Error("expected concurrent D1 password reset confirmations to consume the token once");
}

const failedDeliveryTokens = [];
const failedDeliveryHandler = createCommentHandler({
  store: createD1Store({
    db: new D1Compat(),
    hashPassword: async password => `test:${password}`,
    verifyPassword: async (password, stored) => stored === `test:${password}`
  }),
  getClientIp: () => "203.0.113.43",
  site: "failed-d1-reset",
  voteIdentity: {
    accounts: {
      email: "required",
      passwordReset: {
        enabled: true,
        onToken: ({ token }) => {
          failedDeliveryTokens.push(token);
          throw new Error(`delivery failed for token ${token}`);
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
response = await failedDeliveryHandler(new Request("https://example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1Reset", email: "d1-reset@example.test", password: "correct horse battery staple" })
}));
if (response.status !== 202) {
  throw new Error("expected D1 failed-delivery signup");
}
const savedError = console.error;
const loggedErrors = [];
console.error = message => loggedErrors.push(String(message));
response = await failedDeliveryHandler(new Request("https://example.test/api/comments/reset/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1Reset", email: "d1-reset@example.test" })
}));
console.error = savedError;
if (response.status !== 201 || failedDeliveryTokens.length !== 1) {
  throw new Error("expected D1 failed reset delivery to keep returning a generic success response");
}
if (loggedErrors.some(message => message.includes(failedDeliveryTokens[0]))) {
  throw new Error("expected D1 failed reset delivery logging not to expose the raw reset token");
}
response = await failedDeliveryHandler(new Request("https://example.test/api/comments/reset/confirm", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: failedDeliveryTokens[0], password: "new password value" })
}));
if (response.status !== 400) {
  throw new Error("expected D1 failed reset delivery token to be cleaned up");
}

console.log("cloudflare d1 store ok");

function assertNoStore(response, label) {
  if (
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("pragma") !== "no-cache" ||
    response.headers.get("x-content-type-options") !== "nosniff"
  ) {
    throw new Error(`expected ${label} to include hardened JSON headers`);
  }
}
