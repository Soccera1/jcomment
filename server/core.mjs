export function createMemoryStore(seed = {}) {
  return createSqliteStore({ path: ":memory:", seed });
}

export function createSqliteStore({ path = process.env.JCOMMENT_DB || "jcomment.sqlite3", seed = {} } = {}) {
  path = normalizeSqlitePath(path);
  const DatabaseSync = getDatabaseSync();
  rejectUnsafeSqliteDirectory(path);
  rejectSqliteSymlink(path);
  const db = new DatabaseSync(path);
  initDb(db);
  rejectSqliteSymlink(path);
  secureSqliteFile(path);
  cleanupExpiredAuth(db);
  for (const [thread, comments] of Object.entries(seed)) {
    for (const comment of comments.map(normalizeComment)) {
      db.prepare("insert or ignore into comments (id, site, thread, parent_id, author, body, created_at, score) values (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(comment.id, "default", thread, comment.parentId, comment.author, comment.body, comment.createdAt, comment.score);
    }
  }

  return {
    async list(site, thread, options = {}) {
      return listThread(db, site, thread, options);
    },
    async add(site, thread, input) {
      const parentId = sanitizeText(input.parentId, 120);
      const comment = normalizeComment({
        id: crypto.randomUUID(),
        parentId,
        author: sanitizeText(input.author, 80) || "Anonymous",
        body: sanitizeText(input.body, 1800),
        createdAt: new Date().toISOString(),
        score: 0
      });
      if (!comment.body) throw statusError("Comment body is required", 400);
      db.exec("begin immediate");
      try {
        enforceCommentQuota(db, site, thread, input.quotas);
        if (parentId && !db.prepare("select 1 from comments where site = ? and thread = ? and id = ?").get(site, thread, parentId)) {
          throw statusError("Parent comment was not found", 404);
        }
        db.prepare("insert into comments (id, site, thread, parent_id, author, body, created_at, score) values (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(comment.id, site, thread, comment.parentId, comment.author, comment.body, comment.createdAt, comment.score);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return listThread(db, site, thread, { sort: input.sort, limit: input.limit, replyLimit: input.replyLimit });
    },
    async react(site, thread, id, delta = 1, options = {}) {
      const comment = db.prepare("select id, score from comments where site = ? and thread = ? and id = ?").get(site, thread, id);
      if (!comment) throw statusError("Comment was not found", 404);
      db.exec("begin immediate");
      try {
        rememberVote(db, site, thread, id, options.identity, options.maxVotesPerIdentity);
        db.prepare("update comments set score = max(-999999, min(999999, score + ?)) where site = ? and thread = ? and id = ?")
          .run(delta, site, thread, id);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return listThread(db, site, thread, options);
    },
    async signup(site, input, accountConfig) {
      const username = sanitizeAccountText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
	      const password = String(input.password || "");
	      if (username === null) throw statusError("Username contains invalid characters", 400);
	      if (!username) throw statusError("Username is required", 400);
	      if (isReservedUsername(username, accountConfig)) throw statusError("Username is reserved for this site", 400);
	      if (password.length < 8) throw statusError("Password must be at least 8 characters", 400);
      if (password.length > 256) throw statusError("Password must be at most 256 characters", 400);
	      if (accountConfig.email.mode === "required" && !email) throw statusError("Email is required", 400);
	      if (accountConfig.email.mode === "none" && email) throw statusError("Email is disabled for this site", 400);
	      if (db.prepare("select 1 from accounts where site = ? and lower(username) = lower(?)").get(site, username)) {
	        await hashPassword(password);
	        throw duplicateAccountError(accountConfig);
	      }
      const account = {
        id: crypto.randomUUID(),
        site,
        username,
        email: accountConfig.email.mode === "none" ? "" : email,
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString()
      };
      try {
        db.prepare("insert into accounts (id, site, username, email, password_hash, created_at) values (?, ?, ?, ?, ?, ?)")
          .run(account.id, account.site, account.username, account.email, account.passwordHash, account.createdAt);
      } catch (error) {
        if (String(error.message || "").includes("UNIQUE")) throw duplicateAccountError(accountConfig);
        throw error;
      }
      return accountConfig.discloseAccountExistence ? createSession(db, account, accountConfig) : { ok: true };
    },
    async login(site, input, accountConfig = normalizeAccountConfig({})) {
      const username = sanitizeAccountText(input.username || input.name, 80);
      const password = String(input.password || "");
      if (password.length > 256) throw statusError("Invalid username or password", 401);
      if (username === null) {
        await hashPassword(password);
        throw statusError("Invalid username or password", 401);
      }
      const account = db.prepare("select id, site, username, email, password_hash as passwordHash, created_at as createdAt from accounts where site = ? and lower(username) = lower(?)")
        .get(site, username);
      if (!account) {
        await hashPassword(password);
        throw statusError("Invalid username or password", 401);
      }
      if (!(await verifyPassword(password, account.passwordHash))) {
        throw statusError("Invalid username or password", 401);
      }
      return createSession(db, account, accountConfig);
    },
    async requestPasswordReset(site, input, accountConfig) {
      cleanupExpiredAuth(db);
      if (!accountConfig.passwordReset.enabled) throw statusError("Password reset is disabled for this site", 403);
      if (accountConfig.email.mode === "none") throw statusError("Password reset requires email support", 403);
      const username = sanitizeAccountText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
      if (username === null) {
        await resetDummyWork();
        return { ok: true };
      }
      const account = db.prepare("select id, site, username, email from accounts where site = ? and lower(username) = lower(?)")
        .get(site, username);
	      if (!account || !account.email || account.email !== email) {
	        await resetDummyWork();
	        return { ok: true };
	      }
      const existing = db.prepare("select 1 from reset_tokens where account_id = ? and site = ? and expires_at >= ?")
        .get(account.id, site, Date.now());
	      if (existing) {
	        await resetDummyWork();
	        return { ok: true };
	      }
      const token = crypto.randomUUID();
      const digest = tokenDigest(token);
      try {
        db.prepare("insert into reset_tokens (token, account_id, site, expires_at) values (?, ?, ?, ?)")
          .run(digest, account.id, site, Date.now() + accountConfig.passwordReset.ttlMs);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          await resetDummyWork();
          return { ok: true };
        }
        throw error;
      }
      try {
        await accountConfig.passwordReset.onToken?.({ site, username: account.username, email: account.email, token });
      } catch (error) {
        db.prepare("delete from reset_tokens where token = ? and account_id = ? and site = ?")
          .run(digest, account.id, site);
        console.error("jcomment password reset delivery failed");
      }
      return { ok: true };
    },
    async confirmPasswordReset(site, input, accountConfig) {
      cleanupExpiredAuth(db);
      if (!accountConfig.passwordReset.enabled) throw statusError("Password reset is disabled for this site", 403);
      const token = sanitizeText(input.token, 200);
      const password = String(input.password || "");
      if (password.length < 8) throw statusError("Password must be at least 8 characters", 400);
      if (password.length > 256) throw statusError("Password must be at most 256 characters", 400);
      const reset = db.prepare("select token, account_id as accountId, site, expires_at as expiresAt from reset_tokens where token = ?")
        .get(tokenDigest(token));
      if (!reset || reset.site !== site || reset.expiresAt < Date.now()) {
        throw statusError("Invalid or expired reset token", 400);
      }
      const account = db.prepare("select id from accounts where id = ? and site = ?").get(reset.accountId, site);
      if (!account) throw statusError("Invalid or expired reset token", 400);
      const passwordHash = await hashPassword(password);
      db.exec("begin immediate");
      try {
        const consumed = db.prepare("delete from reset_tokens where token = ? and account_id = ? and site = ? and expires_at >= ?")
          .run(reset.token, reset.accountId, site, Date.now());
        if (Number(consumed?.changes || 0) !== 1) {
          throw statusError("Invalid or expired reset token", 400);
        }
        db.prepare("update accounts set password_hash = ? where id = ? and site = ?").run(passwordHash, reset.accountId, site);
        db.prepare("delete from reset_tokens where account_id = ? and site = ?").run(reset.accountId, site);
        db.prepare("delete from sessions where account_id = ? and site = ?").run(reset.accountId, site);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return { ok: true };
    },
    async identify(token, site) {
      cleanupExpiredAuth(db);
      const session = db.prepare("select token, site, account_id as accountId, username, expires_at as expiresAt from sessions where token = ?").get(tokenDigest(token));
      if (!session || session.site !== site) return null;
      if (Number(session.expiresAt || 0) < Date.now()) {
        db.prepare("delete from sessions where token = ?").run(tokenDigest(token));
        return null;
      }
      return {
        type: "login",
        value: session.accountId,
        label: session.username
      };
    },
    async checkRateLimit(key, limit, windowMs) {
      return checkSqliteRateLimit(db, key, limit, windowMs);
    }
  };
}

function normalizeSqlitePath(path) {
  const value = String(path || "");
  if (!value || utf8Size(value) > 4096 || value.includes("\0")) {
    throw new Error("SQLite database path must be a non-empty path no longer than 4096 bytes and must not contain NUL bytes");
  }
  return value;
}

function getDatabaseSync() {
  const DatabaseSync = globalThis.process?.getBuiltinModule?.("node:sqlite")?.DatabaseSync;
  if (!DatabaseSync) {
    throw new Error("The built-in SQLite store requires Node 24+ with node:sqlite. Serverless edge runtimes need a provider-backed SQLite store.");
  }
  return DatabaseSync;
}

function rejectUnsafeSqliteDirectory(path) {
  if (!path || path === ":memory:") return;
  const fs = globalThis.process?.getBuiltinModule?.("node:fs");
  const pathModule = globalThis.process?.getBuiltinModule?.("node:path");
  const directory = pathModule?.dirname?.(path) || ".";
  if (hasSymlinkPathComponent(fs, pathModule, directory)) {
    throw new Error("SQLite database directory must not be a symlink");
  }
  const stat = fs?.statSync?.(directory);
  if (!stat?.isDirectory?.()) throw new Error("SQLite database directory must exist and be a directory");
  if (stat.mode & 0o022) throw new Error("SQLite database directory must not be group- or world-writable");
}

function hasSymlinkPathComponent(fs, pathModule, directory) {
  if (!fs?.lstatSync || !pathModule?.resolve || !pathModule?.parse) return false;
  const resolved = pathModule.resolve(directory);
  const root = pathModule.parse(resolved).root;
  const relative = resolved.slice(root.length);
  let current = root;
  for (const part of relative.split(pathModule.sep).filter(Boolean)) {
    current = pathModule.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function secureSqliteFile(path) {
  if (!path || path === ":memory:") return;
  const fs = globalThis.process?.getBuiltinModule?.("node:fs");
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    if (fs?.existsSync?.(candidate)) fs.chmodSync(candidate, 0o600);
  }
}

function rejectSqliteSymlink(path) {
  if (!path || path === ":memory:") return;
  const fs = globalThis.process?.getBuiltinModule?.("node:fs");
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try {
      if (fs?.lstatSync?.(candidate).isSymbolicLink()) {
        throw new Error("SQLite database path and sidecar paths must not be symlinks");
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

export function createCommentHandler({
  store = createSqliteStore(),
  cors = false,
  apiPath = "/api/comments",
  site = "default",
  voteIdentity = {},
  posting = {},
  security = {},
  getClientIp,
  brokenConfig = isBrokenConfigEnabled()
} = {}) {
  const voteConfig = normalizeVoteIdentityConfig(voteIdentity);
  voteConfig.getClientIp = getClientIp;
  const routeConfig = normalizeRouteConfig(apiPath);
  const postingConfig = normalizePostingConfig(posting);
  const securityConfig = normalizeSecurityConfig(security);
  const requestSite = normalizeSiteName(site);
  voteConfig.sessionCookie = securityConfig.sessionCookie;
  const rateLimiter = createRateLimiter(securityConfig.rateLimit, store);
  validateConfig({ cors, voteConfig, postingConfig, securityConfig, brokenConfig });
  warnForIpVoteStorage(voteConfig);
  warnForUnidentifiedVoting(voteConfig);

  return async function handleCommentRequest(request) {
    if (!validRequestMetadata(request, securityConfig.request.maxMetadataBytes)) {
      return json({ error: "Request metadata is too large" }, { status: 400, cors });
    }
    const url = new URL(request.url);
    const route = matchRoute(url.pathname, routeConfig);
    if (!route) return json({ error: "Not found" }, { status: 404, cors });
    const thread = sanitizeText(url.searchParams.get("thread"), 120) || "default";
    const sort = url.searchParams.get("sort") || "newest";
    const limit = parsePositiveInt(url.searchParams.get("limit"), 100, 200);
    const replyLimit = parsePositiveInt(url.searchParams.get("replyLimit"), 50, 200);
    const cursor = parsePositiveInt(url.searchParams.get("cursor"), 0, 500);
    const sourceIp = clientIp(request, voteConfig.ipStorage.trustForwardedHeaders, getClientIp);
    const rateIdentity = rateLimitIdentity(sourceIp, securityConfig.rateLimit);

    if (request.method === "OPTIONS") {
      return json({}, { status: 204, cors });
    }

    if (!methodAllowedForRoute(request.method, route)) {
      return json({ error: "Method not allowed" }, { status: 405, cors, allow: "GET, POST, PATCH, OPTIONS" });
    }

    const unsafeResponse = validateUnsafeRequest(request, cors, securityConfig);
    if (unsafeResponse) return unsafeResponse;

    if (request.method === "POST" && route === "signup") {
	      const limited = rateIdentity.response || await rateLimiter.check("signup", `${requestSite}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, securityConfig, voteConfig.accounts, input => store.signup(requestSite, input, voteConfig.accounts), {
        successStatus: voteConfig.accounts.discloseAccountExistence ? 201 : 202
      });
    }

    if (request.method === "POST" && route === "login") {
	      const limited = rateIdentity.response || await rateLimiter.check("login", `${requestSite}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, securityConfig, voteConfig.accounts, input => store.login(requestSite, input, voteConfig.accounts));
    }

    if (request.method === "POST" && route === "resetRequest") {
	      const limited = rateIdentity.response || await rateLimiter.check("reset", `${requestSite}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, securityConfig, voteConfig.accounts, input => store.requestPasswordReset(requestSite, input, voteConfig.accounts));
    }

    if (request.method === "POST" && route === "resetConfirm") {
	      const limited = rateIdentity.response || await rateLimiter.check("reset", `${requestSite}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, securityConfig, voteConfig.accounts, input => store.confirmPasswordReset(requestSite, input, voteConfig.accounts));
    }

    if (request.method === "GET" && route === "comments") {
      const payload = await store.list(requestSite, thread, { sort, limit, replyLimit, cursor });
      return json({ ...payload, capabilities: publicCapabilities(voteConfig, postingConfig) }, { cors });
    }

    if (request.method === "POST" && route === "comments") {
	      const limited = rateIdentity.response ||
	        await rateLimiter.check("post", `${requestSite}:${thread}:${rateIdentity.value}`) ||
	        await rateLimiter.check("postSite", `${requestSite}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      let identity = null;
      if (postingConfig.requireLogin) {
        if (!voteConfig.login.enabled) {
          return json({ error: "Posting requires login, but login is disabled for this site" }, { status: 403, cors });
        }
        const token = requestToken(request, securityConfig.sessionCookie);
        identity = token ? await store.identify(token, requestSite, voteConfig.accounts) : null;
        if (!identity) return json({ error: "Login is required to post comments" }, { status: 401, cors });
      }
      const parsed = await readJson(request, cors, securityConfig);
      if (parsed.response) return parsed.response;
      const input = parsed.value;
      try {
        const author = postingConfig.requireLogin ? identity.label : input.author;
        return json(await store.add(requestSite, thread, { ...input, author, sort, limit, replyLimit, quotas: securityConfig.quotas }), { status: 201, cors });
      } catch (error) {
        return errorJson(error, cors);
      }
    }

    if (request.method === "PATCH" && route === "comments") {
	      const limited = rateIdentity.response || await rateLimiter.check("vote", `${requestSite}:${thread}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      if (!voteConfig.voting.enabled) return json({ error: "Voting is disabled for this site" }, { status: 403, cors });
      const parsed = await readJson(request, cors, securityConfig);
      if (parsed.response) return parsed.response;
      const input = parsed.value;
      try {
        if (input.action !== "upvote") throw statusError("Unsupported vote action", 400);
        const delta = 1;
        const identity = await resolveVoteIdentity(request, requestSite, store, voteConfig);
        return json(await store.react(requestSite, thread, sanitizeText(input.id, 120), delta, {
          sort,
          limit,
          replyLimit,
          cursor,
          identity,
          maxVotesPerIdentity: voteConfig.maxVotesPerIdentity
        }), { cors });
      } catch (error) {
        return errorJson(error, cors);
      }
    }

    return json({ error: "Method not allowed" }, { status: 405, cors, allow: "GET, POST, PATCH, OPTIONS" });
  };
}

export function json(body, { status = 200, cors = false, allow } = {}) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  if (cors === "*") {
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
    headers.set("access-control-allow-headers", "authorization, content-type");
  } else if (typeof cors === "string" && cors) {
    headers.set("access-control-allow-origin", cors);
    headers.set("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
    headers.set("access-control-allow-headers", "authorization, content-type");
    headers.set("access-control-allow-credentials", "true");
  }
  if (allow) headers.set("allow", allow);
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

async function accountJson(request, cors, securityConfig, accountConfig, fn, { successStatus = 201 } = {}) {
  const started = Date.now();
  const parsed = await readJson(request, cors, securityConfig);
  if (parsed.response) return authTimedResponse(started, parsed.response);
  try {
    const payload = await fn(parsed.value || {});
    const token = payload?.token;
    if (token && shouldUseSessionCookie(request, securityConfig.sessionCookie)) {
      delete payload.token;
      const response = json(payload, { status: successStatus, cors });
      response.headers.append("set-cookie", sessionCookie(token, securityConfig.sessionCookie, accountConfig.session.ttlMs));
      return authTimedResponse(started, response);
    }
    return authTimedResponse(started, json(payload, { status: successStatus, cors }));
  } catch (error) {
    if (error?.duplicateAccount && !accountConfig.discloseAccountExistence) {
      return authTimedResponse(started, json({ ok: true }, { status: 202, cors }));
    }
    return authTimedResponse(started, errorJson(error, cors));
  }
}

async function authTimedResponse(started, response) {
  const remaining = 200 - (Date.now() - started);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  return response;
}

function errorJson(error, cors) {
  if (error?.status) {
    return json({ error: error.message }, { status: error.status, cors });
  }
  console.error(error);
  return json({ error: "Internal Server Error" }, { status: 500, cors });
}

async function readJson(request, cors, securityConfig) {
  const maxBytes = securityConfig.request.maxJsonBytes;
  const lengthHeader = request.headers.get("content-length") || "";
  if (lengthHeader && !/^[0-9]+$/.test(lengthHeader)) {
    return { response: json({ error: "Invalid request body" }, { status: 400, cors }) };
  }
  const length = Number(lengthHeader || 0);
  if (Number.isFinite(length) && length > maxBytes) {
    return { response: json({ error: "Request body is too large" }, { status: 413, cors }) };
  }
  let body;
  try {
    body = await readTextWithLimit(request, maxBytes);
  } catch (error) {
    if (error.status) return { response: json({ error: error.message }, { status: error.status, cors }) };
    return { response: json({ error: "Invalid request body" }, { status: 400, cors }) };
  }
  if (lengthHeader && body.size !== length) {
    return { response: json({ error: "Invalid request body" }, { status: 400, cors }) };
  }
  try {
    const value = JSON.parse(body.text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { response: json({ error: "Invalid JSON" }, { status: 400, cors }) };
    }
    return { value };
  } catch {
    return { response: json({ error: "Invalid JSON" }, { status: 400, cors }) };
  }
}

async function readTextWithLimit(request, maxBytes) {
  const reader = request.body?.getReader?.();
  if (!reader) return { text: "", size: 0 };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) throw statusError("Request body is too large", 413);
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, size };
}

function initDb(db) {
  db.exec(`
    create table if not exists comments (
      id text primary key,
      site text not null default 'default',
      thread text not null,
      parent_id text not null default '',
      author text not null,
      body text not null,
      created_at text not null,
      score integer not null default 0
    );
    create index if not exists comments_thread_idx on comments(thread, created_at);
    create table if not exists votes (
      thread text not null,
      site text not null default 'default',
      comment_id text not null,
      identity_type text not null,
      identity_value text not null,
      vote_slot integer not null default 0,
      label text not null,
      created_at text not null
    );
    create index if not exists votes_identity_idx on votes(thread, comment_id, identity_type, identity_value);
    create table if not exists accounts (
      id text primary key,
      site text not null,
      username text not null,
      email text not null default '',
      password_hash text not null,
      created_at text not null,
      unique(site, username)
    );
    create table if not exists sessions (
      token text primary key,
      site text not null,
      account_id text not null,
      username text not null,
      created_at text not null,
      expires_at integer not null default 0
    );
    create table if not exists reset_tokens (
      token text primary key,
      account_id text not null,
      site text not null,
      expires_at integer not null
    );
    create table if not exists rate_limits (
      key text primary key,
      count integer not null,
      reset_at integer not null
    );
  `);
  tryMigration(db, "alter table comments add column site text not null default 'default'");
  tryMigration(db, "alter table comments add column parent_id text not null default ''");
  tryMigration(db, "alter table votes add column site text not null default 'default'");
  db.exec("create index if not exists comments_site_thread_idx on comments(site, thread, created_at)");
  db.exec("create unique index if not exists accounts_site_username_key_idx on accounts(site, lower(username))");
  tryMigration(db, "alter table votes add column vote_slot integer not null default 0");
  tryMigration(db, "alter table sessions add column expires_at integer not null default 0");
  db.exec(`
    update votes
    set vote_slot = (
      select count(*) - 1
      from votes as earlier
      where earlier.site = votes.site
        and earlier.thread = votes.thread
        and earlier.comment_id = votes.comment_id
        and earlier.identity_type = votes.identity_type
        and earlier.identity_value = votes.identity_value
        and earlier.rowid <= votes.rowid
    );
  `);
  db.exec("create unique index if not exists votes_identity_slot_idx on votes(site, thread, comment_id, identity_type, identity_value, vote_slot)");
  db.exec("update sessions set expires_at = strftime('%s','now') * 1000 + 2592000000 where expires_at = 0");
  db.prepare("delete from reset_tokens where expires_at < ?").run(Date.now());
  db.exec("delete from reset_tokens where rowid not in (select max(rowid) from reset_tokens group by account_id, site)");
  db.exec("create unique index if not exists reset_tokens_account_site_idx on reset_tokens(account_id, site)");
}

function cleanupExpiredAuth(db) {
  const now = Date.now();
  db.prepare("delete from sessions where expires_at < ?").run(now);
  db.prepare("delete from reset_tokens where expires_at < ?").run(now);
}

function checkSqliteRateLimit(db, key, limit, windowMs) {
  const now = Date.now();
  const resetAt = now + windowMs;
  db.exec("begin immediate");
  try {
    db.prepare("delete from rate_limits where reset_at <= ?").run(now);
    db.prepare(`
      insert into rate_limits (key, count, reset_at) values (?, 1, ?)
      on conflict(key) do update set
        count = case when reset_at <= ? then 1 else count + 1 end,
        reset_at = case when reset_at <= ? then ? else reset_at end
    `).run(key, resetAt, now, now, resetAt);
    const row = db.prepare("select count from rate_limits where key = ?").get(key);
    db.exec("commit");
    return Number(row?.count || 0) > limit;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function enforceCommentQuota(db, site, thread, quotas = {}) {
  if (quotas.maxCommentsPerSite > 0) {
    const siteCount = Number(db.prepare("select count(*) as count from comments where site = ?").get(site)?.count || 0);
    if (siteCount >= quotas.maxCommentsPerSite) throw statusError("Comment store is full for this site", 507);
  }
  if (quotas.maxCommentsPerThread > 0) {
    const threadCount = Number(db.prepare("select count(*) as count from comments where site = ? and thread = ?").get(site, thread)?.count || 0);
    if (threadCount >= quotas.maxCommentsPerThread) throw statusError("Comment thread is full", 507);
  }
}

function tryMigration(db, sql) {
  try {
    db.exec(sql);
  } catch (error) {
    if (!String(error.message || "").includes("duplicate column")) throw error;
  }
}

function isUniqueConstraintError(error) {
  const message = String(error.message || "").toLowerCase();
  return message.includes("unique") || message.includes("constraint");
}

function listThread(db, site, thread, options) {
  const sort = normalizeSort(options.sort);
  const start = parsePositiveInt(options.cursor, 0, 500);
  const size = parsePositiveInt(options.limit, 100, 200);
  const repliesPerRoot = parsePositiveInt(options.replyLimit, 50, 200);
  const rootCount = Number(db.prepare("select count(*) as count from comments where site = ? and thread = ? and parent_id = ''").get(site, thread)?.count || 0);
  const totalCount = Number(db.prepare("select count(*) as count from comments where site = ? and thread = ?").get(site, thread)?.count || 0);
  const roots = db.prepare(`select id, parent_id as parentId, author, body, created_at as createdAt, score from comments where site = ? and thread = ? and parent_id = '' order by ${sqlSort(sort)} limit ? offset ?`)
    .all(site, thread, size, start)
    .map(normalizeComment);
  if (roots.length === 0) {
    return { comments: [], count: totalCount, nextCursor: null, sort };
  }
  const rootIds = roots.map(comment => comment.id);
  const placeholders = rootIds.map(() => "?").join(", ");
  const replies = repliesPerRoot === 0 ? [] : db.prepare(`select id, parent_id as parentId, author, body, created_at as createdAt, score from (
      select id, parent_id, author, body, created_at, score,
        row_number() over (partition by parent_id order by created_at asc) as reply_rank
      from comments
      where site = ? and thread = ? and parent_id in (${placeholders})
    ) where reply_rank <= ? order by parent_id asc, created_at asc`)
    .all(site, thread, ...rootIds, repliesPerRoot)
    .map(normalizeComment);
  const replyCounts = db.prepare(`select parent_id as parentId, count(*) as count from comments where site = ? and thread = ? and parent_id in (${placeholders}) group by parent_id`)
    .all(site, thread, ...rootIds);
  const counts = new Map(replyCounts.map(row => [row.parentId, Number(row.count || 0)]));
  const repliesByParent = new Map();
  for (const reply of replies) {
    if (!repliesByParent.has(reply.parentId)) repliesByParent.set(reply.parentId, []);
    repliesByParent.get(reply.parentId).push(reply);
  }
  const flattened = [];
  for (const root of roots) {
    root.replyCount = counts.get(root.id) || 0;
    flattened.push(root);
    for (const reply of repliesByParent.get(root.id) || []) {
      reply.replyCount = 0;
      flattened.push(reply);
    }
  }
  return {
    comments: flattened,
    count: totalCount,
    nextCursor: start + size < rootCount ? String(start + size) : null,
    sort
  };
}

function createSession(db, account, accountConfig = normalizeAccountConfig({})) {
  const token = crypto.randomUUID();
  const session = {
    token,
    site: account.site,
    accountId: account.id,
    username: account.username,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + accountConfig.session.ttlMs
  };
  db.prepare("insert into sessions (token, site, account_id, username, created_at, expires_at) values (?, ?, ?, ?, ?, ?)")
    .run(tokenDigest(token), session.site, session.accountId, session.username, session.createdAt, session.expiresAt);
  return {
    user: {
      username: session.username,
      name: session.username,
      createdAt: session.createdAt
    },
    token: session.token
  };
}

function rememberVote(db, site, thread, id, identity, maxVotesPerIdentity = 1) {
  if (!identity) throw statusError("Login is required to vote from this network", 401);
  const row = db.prepare("select count(*) as count from votes where site = ? and thread = ? and comment_id = ? and identity_type = ? and identity_value = ?")
    .get(site, thread, id, identity.type, identity.value);
  const count = Number(row?.count || 0);
  if (count >= maxVotesPerIdentity) throw statusError("Vote limit reached for this identity", 429);
  try {
    db.prepare("insert into votes (site, thread, comment_id, identity_type, identity_value, vote_slot, label, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(site, thread, id, identity.type, identity.value, count, identity.label, new Date().toISOString());
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) throw statusError("Vote limit reached for this identity", 429);
    throw error;
  }
}

async function resolveVoteIdentity(request, site, store, config) {
  const token = requestToken(request, config.sessionCookie);
  if (token && config.login.enabled) {
    const identity = await store.identify(token, site, config.accounts);
    if (identity) return identity;
  }

  const ip = clientIp(request, config.ipStorage.trustForwardedHeaders, config.getClientIp);
  if (ip && config.ipStorage.localhost && isLocalhostIp(ip)) return { type: "localhost", value: ip, label: "localhost" };
  if (config.ipStorage.enabled && ip && shouldTrackIp(ip, config.ipStorage)) {
    return { type: "ip", value: ip, label: "ip" };
  }
  if (!config.login.enabled) {
    throw statusError("Voting is unavailable from this network", 403);
  }
  throw statusError("Login is required to vote from this network", 401);
}

function normalizeVoteIdentityConfig(config) {
  return {
    maxVotesPerIdentity: positiveNumber(config.maxVotesPerIdentity, 1, 1, "voteIdentity.maxVotesPerIdentity"),
    accounts: normalizeAccountConfig(config.accounts || config.login || {}),
    voting: { enabled: configBool(config.voting?.enabled, true, "voteIdentity.voting.enabled") },
    login: { enabled: configBool(config.login?.enabled, true, "voteIdentity.login.enabled") },
    ipStorage: {
      enabled: configBool(config.ipStorage?.enabled, false, "voteIdentity.ipStorage.enabled"),
      localhost: configBool(config.ipStorage?.localhost, false, "voteIdentity.ipStorage.localhost"),
      allowRanges: normalizeStringList(config.ipStorage?.allowRanges, "voteIdentity.ipStorage.allowRanges"),
      denyRanges: normalizeStringList(config.ipStorage?.denyRanges, "voteIdentity.ipStorage.denyRanges"),
      trustForwardedHeaders: configBool(config.ipStorage?.trustForwardedHeaders, false, "voteIdentity.ipStorage.trustForwardedHeaders")
    }
  };
}

export function normalizeRouteConfig(apiPath) {
  const raw = apiPath === undefined || apiPath === null || apiPath === "" ? "/api/comments" : String(apiPath);
  if (!validApiPathBase(raw)) {
    throw new Error("Invalid jcomment configuration: apiPath must be an absolute URL path without query, hash, control characters, or path traversal");
  }
  const base = raw.replace(/\/+$/g, "") || "/";
  return {
    comments: base,
    signup: joinApiPath(base, "signup"),
    login: joinApiPath(base, "login"),
    resetRequest: joinApiPath(base, "reset/request"),
    resetConfirm: joinApiPath(base, "reset/confirm")
  };
}

function validApiPathBase(value) {
  return typeof value === "string" &&
    utf8Size(value) <= 1024 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[?#\x00-\x1F\x7F]/.test(value) &&
    !value.split("/").some(part => part === "." || part === "..");
}

function joinApiPath(base, suffix) {
  return `${base === "/" ? "" : base}/${suffix}`;
}

export function matchRoute(pathname, routes) {
  if (pathname === routes.comments) return "comments";
  if (pathname === routes.signup) return "signup";
  if (pathname === routes.login) return "login";
  if (pathname === routes.resetRequest) return "resetRequest";
  if (pathname === routes.resetConfirm) return "resetConfirm";
  return "";
}

export function methodAllowedForRoute(method, route) {
  if (route === "comments") return method === "GET" || method === "POST" || method === "PATCH";
  return method === "POST";
}

function normalizePostingConfig(config) {
  return {
    requireLogin: configBool(config.requireLogin, false, "posting.requireLogin")
  };
}

function normalizeSecurityConfig(config) {
  return {
    request: {
      maxJsonBytes: positiveNumber(config.request?.maxJsonBytes, 8192, 1024, "security.request.maxJsonBytes"),
      maxMetadataBytes: positiveNumber(config.request?.maxMetadataBytes, 8192, 1024, "security.request.maxMetadataBytes")
    },
    sessionCookie: {
      enabled: configBoolOrAuto(config.sessionCookie?.enabled, "auto", "security.sessionCookie.enabled"),
      name: normalizeCookieName(config.sessionCookie?.name || "jcomment_session", "security.sessionCookie.name"),
      path: normalizeCookiePath(config.sessionCookie?.path || "/", "security.sessionCookie.path"),
      sameSite: normalizeCookieSameSite(config.sessionCookie?.sameSite || "Lax", "security.sessionCookie.sameSite"),
      secure: configBool(config.sessionCookie?.secure, true, "security.sessionCookie.secure"),
      exposeToken: configBool(config.sessionCookie?.exposeToken, false, "security.sessionCookie.exposeToken")
    },
    csrf: {
      trustedOrigins: normalizeOriginList(config.csrf?.trustedOrigins, "security.csrf.trustedOrigins")
    },
    rateLimit: {
      enabled: configBool(config.rateLimit?.enabled, true, "security.rateLimit.enabled"),
      allowInMemory: configBool(config.rateLimit?.allowInMemory, false, "security.rateLimit.allowInMemory"),
      allowAnonymousIdentity: configBool(config.rateLimit?.allowAnonymousIdentity, false, "security.rateLimit.allowAnonymousIdentity"),
      windowMs: positiveNumber(config.rateLimit?.windowMs, 60_000, 1000, "security.rateLimit.windowMs"),
      limits: {
        signup: positiveNumber(config.rateLimit?.limits?.signup, 5, 1, "security.rateLimit.limits.signup"),
        login: positiveNumber(config.rateLimit?.limits?.login, 10, 1, "security.rateLimit.limits.login"),
        reset: positiveNumber(config.rateLimit?.limits?.reset, 3, 1, "security.rateLimit.limits.reset"),
        post: positiveNumber(config.rateLimit?.limits?.post, 20, 1, "security.rateLimit.limits.post"),
        postSite: positiveNumber(config.rateLimit?.limits?.postSite ?? config.rateLimit?.limits?.postGlobal, 60, 1, "security.rateLimit.limits.postSite"),
        vote: positiveNumber(config.rateLimit?.limits?.vote, 60, 1, "security.rateLimit.limits.vote")
      }
    },
    quotas: {
      maxCommentsPerThread: positiveNumber(config.quotas?.maxCommentsPerThread, 512, 1, "security.quotas.maxCommentsPerThread"),
      maxCommentsPerSite: positiveNumber(config.quotas?.maxCommentsPerSite, 5000, 1, "security.quotas.maxCommentsPerSite")
    }
  };
}

function validateConfig({ cors, voteConfig, postingConfig, securityConfig, brokenConfig }) {
  const errors = [];
  if (cors !== false && cors !== undefined && cors !== null) {
    if (typeof cors !== "string" || !validCorsOrigin(cors)) {
      errors.push("cors must be false, *, or an absolute http(s) origin");
    }
  }
  if (cors === "*" && securityConfig.sessionCookie.enabled !== false) {
    errors.push("cors * requires security.sessionCookie.enabled = false");
  }
  if (postingConfig.requireLogin && !voteConfig.login.enabled) {
    errors.push("posting.requireLogin requires voteIdentity.login.enabled to be true");
  }
  if (voteConfig.accounts.passwordReset.requested && voteConfig.accounts.email.mode === "none") {
    errors.push("password reset requires account email mode to be optional or required");
  }
  if (voteConfig.accounts.passwordReset.enabled && typeof voteConfig.accounts.passwordReset.onToken !== "function") {
    errors.push("password reset requires voteIdentity.accounts.passwordReset.onToken");
  }
  if (securityConfig.sessionCookie.enabled && securityConfig.sessionCookie.exposeToken) {
    errors.push("session cookie token exposure is not supported; use HttpOnly cookies or disable session cookies for non-browser bearer-token APIs");
  }
  if (securityConfig.sessionCookie.enabled && securityConfig.sessionCookie.sameSite === "None" && !securityConfig.sessionCookie.secure) {
    errors.push("session cookies with SameSite=None require Secure cookies");
  }
  for (const range of voteConfig.ipStorage.allowRanges) {
    if (!validIpRange(range)) errors.push(`voteIdentity.ipStorage.allowRanges contains invalid range: ${range}`);
  }
  for (const range of voteConfig.ipStorage.denyRanges) {
    if (!validIpRange(range)) errors.push(`voteIdentity.ipStorage.denyRanges contains invalid range: ${range}`);
  }
  if (errors.length === 0) return;
  const message = `Invalid jcomment configuration: ${errors.join("; ")}`;
  if (brokenConfig) {
    console.warn(`${message}. BROKEN_CONFIG=1 is unsupported and may break any number of things.`);
    return;
  }
  throw new Error(message);
}

function validateUnsafeRequest(request, cors, securityConfig) {
  if (request.method !== "POST" && request.method !== "PATCH") return null;
  const contentType = request.headers.get("content-type");
  if (contentType && !isJsonContentType(contentType)) {
    return json({ error: "Content-Type must be application/json" }, { status: 415, cors });
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return json({ error: "Cross-site state-changing requests are not allowed" }, { status: 403, cors });
  }
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin && !validRequestOrigin(rawOrigin)) {
    return json({ error: "Request origin is not allowed" }, { status: 403, cors });
  }
  const origin = rawOrigin ? normalizeOrigin(rawOrigin) : "";
  if (!origin && hasCookieName(request.headers.get("cookie"), securityConfig.sessionCookie) && fetchSite !== "same-origin") {
    return json({ error: "Cookie-authenticated state-changing requests require same-origin browser metadata" }, { status: 403, cors });
  }
  if (!origin) return null;
  const allowed = new Set([
    normalizeOrigin(new URL(request.url).origin),
    ...securityConfig.csrf.trustedOrigins
  ]);
  if (typeof cors === "string" && cors !== "*") allowed.add(normalizeOrigin(cors));
  if (!allowed.has(origin)) {
    return json({ error: "Request origin is not allowed" }, { status: 403, cors });
  }
  return null;
}

function isJsonContentType(value) {
  const mediaType = String(value || "").split(";")[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function validRequestMetadata(request, maxBytes) {
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

function normalizeOriginList(value, name = "origin list") {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid jcomment configuration: ${name} must be an array of exact absolute http(s) origins`);
  }
  const items = value;
  return items.map(item => {
    const text = String(item || "");
    if (!text || utf8Size(text) > 8192 || text === "*" || !validCorsOrigin(text)) {
      throw new Error(`Invalid jcomment configuration: ${name} must contain exact absolute http(s) origins`);
    }
    return text;
  });
}

function normalizeStringList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid jcomment configuration: ${name} must be an array`);
  }
  if (value.length > 256) {
    throw new Error(`Invalid jcomment configuration: ${name} must contain at most 256 entries`);
  }
  return value.map(item => {
    const text = String(item || "").trim();
    if (utf8Size(text) > 256) {
      throw new Error(`Invalid jcomment configuration: ${name} entries must not exceed 256 bytes`);
    }
    return text;
  });
}

function validCorsOrigin(value) {
  if (value === "*") return true;
  return validRequestOrigin(value);
}

function validRequestOrigin(value) {
  try {
    const text = String(value || "");
    if (utf8Size(text) > 8192) return false;
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function normalizeOrigin(value) {
  try {
    const text = String(value || "");
    if (utf8Size(text) > 8192) return "";
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function configBool(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.toLowerCase();
    if (text === "1" || text === "true" || text === "on" || text === "yes") return true;
    if (text === "0" || text === "false" || text === "off" || text === "no") return false;
  }
  throw new Error(`Invalid jcomment configuration: ${name} must be a boolean value`);
}

function configBoolOrAuto(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && value.toLowerCase() === "auto") return "auto";
  return configBool(value, fallback, name);
}

function normalizeAccountConfig(config) {
  const emailMode = normalizeEmailMode(config.email);
  const resetRequested = configBool(config.passwordReset?.enabled, false, "voteIdentity.accounts.passwordReset.enabled");
  const resetEnabled = resetRequested && emailMode !== "none";
  return {
    email: { mode: emailMode },
    passwordReset: {
      requested: resetRequested,
      enabled: resetEnabled,
      ttlMs: positiveNumber(config.passwordReset?.ttlMs, 3600_000, 1, "voteIdentity.accounts.passwordReset.ttlMs"),
      onToken: config.passwordReset?.onToken
    },
    session: {
      ttlMs: positiveNumber(config.session?.ttlMs, 30 * 24 * 60 * 60 * 1000, 1, "voteIdentity.accounts.session.ttlMs")
    },
    discloseAccountExistence: configBool(config.discloseAccountExistence, false, "voteIdentity.accounts.discloseAccountExistence"),
	    public: {
	      email: emailMode,
	      passwordReset: resetEnabled
	    },
	    reservedUsernames: normalizeReservedUsernames(config.reservedUsernames || config.registration?.reservedUsernames)
	  };
	}

function normalizeEmailMode(value) {
  if (value === undefined || value === null || value === "") return "none";
  const rawEmail = typeof value === "string" ? value : value?.mode;
  if (rawEmail === undefined || rawEmail === null || rawEmail === "") return "none";
  if (["none", "optional", "required"].includes(rawEmail)) return rawEmail;
  throw new Error("Invalid jcomment configuration: voteIdentity.accounts.email must be none, optional, or required");
}

function normalizeReservedUsernames(value, name = "voteIdentity.accounts.reservedUsernames") {
  const defaults = ["admin", "administrator", "moderator", "mod", "staff", "system", "anonymous", "jcomment"];
  if (value === undefined || value === null || value === "") {
    return new Set(defaults);
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid jcomment configuration: ${name} must be an array of account names`);
  }
  return new Set(value.map(item => {
    if (utf8Size(item) > 256) {
      throw new Error(`Invalid jcomment configuration: ${name} must contain account names no longer than 256 bytes`);
    }
    const normalized = sanitizeAccountText(item, 80);
    if (normalized === null || !normalized) {
      throw new Error(`Invalid jcomment configuration: ${name} must contain non-empty account names without control characters`);
    }
    return normalized.toLowerCase();
  }));
}

function isReservedUsername(username, accountConfig) {
  return accountConfig.reservedUsernames?.has?.(String(username || "").toLowerCase());
}

function duplicateAccountError(accountConfig) {
  const error = statusError(
    accountConfig.discloseAccountExistence ? "Account already exists for this site" : "Signup request accepted",
    accountConfig.discloseAccountExistence ? 409 : 202
  );
  error.duplicateAccount = true;
  return error;
}

function publicCapabilities(config, postingConfig) {
  return {
    voting: config.voting.enabled && (config.login.enabled || config.ipStorage.enabled),
    login: config.login.enabled,
    ipStorage: config.ipStorage.enabled,
    accounts: config.accounts.public,
    posting: {
      requireLogin: postingConfig.requireLogin
    }
  };
}

function warnForIpVoteStorage(config) {
  if (!config.ipStorage.enabled) return;
  console.warn(
    "jcomment IP vote limiting is enabled. This stores upvoter IP addresses indefinitely. " +
    "Only enable it for IP addresses in regions where indefinite IP storage for this purpose is lawful; " +
    "use ipStorage.allowRanges and ipStorage.denyRanges to exclude prohibited regions and provide login voting instead."
  );
}

function warnForUnidentifiedVoting(config) {
  if (!config.voting.enabled) return;
  if (config.login.enabled || config.ipStorage.enabled) return;
  console.warn(
    "jcomment voting is enabled while both login and IP storage are disabled. " +
    "Vote requests will be rejected because no durable server-side identity is available. " +
    "Enable login, enable lawful IP storage, or disable voting with voteIdentity.voting.enabled = false."
  );
}

function isBrokenConfigEnabled() {
  const value = globalThis.process?.env?.BROKEN_CONFIG;
  return value === "1" || value === "true";
}

function accountKey(site, username) {
  return `${site}:${username.toLowerCase()}`;
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sanitizeEmail(value) {
  const email = sanitizeText(value, 254).toLowerCase();
  if (!email) return "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

async function hashPassword(password) {
  const { argon2, randomBytes } = await import("node:crypto");
  const salt = randomBytes(16);
  const hash = await new Promise((resolve, reject) => {
    argon2("argon2id", {
      message: password,
      nonce: salt,
      parallelism: 1,
      memory: 65536,
      passes: 3,
      tagLength: 32
    }, (error, result) => error ? reject(error) : resolve(Buffer.from(result)));
  });
  return `argon2id$v=19$m=65536,t=3,p=1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function resetDummyWork() {
  await tokenDigest(crypto.randomUUID());
}

function tokenDigest(token) {
  const { createHash } = globalThis.process.getBuiltinModule("node:crypto");
  return `sha256:${createHash("sha256").update(String(token || ""), "utf8").digest("base64url")}`;
}

async function verifyPassword(password, stored) {
  const match = String(stored).match(/^argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/);
  if (!match) return false;
  const { argon2, timingSafeEqual } = await import("node:crypto");
  const [, memory, passes, parallelism, saltText, hashText] = match;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await new Promise((resolve, reject) => {
    argon2("argon2id", {
      message: password,
      nonce: Buffer.from(saltText, "base64url"),
      parallelism: Number(parallelism),
      memory: Number(memory),
      passes: Number(passes),
      tagLength: expected.length
    }, (error, result) => error ? reject(error) : resolve(Buffer.from(result)));
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function shouldTrackIp(ip, config) {
  if (config.denyRanges.some(range => ipInRange(ip, range))) return false;
  if (config.allowRanges.length === 0) return true;
  return config.allowRanges.some(range => ipInRange(ip, range));
}

function clientIp(request, _trustForwardedHeaders = false, getClientIp) {
  const raw = getClientIp?.(request) || "";
  if (utf8Size(raw) > 128) return "";
  const explicit = normalizeIp(raw);
  if (explicit && (isLocalhostIp(explicit) || validIpLiteral(explicit))) return explicit;
  return "";
}

function isLocalhostIp(ip) {
  if (ip === "localhost" || ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  const value = ipToBigInt(ip, 4);
  return value !== null && (value >> 24n) === 127n;
}

function bearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? sanitizeText(match[1], 200) : "";
}

function requestToken(request, sessionCookie) {
  return bearerToken(request.headers.get("authorization")) || cookieToken(request.headers.get("cookie"), sessionCookie);
}

function cookieToken(value, sessionCookie) {
  if (!sessionCookie?.enabled) return "";
  const name = sessionCookie.name;
  for (const part of String(value || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try {
      return sanitizeText(decodeURIComponent(part.slice(index + 1)), 200);
    } catch {
      continue;
    }
  }
  return "";
}

function hasCookieName(value, sessionCookie) {
  if (!sessionCookie?.enabled) return false;
  const name = sessionCookie.name;
  for (const part of String(value || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name && index + 1 < part.length) return true;
  }
  return false;
}

function shouldUseSessionCookie(request, config) {
  if (!config?.enabled) return false;
  if (config.enabled === "auto") return new URL(request.url).protocol === "https:";
  return true;
}

function sessionCookie(token, config, ttlMs) {
  const maxAge = Math.max(1, Math.floor(Number(ttlMs || 0) / 1000));
  const parts = [
    `${config.name}=${encodeURIComponent(token)}`,
    "HttpOnly",
    `Path=${config.path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${config.sameSite}`
  ];
  if (config.secure) parts.push("Secure");
  return parts.join("; ");
}

function normalizeCookieName(value, configName = "cookie name") {
  const cookieName = String(value || "");
  if (utf8Size(cookieName) <= 256 && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookieName)) return cookieName;
  throw new Error(`Invalid jcomment configuration: ${configName} must be a valid cookie name`);
}

function normalizeCookiePath(value, configName = "cookie path") {
  const path = String(value || "/");
  if (utf8Size(path) <= 1024 && path.startsWith("/") && !/[\x00-\x1F\x7F;]/.test(path)) return path;
  throw new Error(`Invalid jcomment configuration: ${configName} must start with / and must not contain control characters or semicolons`);
}

function normalizeCookieSameSite(value, configName = "cookie SameSite") {
  if (["Strict", "Lax", "None"].includes(value)) return value;
  throw new Error(`Invalid jcomment configuration: ${configName} must be Strict, Lax, or None`);
}

function rateLimitIdentity(sourceIp, config) {
  if (!config.enabled) return { value: "disabled" };
  if (sourceIp) return { value: `ip:${sourceIp}` };
  if (config.allowAnonymousIdentity) return { value: "anonymous" };
  return {
    value: "",
    response: json({ error: "Server rate limit identity is not configured" }, { status: 503 })
  };
}

function ipInRange(ip, range) {
  if (!ip || !range) return false;
  if (range === "*") return true;
  if (!String(range).includes("/")) return normalizeIp(range) === ip;
  const [base, prefixText] = String(range).split("/");
  const version = ip.includes(":") ? 6 : 4;
  if ((normalizeIp(base).includes(":") ? 6 : 4) !== version) return false;
  const prefix = Number(prefixText);
  const bits = version === 6 ? 128 : 32;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const ipValue = ipToBigInt(ip, version);
  const baseValue = ipToBigInt(normalizeIp(base), version);
  if (ipValue === null || baseValue === null) return false;
  const shift = BigInt(bits - prefix);
  return (ipValue >> shift) === (baseValue >> shift);
}

function validIpRange(range) {
  const text = String(range || "").trim();
  if (!text) return false;
  if (text === "*") return true;
  if (!text.includes("/")) return validIpLiteral(normalizeIp(text));
  const parts = text.split("/");
  if (parts.length !== 2) return false;
  const [base, prefixText] = parts;
  const normalizedBase = normalizeIp(base);
  if (!validIpLiteral(normalizedBase)) return false;
  const version = normalizedBase.includes(":") ? 6 : 4;
  const prefix = Number(prefixText);
  const bits = version === 6 ? 128 : 32;
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= bits;
}

function ipToBigInt(ip, version) {
  if (version === 4) {
    const parts = ip.split(".");
    if (parts.length !== 4 || parts.some(part => !/^[0-9]{1,3}$/.test(part))) return null;
    const numbers = parts.map(part => Number(part));
    if (numbers.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return numbers.reduce((value, part) => (value << 8n) + BigInt(part), 0n);
  }
  const expanded = expandIpv6(ip);
  if (!expanded) return null;
  return expanded.reduce((value, part) => (value << 16n) + BigInt(part), 0n);
}

function normalizeIp(value) {
  const text = String(value || "").trim();
  const hasLeadingBracket = text.startsWith("[");
  const hasTrailingBracket = text.endsWith("]");
  if (hasLeadingBracket !== hasTrailingBracket) return text;
  const ip = hasLeadingBracket ? text.slice(1, -1) : text;
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function validIpLiteral(value) {
  const ip = String(value || "");
  if (!ip) return false;
  const version = ip.includes(":") ? 6 : 4;
  return ipToBigInt(ip, version) !== null;
}

function expandIpv6(ip) {
  const sections = ip.toLowerCase().split("::");
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections[1] ? sections[1].split(":") : [];
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (sections.length === 1 && fill !== 0)) return null;
  return [...left, ...Array(fill).fill("0"), ...right].map(part => Number.parseInt(part, 16));
}

function listComments(comments, { sort = "newest", limit = 100, cursor = 0 } = {}) {
  const start = parsePositiveInt(cursor, 0, 500);
  const size = parsePositiveInt(limit, 100, 200);
  const roots = comments.filter(comment => !comment.parentId);
  const replies = new Map();
  for (const comment of comments) {
    if (!comment.parentId) continue;
    const items = replies.get(comment.parentId) || [];
    items.push(comment);
    replies.set(comment.parentId, items);
  }
  const sortedRoots = sortComments(roots, sort);
  const page = sortedRoots.slice(start, start + size);
  const flattened = [];
  for (const root of page) {
    flattened.push(withReplyCount(root, replies));
    for (const reply of sortComments(replies.get(root.id) || [], "oldest")) {
      flattened.push(withReplyCount(reply, replies));
    }
  }
  return {
    comments: flattened,
    count: comments.length,
    nextCursor: start + size < sortedRoots.length ? start + size : null,
    sort
  };
}

function sortComments(comments, sort) {
  return [...comments].sort((a, b) => {
    if (sort === "oldest") return new Date(a.createdAt) - new Date(b.createdAt);
    if (sort === "top") return (b.score || 0) - (a.score || 0) || new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

function normalizeSort(sort) {
  return sort === "oldest" || sort === "top" ? sort : "newest";
}

function sqlSort(sort) {
  if (sort === "oldest") return "created_at asc";
  if (sort === "top") return "score desc, created_at desc";
  return "created_at desc";
}

function withReplyCount(comment, replies) {
  return { ...comment, replyCount: (replies.get(comment.id) || []).length };
}

function normalizeComment(comment) {
  return {
    id: sanitizeText(comment.id, 120) || crypto.randomUUID(),
    parentId: sanitizeText(comment.parentId, 120),
    author: sanitizeText(comment.author, 80) || "Anonymous",
    body: sanitizeText(comment.body, 1800),
    createdAt: comment.createdAt || new Date().toISOString(),
    score: clampScore(Number(comment.score || 0))
  };
}

function parsePositiveInt(value, fallback, max = 500) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && !/^[0-9]+$/.test(value)) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return fallback;
  return Math.min(number, max);
}

function positiveNumber(value, fallback, minimum = 1, name = "value") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && !/^[0-9]+$/.test(value)) {
    throw new Error(`Invalid jcomment configuration: ${name} must be an integer greater than or equal to ${minimum}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`Invalid jcomment configuration: ${name} must be an integer greater than or equal to ${minimum}`);
  }
  return number;
}

function clampScore(value) {
  return Math.max(-999999, Math.min(999999, value));
}

function sanitizeText(value, max) {
  return String(value || "")
    .replace(/\p{C}/gu, char => (char === "\n" || char === "\t" ? char : ""))
    .trim()
    .slice(0, max);
}

function sanitizeAccountText(value, max) {
  const text = String(value || "");
  if (hasDisallowedAccountCodepoint(text)) return null;
  return text.trim().slice(0, max);
}

function hasDisallowedAccountCodepoint(value) {
  return /[\p{C}\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u.test(value);
}

function normalizeSiteName(value) {
  const text = String(value || "");
  if (/\p{C}/u.test(text)) {
    throw new Error("Invalid jcomment configuration: site must not contain control characters, surrounding whitespace, or exceed 120 bytes");
  }
  if (text !== text.trim() || new TextEncoder().encode(text).length > 120) {
    throw new Error("Invalid jcomment configuration: site must not contain control characters, surrounding whitespace, or exceed 120 bytes");
  }
  return text || "default";
}

function createRateLimiter(config, store) {
  if (config.enabled && !store?.checkRateLimit && !config.allowInMemory) {
    throw new Error("security.rateLimit requires store.checkRateLimit support; set security.rateLimit.allowInMemory = true only for single-process development or low-risk deployments.");
  }
  const buckets = new Map();
  const maxBuckets = 4096;
  return {
    async check(action, identity) {
      if (!config.enabled) return false;
      if (!identity) return false;
      const limit = config.limits[action] || 10;
      const key = `${action}:${identity}`;
      if (store?.checkRateLimit) {
        return store.checkRateLimit(key, limit, config.windowMs);
      }
      const now = Date.now();
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        if (existing) buckets.delete(key);
        buckets.set(key, { count: 1, resetAt: now + config.windowMs });
        cleanupBuckets(buckets, now, maxBuckets);
        return false;
      }
      buckets.delete(key);
      buckets.set(key, existing);
      existing.count += 1;
      return existing.count > limit;
    }
  };
}

function cleanupBuckets(buckets, now, maxBuckets) {
  if (buckets.size <= maxBuckets) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  while (buckets.size > maxBuckets) {
    const oldest = buckets.keys().next();
    if (oldest.done) break;
    buckets.delete(oldest.value);
  }
}
