import { createCommentHandler, createMemoryStore, createSqliteStore } from "../server/core.mjs";
import { jcommentExpress } from "../server/express.mjs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const handler = createCommentHandler({
  store: createMemoryStore(),
  cors: "*",
  site: "check-site",
  getClientIp: () => "203.0.113.10",
  security: {
    sessionCookie: {
      enabled: false
    }
  }
});
const url = "http://example.test/api/comments?thread=check";
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

if (/JCOMMENT_LOGIN_ENABLED=0[\s\S]{0,120}JCOMMENT_REQUIRE_LOGIN_TO_POST=1/.test(readme)) {
  throw new Error("README must not recommend disabling login while requiring login to post");
}
if (readme.includes("upvotes are intentionally low-integrity and easy to manipulate")) {
  throw new Error("README must document login-disabled CGI voting as rejected, not low-integrity accepted");
}

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
    cors: "https://comments.example.test/"
  });
  throw new Error("expected malformed CORS config to throw");
} catch (error) {
  if (!String(error.message).includes("cors must be false, *, or an absolute http(s) origin")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    cors: true
  });
  throw new Error("expected non-string CORS config to throw");
} catch (error) {
  if (!String(error.message).includes("cors must be false, *, or an absolute http(s) origin")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    cors: "*"
  });
  throw new Error("expected wildcard CORS with cookie-capable sessions to throw");
} catch (error) {
  if (!String(error.message).includes("cors * requires security.sessionCookie.enabled = false")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    apiPath: "api/comments"
  });
  throw new Error("expected relative API path config to throw");
} catch (error) {
  if (!String(error.message).includes("apiPath must be an absolute URL path")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    apiPath: " /api/comments"
  });
  throw new Error("expected whitespace-padded API path config to throw");
} catch (error) {
  if (!String(error.message).includes("apiPath must be an absolute URL path")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    apiPath: "/api/comments?login"
  });
  throw new Error("expected query-bearing API path config to throw");
} catch (error) {
  if (!String(error.message).includes("apiPath must be an absolute URL path")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    apiPath: `/${"x".repeat(2000)}`
  });
  throw new Error("expected oversized API path config to throw");
} catch (error) {
  if (!String(error.message).includes("apiPath must be an absolute URL path")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      csrf: {
        trustedOrigins: ["https://admin.example.test/path"]
      }
    }
  });
  throw new Error("expected malformed CSRF trusted origin config to throw");
} catch (error) {
  if (!String(error.message).includes("security.csrf.trustedOrigins must contain exact absolute http(s) origins")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      csrf: {
        trustedOrigins: [`https://${"x".repeat(9000)}.example.test`]
      }
    }
  });
  throw new Error("expected oversized CSRF trusted origin config to throw");
} catch (error) {
  if (!String(error.message).includes("security.csrf.trustedOrigins must contain exact absolute http(s) origins")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      csrf: {
        trustedOrigins: [" https://admin.example.test"]
      }
    }
  });
  throw new Error("expected whitespace-padded CSRF trusted origin config to throw");
} catch (error) {
  if (!String(error.message).includes("security.csrf.trustedOrigins must contain exact absolute http(s) origins")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      csrf: {
        trustedOrigins: "https://admin.example.test"
      }
    }
  });
  throw new Error("expected non-array CSRF trusted origin config to throw");
} catch (error) {
  if (!String(error.message).includes("security.csrf.trustedOrigins must be an array")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      request: {
        maxMetadataBytes: "1e3"
      }
    }
  });
  throw new Error("expected scientific-notation request metadata limit config to throw");
} catch (error) {
  if (!String(error.message).includes("security.request.maxMetadataBytes must be an integer")) throw error;
}

try {
  createSqliteStore({ path: `${"x".repeat(5000)}.sqlite3` });
  throw new Error("expected oversized SQLite path config to throw");
} catch (error) {
  if (!String(error.message).includes("SQLite database path must be a non-empty path no longer than 4096 bytes")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      ipStorage: {
        enabled: "definitely"
      }
    }
  });
  throw new Error("expected malformed boolean config to throw");
} catch (error) {
  if (!String(error.message).includes("voteIdentity.ipStorage.enabled must be a boolean value")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      ipStorage: {
        enabled: "false "
      }
    }
  });
  throw new Error("expected whitespace-padded boolean config to throw");
} catch (error) {
  if (!String(error.message).includes("voteIdentity.ipStorage.enabled must be a boolean value")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      sessionCookie: {
        enabled: "auto "
      }
    }
  });
  throw new Error("expected whitespace-padded auto cookie config to throw");
} catch (error) {
  if (!String(error.message).includes("security.sessionCookie.enabled must be a boolean value")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      maxVotesPerIdentity: "not-a-number"
    }
  });
  throw new Error("expected malformed maxVotesPerIdentity config to throw");
} catch (error) {
  if (!String(error.message).includes("voteIdentity.maxVotesPerIdentity must be an integer")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      accounts: {
        email: "mandatory"
      }
    }
  });
  throw new Error("expected malformed account email mode config to throw");
} catch (error) {
  if (!String(error.message).includes("voteIdentity.accounts.email must be none, optional, or required")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      ipStorage: {
        enabled: true,
        allowRanges: "203.0.113.0/24"
      }
    }
  });
  throw new Error("expected non-array IP allow range config to throw");
} catch (error) {
  if (!String(error.message).includes("voteIdentity.ipStorage.allowRanges must be an array")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      ipStorage: {
        enabled: true,
        denyRanges: 42
      }
    }
  });
  throw new Error("expected non-array IP deny range config to throw");
} catch (error) {
  if (!String(error.message).includes("voteIdentity.ipStorage.denyRanges must be an array")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      accounts: {
        reservedUsernames: "admin,root"
      }
    }
  });
  throw new Error("expected malformed reserved username config to throw");
} catch (error) {
  if (!String(error.message).includes("voteIdentity.accounts.reservedUsernames must be an array")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      accounts: {
        reservedUsernames: ["admin", "bad\nname"]
      }
    }
  });
  throw new Error("expected control-character reserved username config to throw");
} catch (error) {
  if (!String(error.message).includes("reservedUsernames must contain non-empty account names")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      accounts: {
        reservedUsernames: ["admin", "root\uFE0F"]
      }
    }
  });
  throw new Error("expected variation-selector reserved username config to throw");
} catch (error) {
  if (!String(error.message).includes("reservedUsernames must contain non-empty account names")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      accounts: {
        reservedUsernames: ["admin", "x".repeat(9000)]
      }
    }
  });
  throw new Error("expected oversized reserved username config to throw");
} catch (error) {
  if (!String(error.message).includes("reservedUsernames must contain account names no longer than 256 bytes")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      maxVotesPerIdentity: 1.5
    }
  });
  throw new Error("expected fractional maxVotesPerIdentity config to throw");
} catch (error) {
  if (!String(error.message).includes("voteIdentity.maxVotesPerIdentity must be an integer")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      rateLimit: {
        limits: { post: "not-a-number" }
      }
    }
  });
  throw new Error("expected malformed rate limit config to throw");
} catch (error) {
  if (!String(error.message).includes("security.rateLimit.limits.post must be an integer")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      rateLimit: {
        limits: { post: "1e3" }
      }
    }
  });
  throw new Error("expected scientific-notation rate limit config to throw");
} catch (error) {
  if (!String(error.message).includes("security.rateLimit.limits.post must be an integer")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      quotas: {
        maxCommentsPerSite: "not-a-number"
      }
    }
  });
  throw new Error("expected malformed quota config to throw");
} catch (error) {
  if (!String(error.message).includes("security.quotas.maxCommentsPerSite must be an integer")) throw error;
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
    security: {
      sessionCookie: {
        name: "bad name"
      }
    }
  });
  throw new Error("expected malformed session cookie name config to throw");
} catch (error) {
  if (!String(error.message).includes("security.sessionCookie.name must be a valid cookie name")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      sessionCookie: {
        name: " jcomment_session"
      }
    }
  });
  throw new Error("expected whitespace-padded session cookie name config to throw");
} catch (error) {
  if (!String(error.message).includes("security.sessionCookie.name must be a valid cookie name")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      sessionCookie: {
        path: "/; Domain=example.test"
      }
    }
  });
  throw new Error("expected malformed session cookie path config to throw");
} catch (error) {
  if (!String(error.message).includes("security.sessionCookie.path must start with /")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      sessionCookie: {
        sameSite: "Sometimes"
      }
    }
  });
  throw new Error("expected malformed session cookie SameSite config to throw");
} catch (error) {
  if (!String(error.message).includes("security.sessionCookie.sameSite must be Strict, Lax, or None")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    security: {
      sessionCookie: {
        enabled: true,
        sameSite: "None",
        secure: false
      }
    }
  });
  throw new Error("expected insecure SameSite=None cookie config to throw");
} catch (error) {
  if (!String(error.message).includes("SameSite=None require Secure")) throw error;
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

try {
  createCommentHandler({
    store: {
      async list() {
        return { comments: [], count: 0, nextCursor: null };
      },
      async add() {
        return { comments: [], count: 0, nextCursor: null };
      }
    },
    security: {
      rateLimit: {
        allowInMemory: "false"
      }
    }
  });
  throw new Error("expected string false in-memory rate limit opt-in not to enable unsafe mode");
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

{
  const tmp = mkdtempSync(join(tmpdir(), "jcomment-reset-index-"));
  try {
    const dbPath = join(tmp, "jcomment.sqlite3");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table sessions (token text primary key, site text not null, account_id text not null, username text not null, created_at text not null, expires_at integer not null default 0);
      create table reset_tokens (token text primary key, account_id text not null, site text not null, expires_at integer not null);
      insert into sessions (token, site, account_id, username, created_at, expires_at) values
        ('sha256:session', 'default', 'account-1', 'Ada', '2026-01-01T00:00:00.000Z', 0);
      insert into reset_tokens (token, account_id, site, expires_at) values
        ('sha256:old', 'account-1', 'default', strftime('%s','now') * 1000 + 60000),
        ('sha256:new', 'account-1', 'default', strftime('%s','now') * 1000 + 60000);
    `);
    db.close();
    createSqliteStore({ path: dbPath });
    const check = new DatabaseSync(dbPath);
    const rows = Number(check.prepare("select count(*) as count from reset_tokens where account_id = 'account-1' and site = 'default'").get().count);
    const sessions = Number(check.prepare("select count(*) as count from sessions where token = 'sha256:session' and expires_at > 0").get().count);
    const index = check.prepare("select 1 from sqlite_master where type = 'index' and name = 'reset_tokens_account_site_idx'").get();
    check.close();
    if (rows !== 1 || sessions !== 1 || !index) {
      throw new Error("expected SQLite reset-token migration to enforce one pending token per account");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "jcomment-parent-id-migration-"));
  try {
    const dbPath = join(tmp, "jcomment.sqlite3");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table comments (id text primary key, site text not null default 'default', thread text not null, author text not null, body text not null, created_at text not null, score integer not null default 0);
      insert into comments (id, site, thread, author, body, created_at, score) values
        ('legacy-comment', 'default', 'legacy-thread', 'Ada', 'Legacy root', '2026-01-01T00:00:00.000Z', 0);
    `);
    db.close();
    const store = createSqliteStore({ path: dbPath });
    const payload = await store.list("default", "legacy-thread");
    if (payload.comments[0]?.id !== "legacy-comment" || payload.comments[0]?.parentId !== "") {
      throw new Error("expected SQLite comments parent_id migration to preserve legacy root comments");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "jcomment-unsafe-dir-"));
  try {
    chmodSync(tmp, 0o777);
    try {
      createSqliteStore({ path: join(tmp, "jcomment.sqlite3") });
      throw new Error("expected group/world-writable SQLite directory to be rejected");
    } catch (error) {
      if (!String(error.message).includes("database directory must not be group- or world-writable")) throw error;
    }
  } finally {
    chmodSync(tmp, 0o700);
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "jcomment-dir-symlink-"));
  try {
    const target = join(tmp, "target");
    const link = join(tmp, "link");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link);
    try {
      createSqliteStore({ path: join(link, "jcomment.sqlite3") });
      throw new Error("expected symlinked SQLite directory to be rejected");
    } catch (error) {
      if (!String(error.message).includes("database directory must not be a symlink")) throw error;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "jcomment-parent-symlink-"));
  try {
    const target = join(tmp, "target");
    const link = join(tmp, "link");
    mkdirSync(join(target, "nested"), { recursive: true, mode: 0o700 });
    symlinkSync(target, link);
    try {
      createSqliteStore({ path: join(link, "nested", "jcomment.sqlite3") });
      throw new Error("expected symlinked SQLite parent directory to be rejected");
    } catch (error) {
      if (!String(error.message).includes("database directory must not be a symlink")) throw error;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "jcomment-symlink-"));
  try {
    const linkPath = join(tmp, "linked.sqlite3");
    symlinkSync(join(tmp, "target.sqlite3"), linkPath);
    try {
      createSqliteStore({ path: linkPath });
      throw new Error("expected symlinked SQLite path to be rejected");
    } catch (error) {
      if (!String(error.message).includes("must not be symlinks")) throw error;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), "jcomment-sidecar-symlink-"));
  try {
    const dbPath = join(tmp, "jcomment.sqlite3");
    symlinkSync(join(tmp, "target.wal"), `${dbPath}-wal`);
    try {
      createSqliteStore({ path: dbPath });
      throw new Error("expected symlinked SQLite sidecar path to be rejected");
    } catch (error) {
      if (!String(error.message).includes("sidecar paths must not be symlinks")) throw error;
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

response = await handler(new Request(`http://example.test/api/comments?thread=${"x".repeat(9000)}`));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Request metadata is too large") {
  throw new Error("expected oversized request URL metadata to be rejected");
}

response = await handler(new Request(url, {
  headers: { cookie: `jcomment_session=${"x".repeat(9000)}` }
}));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Request metadata is too large") {
  throw new Error("expected oversized request header metadata to be rejected");
}

const aggregateHeaders = new Headers();
for (let i = 0; i < 140; i += 1) aggregateHeaders.set(`x-pad-${i}`, "x".repeat(80));
response = await handler(new Request(url, {
  headers: aggregateHeaders
}));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Request metadata is too large") {
  throw new Error("expected oversized aggregate request metadata to be rejected");
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

response = await handler(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: new Uint8Array([0x7b, 0x22, 0x61, 0x75, 0x74, 0x68, 0x6f, 0x72, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x2c, 0x22, 0x62, 0x6f, 0x64, 0x79, 0x22, 0x3a, 0x22, 0x48, 0x69, 0x22, 0x7d])
}));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Invalid request body") {
  throw new Error("expected invalid UTF-8 JSON body to be rejected");
}

response = await handler(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json", "content-length": "+2" },
  body: "{}"
}));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Invalid request body") {
  throw new Error("expected plus-prefixed content-length to be rejected");
}

response = await handler(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json", "content-length": "1_0" },
  body: "{}"
}));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Invalid request body") {
  throw new Error("expected underscore content-length to be rejected");
}

response = await handler(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json", "content-length": "2" },
  body: "{} "
}));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Invalid request body") {
  throw new Error("expected overlong body compared to content-length to be rejected");
}

response = await handler(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json", "content-length": "4" },
  body: "{}"
}));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Invalid request body") {
  throw new Error("expected short body compared to content-length to be rejected");
}

response = await handler(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "null"
}));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Invalid JSON") {
  throw new Error("expected JSON null request body to be rejected");
}

response = await handler(new Request(url, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: "[]"
}));
payload = await response.json();
if (response.status !== 400 || payload.error !== "Invalid JSON") {
  throw new Error("expected JSON array request body to be rejected");
}

response = await handler(new Request(`${url}&sort=oldest`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Grace", body: "A reply", parentId })
}));
payload = await response.json();
if (response.status !== 201 || payload.comments.length !== 2 || payload.comments[0].replyCount !== 1) {
  throw new Error("expected reply creation");
}

response = await handler(new Request(`${url}&cursor=1junk&limit=1`));
payload = await response.json();
if (response.status !== 200 || payload.comments[0]?.id !== parentId) {
  throw new Error("expected malformed cursor to fall back instead of being partially parsed");
}

response = await handler(new Request(`${url}&cursor=1e2&limit=1`));
payload = await response.json();
if (response.status !== 200 || payload.comments[0]?.id !== parentId) {
  throw new Error("expected scientific-notation cursor to fall back");
}

response = await handler(new Request(`${url}&cursor=+1&limit=1`));
payload = await response.json();
if (response.status !== 200 || payload.comments[0]?.id !== parentId) {
  throw new Error("expected plus-prefixed cursor to fall back");
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

const malformedIpHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.10, 198.51.100.10"
});
response = await malformedIpHandler(new Request("http://example.test/api/comments?thread=bad-ip", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "Bad IP metadata" })
}));
if (response.status !== 503) {
  throw new Error("expected malformed client IP metadata to fail closed for rate limiting");
}

const scientificIpHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "1e2.0.0.1"
});
response = await scientificIpHandler(new Request("http://example.test/api/comments?thread=bad-ip", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "Scientific IP metadata" })
}));
if (response.status !== 503) {
  throw new Error("expected non-decimal IPv4 metadata to fail closed for rate limiting");
}

const malformedLocalhostHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "127.evil"
});
response = await malformedLocalhostHandler(new Request("http://example.test/api/comments?thread=bad-ip", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "Malformed localhost metadata" })
}));
if (response.status !== 503) {
  throw new Error("expected malformed localhost-like metadata to fail closed for rate limiting");
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
  body: JSON.stringify({ username: "ad\nmin", password: "correct horse battery staple" })
}));
if (response.status !== 400) {
  throw new Error("expected control characters in account username to be rejected");
}

response = await handler(new Request("http://example.test/api/comments/signup?site=check-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin\uFE0F", password: "correct horse battery staple" })
}));
if (response.status !== 400) {
  throw new Error("expected variation selectors in account username to be rejected");
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

response = await handler(new Request("http://example.test/api/comments/anything/login?site=check-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
if (response.status !== 404 || payload.error !== "Not found") {
  throw new Error("expected shared handler to reject nested API login path");
}

response = await handler(new Request("http://example.test/api/comments/login?site=check-site", {
  method: "PATCH",
  headers: { "content-type": "text/plain", "content-length": "+2" },
  body: "{}"
}));
payload = await response.json();
if (response.status !== 405 || payload.error !== "Method not allowed") {
  throw new Error("expected unsupported auth route method to be rejected before unsafe body validation");
}

response = await handler(new Request("http://example.test/api/comments?thread=check", {
  method: "PUT",
  headers: { "content-type": "text/plain", "content-length": "+2" },
  body: "{}"
}));
payload = await response.json();
if (response.status !== 405 || payload.error !== "Method not allowed") {
  throw new Error("expected unsupported comment method to be rejected before unsafe body validation");
}

const customPathHandler = createCommentHandler({
  store: createMemoryStore(),
  apiPath: "/comments",
  getClientIp: () => "203.0.113.124"
});
response = await customPathHandler(new Request("http://example.test/comments?thread=custom", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "Custom path" })
}));
if (response.status !== 201) {
  throw new Error("expected configured custom API path to work");
}
response = await customPathHandler(new Request("http://example.test/api/comments?thread=custom"));
payload = await response.json();
if (response.status !== 404 || payload.error !== "Not found") {
  throw new Error("expected default API path to be rejected when a custom API path is configured");
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
assertNoStore(response, "duplicate signup response");
payload = await response.json();
if (response.status !== 202 || payload.token || payload.ok !== true) {
  throw new Error("expected duplicate signup to avoid account existence disclosure");
}

const postLoginHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.20",
  cors: "*",
  site: "post-site",
  posting: {
    requireLogin: true
  },
  security: {
    sessionCookie: {
      enabled: false
    }
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
const stringRequireLoginHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.125",
  posting: {
    requireLogin: "true"
  }
});
response = await stringRequireLoginHandler(new Request("http://example.test/api/comments?thread=post-login-string", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "String true require-login should fail without login" })
}));
payload = await response.json();
if (response.status !== 401 || payload.error !== "Login is required to post comments") {
  throw new Error("expected string true require-login config to require login");
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
    },
    csrf: {
      trustedOrigins: ["https://trusted.example.test"]
    }
  }
});
response = await cookieHandler(new Request("http://example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "CookieUser", password: "correct horse battery staple" })
}));
assertNoStore(response, "cookie signup response");
payload = await response.json();
const sessionCookie = response.headers.get("set-cookie");
if (response.status !== 201 || payload.token || !sessionCookie?.includes("HttpOnly")) {
  throw new Error("expected HttpOnly cookie session without exposed bearer token");
}

const brokenCookieExposeWarnings = [];
console.warn = message => brokenCookieExposeWarnings.push(message);
const brokenCookieExposeHandler = createCommentHandler({
  store: createMemoryStore(),
  cors: "*",
  brokenConfig: true,
  getClientIp: () => "203.0.113.121",
  site: "broken-cookie-expose-site",
  voteIdentity: {
    accounts: {
      discloseAccountExistence: true
    }
  },
  security: {
    sessionCookie: {
      enabled: true,
      secure: false,
      exposeToken: true
    }
  }
});
console.warn = originalWarn;
if (!brokenCookieExposeWarnings.some(message => message.includes("BROKEN_CONFIG=1 is unsupported"))) {
  throw new Error("expected broken cookie token exposure config warning");
}
response = await brokenCookieExposeHandler(new Request("http://example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "BrokenCookieExpose", password: "correct horse battery staple" })
}));
payload = await response.json();
if (response.status !== 201 || payload.token || !response.headers.get("set-cookie")?.includes("HttpOnly")) {
  throw new Error("expected broken cookie token exposure config not to expose bearer token in JSON");
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
  headers: {
    "content-type": "application/json",
    cookie: `jcomment_session=%E0%A4%A; ${sessionCookie.split(";")[0]}`,
    "sec-fetch-site": "same-origin"
  },
  body: JSON.stringify({ author: "Mallory", body: "Posted despite malformed shadow cookie" })
}));
payload = await response.json();
if (response.status !== 201 || payload.comments[0].author !== "CookieUser") {
  throw new Error("expected valid session cookie after malformed cookie to authenticate");
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
  headers: { "content-type": "application/json", cookie: "jcomment_session=%E0%A4%A" },
  body: JSON.stringify({ author: "Mallory", body: "Malformed cookie without metadata should fail" })
}));
if (response.status !== 403) {
  throw new Error("expected malformed session cookie without origin metadata to be rejected");
}
response = await cookieHandler(new Request("http://example.test/api/comments?thread=cookie-post", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: sessionCookie.split(";")[0], "sec-fetch-site": "same-site" },
  body: JSON.stringify({ author: "Mallory", body: "Same-site sibling post should fail" })
}));
if (response.status !== 403) {
  throw new Error("expected same-site cookie-authenticated post without origin to be rejected");
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
    "content-type": "application/json",
    cookie: sessionCookie.split(";")[0],
    origin: "chrome-extension://abcdefghijklmnop"
  },
  body: JSON.stringify({ author: "Mallory", body: "Extension-origin post should fail" })
}));
if (response.status !== 403) {
  throw new Error("expected non-http origin cookie-authenticated post to be rejected");
}
response = await cookieHandler(new Request("http://example.test/api/comments?thread=cookie-post", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie: sessionCookie.split(";")[0],
    origin: "https://trusted.example.test/path"
  },
  body: JSON.stringify({ author: "Mallory", body: "Path-bearing origin should fail" })
}));
if (response.status !== 403) {
  throw new Error("expected path-bearing origin metadata to be rejected");
}
response = await cookieHandler(new Request("http://example.test/api/comments?thread=cookie-post", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie: sessionCookie.split(";")[0],
    origin: "https://trusted.example.test"
  },
  body: JSON.stringify({ author: "Mallory", body: "Trusted-origin post" })
}));
payload = await response.json();
if (response.status !== 201 || payload.comments[0].author !== "CookieUser") {
  throw new Error("expected exact configured CSRF trusted origin to be allowed");
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
  cors: "*",
  site: "reset-site",
  posting: { requireLogin: true },
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
    sessionCookie: {
      enabled: false
    },
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
response = await resetHandler(new Request("http://example.test/api/comments/login?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Lin", password: "old password value" })
}));
payload = await response.json();
const preResetToken = payload.token;
if (response.status !== 201 || !preResetToken) {
  throw new Error("expected login before reset");
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
response = await resetHandler(new Request("http://example.test/api/comments?thread=reset-post", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${preResetToken}` },
  body: JSON.stringify({ author: "Lin", body: "Old reset session should fail" })
}));
if (response.status !== 401) {
  throw new Error("expected password reset to invalidate existing sessions");
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

response = await resetHandler(new Request("http://example.test/api/comments/signup?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Race", email: "race@example.test", password: "old password value" })
}));
if (response.status !== 202) {
  throw new Error("expected reset-race signup");
}
response = await resetHandler(new Request("http://example.test/api/comments/reset/request?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Race", email: "race@example.test" })
}));
const raceResetToken = resetTokens.at(-1);
if (response.status !== 201 || !raceResetToken) {
  throw new Error("expected reset-race token");
}
const raceResults = await Promise.all([
  resetHandler(new Request("http://example.test/api/comments/reset/confirm?site=reset-site", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: raceResetToken, password: "first race password" })
  })),
  resetHandler(new Request("http://example.test/api/comments/reset/confirm?site=reset-site", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: raceResetToken, password: "second race password" })
  }))
]);
const raceStatuses = raceResults.map(result => result.status).sort();
if (raceStatuses[0] !== 201 || raceStatuses[1] !== 400) {
  throw new Error("expected concurrent password reset confirmations to consume the token once");
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
  response = await failedResetHandler(new Request("http://example.test/api/comments/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Lin", email: "lin@example.test", password: "old password value" })
  }));
  if (response.status !== 202) {
    throw new Error("expected failed-reset signup");
  }
  const savedError = console.error;
  const loggedErrors = [];
  console.error = message => loggedErrors.push(String(message));
  response = await failedResetHandler(new Request("http://example.test/api/comments/reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Lin", email: "lin@example.test" })
  }));
  console.error = savedError;
  if (response.status !== 201 || failedResetTokens.length !== 1) {
    throw new Error("expected failed reset delivery to keep returning a generic success response");
  }
  if (loggedErrors.some(message => message.includes(failedResetTokens[0]))) {
    throw new Error("expected failed reset delivery logging not to expose the raw reset token");
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
try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      ipStorage: {
        enabled: true,
        denyRanges: ["203.0.113.0/not-a-prefix"]
      }
    }
  });
  throw new Error("expected malformed IP deny range config to throw");
} catch (error) {
  if (!String(error.message).includes("denyRanges contains invalid range")) throw error;
}

try {
  createCommentHandler({
    store: createMemoryStore(),
    voteIdentity: {
      ipStorage: {
        enabled: true,
        allowRanges: ["[::1"]
      }
    }
  });
  throw new Error("expected malformed bracketed IP range config to throw");
} catch (error) {
  if (!String(error.message).includes("allowRanges contains invalid range")) throw error;
}

const stringFalseIpHandler = createCommentHandler({
  store: createMemoryStore({
    ip: [{ id: "ip-comment", author: "Ada", body: "IP-limited", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  getClientIp: () => "203.0.113.7",
  voteIdentity: {
    login: { enabled: false },
    ipStorage: {
      enabled: "false"
    }
  }
});
response = await stringFalseIpHandler(new Request(ipUrl, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "ip-comment", action: "upvote" })
}));
payload = await response.json();
if (response.status !== 403 || payload.error !== "Voting is unavailable from this network") {
  throw new Error("expected string false IP storage config not to enable IP voting");
}

const oversizedIpHandler = createCommentHandler({
  store: createMemoryStore(),
  getClientIp: () => "203.0.113.".repeat(1000),
  security: {
    rateLimit: {
      allowInMemory: true
    }
  }
});
response = await oversizedIpHandler(new Request("http://example.test/api/comments?thread=oversized-ip", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Ada", body: "Huge callback IP should fail closed" })
}));
payload = await response.json();
if (response.status !== 503 || payload.error !== "Server rate limit identity is not configured") {
  throw new Error("expected oversized client IP callback output to be rejected before rate-limited writes");
}

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

const malformedBracketIpHandler = createCommentHandler({
  store: createMemoryStore({
    ip: [{ id: "ip-comment", author: "Ada", body: "IP-limited", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  getClientIp: () => "[::1",
  voteIdentity: {
    login: { enabled: false },
    ipStorage: {
      enabled: true,
      localhost: true
    }
  }
});
response = await malformedBracketIpHandler(new Request(ipUrl, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "ip-comment", action: "upvote" })
}));
payload = await response.json();
if (response.status !== 503 || payload.error !== "Server rate limit identity is not configured") {
  throw new Error("expected malformed bracketed localhost IP to fail closed");
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

const multiHandler = createCommentHandler({
  store: createMemoryStore(),
  cors: "*",
  site: "multi-site",
  getClientIp: () => "203.0.113.33",
  security: {
    sessionCookie: {
      enabled: false
    }
  }
});
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

try {
  createCommentHandler({ store: createMemoryStore(), site: "bad\tsite" });
  throw new Error("expected configured site with control characters to be rejected");
} catch (error) {
  if (!String(error.message).includes("site must not contain control characters")) throw error;
}

try {
  createCommentHandler({ store: createMemoryStore(), site: " padded-site" });
  throw new Error("expected whitespace-padded configured site to be rejected");
} catch (error) {
  if (!String(error.message).includes("site must not contain control characters")) throw error;
}

{
  try {
    jcommentExpress({ store: createMemoryStore() });
    throw new Error("expected Express adapter without trusted host config to throw");
  } catch (error) {
    if (!String(error.message).includes("requires publicOrigin when session cookies are auto-enabled")) throw error;
  }

  try {
    jcommentExpress({
      store: createMemoryStore(),
      allowedHosts: ["comments.example.test"]
    });
    throw new Error("expected Express adapter to reject allowedHosts-only auto cookie config");
  } catch (error) {
    if (!String(error.message).includes("requires publicOrigin when session cookies are auto-enabled")) throw error;
  }

  jcommentExpress({
    store: createMemoryStore(),
    security: {
      sessionCookie: {
        enabled: false
      }
    }
  });

  jcommentExpress({
    store: createMemoryStore(),
    security: {
      sessionCookie: {
        enabled: "false"
      }
    }
  });

  try {
    jcommentExpress({
      store: createMemoryStore(),
      allowedHosts: ["comments.example.test"],
      security: {
        sessionCookie: {
          enabled: "AUTO"
        }
      }
    });
    throw new Error("expected Express adapter to reject uppercase auto cookie config without publicOrigin");
  } catch (error) {
    if (!String(error.message).includes("requires publicOrigin when session cookies are auto-enabled")) throw error;
  }

  jcommentExpress({
    store: createMemoryStore(),
    allowedHosts: ["comments.example.test"],
    security: {
      sessionCookie: {
        enabled: true
      }
    }
  });

  try {
    jcommentExpress({
      store: createMemoryStore(),
      publicOrigin: "https://comments.example.test/api"
    });
    throw new Error("expected Express adapter to reject path-bearing publicOrigin");
  } catch (error) {
    if (!String(error.message).includes("publicOrigin must be an absolute http(s) origin")) throw error;
  }

  try {
    jcommentExpress({
      store: createMemoryStore(),
      security: {
        sessionCookie: {
          enabled: false
        }
      },
      allowedHosts: "comments.example.test"
    });
    throw new Error("expected Express adapter to reject string allowedHosts");
  } catch (error) {
    if (!String(error.message).includes("allowedHosts must be an array")) throw error;
  }

  try {
    jcommentExpress({
      store: createMemoryStore(),
      security: {
        sessionCookie: {
          enabled: false
        }
      },
      allowedHosts: ["comments.example.test/path"]
    });
    throw new Error("expected Express adapter to reject path-bearing allowedHosts entry");
  } catch (error) {
    if (!String(error.message).includes("allowedHosts must contain host names")) throw error;
  }

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
  assertExpressNoStore(badHostRes, "Express bad Host response");
  const okRes = fakeExpressResponse();
  await route(fakeExpressRequest({ host: "comments.example.test" }), okRes, error => { throw error; });
  if (okRes.statusCode !== 200 || !String(okRes.body || "").includes("\"comments\"")) {
    throw new Error("expected Express adapter to use configured public origin with allowed Host");
  }
  const absoluteUrlRes = fakeExpressResponse();
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "POST",
    originalUrl: "https://attacker.example.test/api/comments",
    headers: {
      "content-type": "application/json",
      cookie: "jcomment_session=spoofed",
      origin: "https://attacker.example.test"
    },
    body: { author: "Ada", body: "absolute-form origin" }
  }), absoluteUrlRes, error => { throw error; });
  if (absoluteUrlRes.statusCode !== 400) {
    throw new Error("expected Express adapter to reject mismatched absolute-form request URL origins");
  }
  const schemeRelativeUrlRes = fakeExpressResponse();
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "POST",
    originalUrl: "//attacker.example.test/api/comments/login",
    headers: {
      "content-type": "application/json"
    },
    body: { username: "Ada", password: "correct horse battery staple" }
  }), schemeRelativeUrlRes, error => { throw error; });
  if (schemeRelativeUrlRes.statusCode !== 400) {
    throw new Error("expected Express adapter to reject mismatched scheme-relative request URL origins");
  }
  const malformedUrlRes = fakeExpressResponse();
  let malformedUrlNextCalled = false;
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "GET",
    originalUrl: "http://[::1"
  }), malformedUrlRes, () => { malformedUrlNextCalled = true; });
  if (malformedUrlNextCalled || malformedUrlRes.statusCode !== 400) {
    throw new Error("expected Express adapter to reject malformed absolute request URLs without throwing");
  }
  const oversizedExpressUrlRes = fakeExpressResponse();
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "GET",
    originalUrl: `/api/comments?thread=${"x".repeat(9000)}`
  }), oversizedExpressUrlRes, error => { throw error; });
  if (oversizedExpressUrlRes.statusCode !== 400 || !String(oversizedExpressUrlRes.body || "").includes("Request metadata is too large")) {
    throw new Error("expected Express adapter to reject oversized request URLs");
  }
  assertExpressNoStore(oversizedExpressUrlRes, "Express oversized URL response");
  const oversizedExpressHeaderRes = fakeExpressResponse();
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "GET",
    headers: {
      cookie: `jcomment_session=${"x".repeat(9000)}`
    }
  }), oversizedExpressHeaderRes, error => { throw error; });
  if (oversizedExpressHeaderRes.statusCode !== 400 || !String(oversizedExpressHeaderRes.body || "").includes("Request metadata is too large")) {
    throw new Error("expected Express adapter to reject oversized request headers");
  }
  const manyExpressHeaders = {};
  for (let i = 0; i < 140; i += 1) manyExpressHeaders[`x-pad-${i}`] = "x".repeat(80);
  const aggregateExpressHeaderRes = fakeExpressResponse();
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "GET",
    headers: manyExpressHeaders
  }), aggregateExpressHeaderRes, error => { throw error; });
  if (aggregateExpressHeaderRes.statusCode !== 400 || !String(aggregateExpressHeaderRes.body || "").includes("Request metadata is too large")) {
    throw new Error("expected Express adapter to reject oversized aggregate request metadata");
  }
  assertExpressNoStore(aggregateExpressHeaderRes, "Express oversized metadata response");
  const unsupportedExpressMethodRes = fakeExpressResponse();
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "PUT",
    headers: { "content-type": "text/plain", "content-length": "+2" },
    body: {
      toJSON() {
        throw new Error("unsupported Express methods must not serialize body");
      }
    }
  }), unsupportedExpressMethodRes, error => { throw error; });
  if (unsupportedExpressMethodRes.statusCode !== 405 || !String(unsupportedExpressMethodRes.body || "").includes("Method not allowed")) {
    throw new Error("expected Express adapter to reject unsupported methods before body serialization");
  }
  assertExpressNoStore(unsupportedExpressMethodRes, "Express unsupported method response");
  const routeUnsupportedExpressMethodRes = fakeExpressResponse();
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "PATCH",
    originalUrl: "/api/comments/login",
    headers: { "content-type": "text/plain", "content-length": "+2" },
    body: {
      toJSON() {
        throw new Error("Express route-specific method rejection must not serialize body");
      }
    }
  }), routeUnsupportedExpressMethodRes, error => { throw error; });
  if (routeUnsupportedExpressMethodRes.statusCode !== 405 || !String(routeUnsupportedExpressMethodRes.body || "").includes("Method not allowed")) {
    throw new Error("expected Express adapter to reject route-specific unsupported methods before body serialization");
  }
  assertExpressNoStore(routeUnsupportedExpressMethodRes, "Express route-specific unsupported method response");
  const invalidExpressPathRes = fakeExpressResponse();
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "POST",
    originalUrl: "/api/comments/anything/login",
    headers: { "content-type": "text/plain", "content-length": "+2" },
    body: {
      toJSON() {
        throw new Error("Express invalid API paths must not serialize body");
      }
    }
  }), invalidExpressPathRes, error => { throw error; });
  if (invalidExpressPathRes.statusCode !== 404 || !String(invalidExpressPathRes.body || "").includes("Not found")) {
    throw new Error("expected Express adapter to reject invalid API paths before body serialization");
  }
  assertExpressNoStore(invalidExpressPathRes, "Express invalid path response");
  const sameOriginAbsoluteUrlRes = fakeExpressResponse();
  await route(fakeExpressRequest({
    host: "comments.example.test",
    method: "GET",
    originalUrl: "https://comments.example.test/api/comments?thread=absolute-form"
  }), sameOriginAbsoluteUrlRes, error => { throw error; });
  if (sameOriginAbsoluteUrlRes.statusCode !== 200 || !String(sameOriginAbsoluteUrlRes.body || "").includes("\"comments\"")) {
    throw new Error("expected Express adapter to allow canonical same-origin absolute-form request URLs");
  }

  const trailingApiPathRoute = jcommentExpress({
    store: createMemoryStore(),
    publicOrigin: "https://comments.example.test",
    allowedHosts: ["comments.example.test"],
    apiPath: "/comments/"
  });
  const trailingApiPathRes = fakeExpressResponse();
  await trailingApiPathRoute(fakeExpressRequest({
    host: "comments.example.test",
    originalUrl: "/comments?thread=express-trailing"
  }), trailingApiPathRes, error => { throw error; });
  if (trailingApiPathRes.statusCode !== 200 || !String(trailingApiPathRes.body || "").includes("\"comments\"")) {
    throw new Error("expected Express adapter prechecks to use normalized trailing-slash apiPath");
  }
  const trailingApiPathMethodRes = fakeExpressResponse();
  await trailingApiPathRoute(fakeExpressRequest({
    host: "comments.example.test",
    method: "PATCH",
    originalUrl: "/comments/login",
    headers: { "content-type": "text/plain", "content-length": "+2" },
    body: {
      toJSON() {
        throw new Error("Express normalized apiPath method rejection must not serialize body");
      }
    }
  }), trailingApiPathMethodRes, error => { throw error; });
  if (trailingApiPathMethodRes.statusCode !== 405 || !String(trailingApiPathMethodRes.body || "").includes("Method not allowed")) {
    throw new Error("expected Express adapter route guard to match normalized trailing-slash apiPath routes");
  }
  assertExpressNoStore(trailingApiPathMethodRes, "Express normalized apiPath method response");

  const rootApiPathRoute = jcommentExpress({
    store: createMemoryStore(),
    publicOrigin: "https://comments.example.test",
    allowedHosts: ["comments.example.test"],
    apiPath: "/"
  });
  const rootApiPathRes = fakeExpressResponse();
  await rootApiPathRoute(fakeExpressRequest({
    host: "comments.example.test",
    method: "POST",
    originalUrl: "/signup",
    headers: { "content-type": "application/json" },
    body: { username: "RootAda", password: "correct horse battery staple" }
  }), rootApiPathRes, error => { throw error; });
  if (rootApiPathRes.statusCode < 200 || rootApiPathRes.statusCode >= 300) {
    throw new Error("expected Express adapter prechecks to use normalized root apiPath routes");
  }
}

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-netlify-")), "comments.sqlite3")
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://attacker.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("requires JCOMMENT_PUBLIC_ORIGIN")) {
    throw new Error("expected Netlify adapter to require a canonical public origin for cookie-capable deployments");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: "",
  JCOMMENT_SESSION_COOKIE_ENABLED: "1"
}, async () => {
  const { default: vercel } = await importFresh("../server/vercel.mjs");
  const res = await vercel(new Request("https://comments.example.test/api/comments", {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "ignored"
  }));
  const body = await res.json();
  if (res.status !== 405 || body.error !== "Method not allowed") {
    throw new Error("expected Vercel adapter to reject unsupported methods before storage/config errors");
  }
  if (res.headers.get("allow") !== "GET, POST, PATCH, OPTIONS") {
    throw new Error("expected Vercel adapter unsupported method response to include Allow header");
  }
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-vercel-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test"
}, async env => {
  const { default: vercel } = await importFresh("../server/vercel.mjs");
  const res = await vercel(new Request("https://attacker.example.test/api/comments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cookie": "jcomment_session=spoofed",
      "origin": "https://attacker.example.test"
    },
    body: JSON.stringify({ author: "Ada", body: "spoofed origin" })
  }));
  const body = await res.json();
  if (res.status !== 400 || body.error !== "Bad Request") {
    throw new Error("expected Vercel adapter to reject mismatched request URL origins");
  }
  const oversizedUrlRes = await vercel(new Request(`https://comments.example.test/api/comments?thread=${"x".repeat(9000)}`));
  const oversizedUrlBody = await oversizedUrlRes.json();
  if (oversizedUrlRes.status !== 400 || oversizedUrlBody.error !== "Request metadata is too large") {
    throw new Error("expected Vercel adapter to reject oversized request URLs before routing");
  }
  const oversizedHeaderRes = await vercel(new Request("https://comments.example.test/api/comments", {
    headers: {
      "x-real-ip": "203.0.113.10",
      cookie: `jcomment_session=${"x".repeat(9000)}`
    }
  }));
  const oversizedHeaderBody = await oversizedHeaderRes.json();
  if (oversizedHeaderRes.status !== 400 || oversizedHeaderBody.error !== "Request metadata is too large") {
    throw new Error("expected Vercel adapter to reject oversized request headers before routing");
  }
  const aggregateVercelHeaders = new Headers();
  for (let i = 0; i < 140; i += 1) aggregateVercelHeaders.set(`x-pad-${i}`, "x".repeat(80));
  const aggregateHeaderRes = await vercel(new Request("https://comments.example.test/api/comments", {
    headers: aggregateVercelHeaders
  }));
  const aggregateHeaderBody = await aggregateHeaderRes.json();
  if (aggregateHeaderRes.status !== 400 || aggregateHeaderBody.error !== "Request metadata is too large") {
    throw new Error("expected Vercel adapter to reject oversized aggregate request metadata before routing");
  }
  const alternateHostLoginRes = await vercel(new Request("https://attacker.example.test/api/comments/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin"
    },
    body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
  }));
  const alternateHostLoginBody = await alternateHostLoginRes.json();
  if (alternateHostLoginRes.status !== 400 || alternateHostLoginBody.error !== "Bad Request") {
    throw new Error("expected Vercel adapter to reject same-origin metadata from alternate hosts");
  }
  const nestedRes = await vercel(new Request("https://comments.example.test/api/comments/anything/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
  }));
  const nestedBody = await nestedRes.json();
  if (nestedRes.status !== 404 || nestedBody.error !== "Not found") {
    throw new Error("expected Vercel adapter to reject nested API login paths");
  }
  const unsupportedRouteMethodRes = await vercel(new Request("https://comments.example.test/api/comments/login", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
  }));
  const unsupportedRouteMethodBody = await unsupportedRouteMethodRes.json();
  if (unsupportedRouteMethodRes.status !== 405 || unsupportedRouteMethodBody.error !== "Method not allowed") {
    throw new Error("expected Vercel adapter to reject route-specific unsupported methods before handler dispatch");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-netlify-origin-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://attacker.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 400 || body.error !== "Bad Request") {
    throw new Error("expected Netlify adapter to reject mismatched request URL origins");
  }
  const unsupportedRes = await netlify(new Request("https://comments.example.test/api/comments/reset/request", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Ada", email: "ada@example.test" })
  }));
  const unsupportedBody = await unsupportedRes.json();
  if (unsupportedRes.status !== 405 || unsupportedBody.error !== "Method not allowed") {
    throw new Error("expected Netlify adapter to reject route-specific unsupported methods before handler dispatch");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-netlify-context-ip-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  let res;
  for (let i = 0; i < 6; i += 1) {
    res = await netlify(new Request("https://comments.example.test/api/comments/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nf-client-connection-ip": `198.51.100.${i + 1}`
      },
      body: JSON.stringify({ username: `NetlifyContextIp${i}`, password: "correct horse battery staple" })
    }), { ip: "203.0.113.77" });
  }
  const body = await res.json();
  if (res.status !== 429 || body.error !== "Too many requests") {
    throw new Error("expected Netlify adapter to prefer context.ip over spoofable request IP headers for rate limits");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-netlify-internal-ip-spoof-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  let res;
  for (let i = 0; i < 6; i += 1) {
    res = await netlify(new Request("https://comments.example.test/api/comments/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jcomment-client-ip": "203.0.113.88",
        "x-nf-client-connection-ip": `198.51.100.${i + 10}`
      },
      body: JSON.stringify({ username: `NetlifySpoofedInternalIp${i}`, password: "correct horse battery staple" })
    }));
  }
  const body = await res.json();
  if (res.status === 429 && body.error === "Too many requests") {
    throw new Error("expected Netlify adapter to ignore client-supplied internal IP headers");
  }
  if (res.status !== 202) {
    throw new Error("expected Netlify signup to use platform IP header fallback when context.ip is absent");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-public-origin-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test/api"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_PUBLIC_ORIGIN must be an absolute http(s) origin")) {
    throw new Error("expected serverless adapter to reject path-bearing public origin");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-oversized-env-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SESSION_COOKIE_NAME: "jcomment_" + "x".repeat(9000)
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SESSION_COOKIE_NAME must not exceed 8192 bytes")) {
    throw new Error("expected serverless adapter to fail closed on oversized env metadata");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: `${"x".repeat(5000)}.sqlite3`,
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test"
}, async () => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_DB must not exceed 4096 bytes")) {
    throw new Error("expected serverless adapter to fail closed on oversized database path env");
  }
});

{
  const unsafeDbDir = mkdtempSync(join(tmpdir(), "jcomment-serverless-unsafe-db-"));
  try {
    chmodSync(unsafeDbDir, 0o777);
    await withEnv({
      JCOMMENT_DB: join(unsafeDbDir, "comments.sqlite3"),
      JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test"
    }, async () => {
      const { default: netlify } = await importFresh("../server/netlify.mjs");
      const res = await netlify(new Request("https://comments.example.test/api/comments"));
      const body = await res.json();
      if (
        res.status !== 500 ||
        body.error !== "Netlify adapter storage was not initialized." ||
        String(body.error || "").includes(unsafeDbDir)
      ) {
        throw new Error("expected Netlify adapter to hide storage initialization details");
      }
    });
  } finally {
    chmodSync(unsafeDbDir, 0o700);
    rmSync(unsafeDbDir, { recursive: true, force: true });
  }
}

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-site-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SITE: "bad\tsite"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SITE must not contain control characters")) {
    throw new Error("expected serverless adapter to fail closed on malformed site env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-padded-site-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SITE: " padded-site"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SITE must not contain control characters")) {
    throw new Error("expected serverless adapter to fail closed on whitespace-padded site env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-cookie-bool-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SESSION_COOKIE_ENABLED: "maybe"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SESSION_COOKIE_ENABLED")) {
    throw new Error("expected serverless adapter to fail closed on malformed cookie enabled env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-padded-cookie-bool-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SESSION_COOKIE_SECURE: "0 "
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SESSION_COOKIE_SECURE")) {
    throw new Error("expected serverless adapter to fail closed on whitespace-padded boolean env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-cookie-name-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SESSION_COOKIE_NAME: "bad name"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SESSION_COOKIE_NAME must be a valid cookie name")) {
    throw new Error("expected serverless adapter to fail closed on malformed cookie name env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-padded-cookie-name-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SESSION_COOKIE_NAME: " jcomment_session"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SESSION_COOKIE_NAME must be a valid cookie name")) {
    throw new Error("expected serverless adapter to fail closed on whitespace-padded cookie name env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-long-cookie-name-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SESSION_COOKIE_NAME: `jcomment_${"x".repeat(300)}`
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SESSION_COOKIE_NAME must be a valid cookie name")) {
    throw new Error("expected serverless adapter to fail closed on oversized cookie name env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-cookie-samesite-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SESSION_COOKIE_SAMESITE: "Sometimes"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SESSION_COOKIE_SAMESITE must be Strict, Lax, or None")) {
    throw new Error("expected serverless adapter to fail closed on malformed cookie SameSite env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-cookie-expose-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN: "1"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN is not supported")) {
    throw new Error("expected serverless adapter to fail closed on exposed cookie token env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-cookie-none-insecure-")), "comments.sqlite3"),
  JCOMMENT_PUBLIC_ORIGIN: "https://comments.example.test",
  JCOMMENT_SESSION_COOKIE_SAMESITE: "None",
  JCOMMENT_SESSION_COOKIE_SECURE: "0"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://comments.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 500 || !String(body.error || "").includes("JCOMMENT_SESSION_COOKIE_SAMESITE=None requires JCOMMENT_SESSION_COOKIE_SECURE=1")) {
    throw new Error("expected serverless adapter to fail closed on insecure SameSite=None cookie env");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

await withEnv({
  JCOMMENT_DB: join(mkdtempSync(join(tmpdir(), "jcomment-serverless-disabled-cookie-")), "comments.sqlite3"),
  JCOMMENT_SESSION_COOKIE_ENABLED: "0"
}, async env => {
  const { default: netlify } = await importFresh("../server/netlify.mjs");
  const res = await netlify(new Request("https://attacker.example.test/api/comments"));
  const body = await res.json();
  if (res.status !== 200 || !Array.isArray(body.comments)) {
    throw new Error("expected serverless adapter to allow missing public origin when session cookies are disabled");
  }
  rmSync(env.JCOMMENT_DB.replace(/\/comments\.sqlite3$/, ""), { recursive: true, force: true });
});

console.log("server handler ok");

function fakeExpressRequest({
  host,
  method = "GET",
  originalUrl = "/api/comments?thread=express",
  url = originalUrl,
  headers = {},
  body = {}
}) {
  return {
    method,
    protocol: "http",
    originalUrl,
    url,
    body,
    headers: { host, ...headers },
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

function assertNoStore(response, label) {
  if (
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("pragma") !== "no-cache" ||
    response.headers.get("x-content-type-options") !== "nosniff"
  ) {
    throw new Error(`expected ${label} to include hardened JSON headers`);
  }
}

function assertExpressNoStore(response, label) {
  if (
    response.headers["cache-control"] !== "no-store" ||
    response.headers.pragma !== "no-cache" ||
    response.headers["x-content-type-options"] !== "nosniff" ||
    response.headers["content-type"] !== "application/json; charset=utf-8"
  ) {
    throw new Error(`${label} must be marked no-store and nosniff`);
  }
}

async function importFresh(path) {
  const url = new URL(path, import.meta.url);
  url.searchParams.set("check", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

async function withEnv(values, fn) {
  const previous = new Map();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = values[key];
  }
  try {
    await fn(values);
  } finally {
    for (const key of Object.keys(values)) {
      if (previous.get(key) === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous.get(key);
      }
    }
  }
}
