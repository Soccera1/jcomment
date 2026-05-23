export function createMemoryStore(seed = {}) {
  return createSqliteStore({ path: ":memory:", seed });
}

export function createSqliteStore({ path = process.env.JCOMMENT_DB || "jcomment.sqlite3", seed = {} } = {}) {
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(path);
  initDb(db);
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
      rememberVote(db, site, thread, id, options.identity, options.maxVotesPerIdentity);
      db.prepare("update comments set score = ? where site = ? and thread = ? and id = ?")
        .run(clampScore((comment.score || 0) + delta), site, thread, id);
      return listThread(db, site, thread, options);
    },
    async signup(site, input, accountConfig) {
      const username = sanitizeText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
	      const password = String(input.password || "");
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
      const username = sanitizeText(input.username || input.name, 80);
      const password = String(input.password || "");
      if (password.length > 256) throw statusError("Invalid username or password", 401);
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
      const username = sanitizeText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
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
      db.prepare("insert into reset_tokens (token, account_id, site, expires_at) values (?, ?, ?, ?)")
        .run(digest, account.id, site, Date.now() + accountConfig.passwordReset.ttlMs);
      try {
        await accountConfig.passwordReset.onToken?.({ site, username: account.username, email: account.email, token });
      } catch (error) {
        db.prepare("delete from reset_tokens where token = ? and account_id = ? and site = ?")
          .run(digest, account.id, site);
        throw error;
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
      db.prepare("update accounts set password_hash = ? where id = ?").run(await hashPassword(password), reset.accountId);
      db.prepare("delete from reset_tokens where account_id = ? and site = ?").run(reset.accountId, site);
      db.prepare("delete from sessions where account_id = ? and site = ?").run(reset.accountId, site);
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

function getDatabaseSync() {
  const DatabaseSync = globalThis.process?.getBuiltinModule?.("node:sqlite")?.DatabaseSync;
  if (!DatabaseSync) {
    throw new Error("The built-in SQLite store requires Node 24+ with node:sqlite. Serverless edge runtimes need a provider-backed SQLite store.");
  }
  return DatabaseSync;
}

function secureSqliteFile(path) {
  if (!path || path === ":memory:") return;
  const fs = globalThis.process?.getBuiltinModule?.("node:fs");
  fs?.chmodSync?.(path, 0o600);
}

export function createCommentHandler({
  store = createSqliteStore(),
  cors = false,
  site = "default",
  voteIdentity = {},
  posting = {},
  security = {},
  getClientIp,
  brokenConfig = isBrokenConfigEnabled()
} = {}) {
  const voteConfig = normalizeVoteIdentityConfig(voteIdentity);
  voteConfig.getClientIp = getClientIp;
  const postingConfig = normalizePostingConfig(posting);
  const securityConfig = normalizeSecurityConfig(security);
  voteConfig.sessionCookie = securityConfig.sessionCookie;
  const rateLimiter = createRateLimiter(securityConfig.rateLimit, store);
  validateConfig({ voteConfig, postingConfig, securityConfig, brokenConfig });
  warnForIpVoteStorage(voteConfig);
  warnForUnidentifiedVoting(voteConfig);

  return async function handleCommentRequest(request) {
    const url = new URL(request.url);
    const thread = sanitizeText(url.searchParams.get("thread"), 120) || "default";
    const sort = url.searchParams.get("sort") || "newest";
    const limit = parsePositiveInt(url.searchParams.get("limit"), 100);
    const replyLimit = parsePositiveInt(url.searchParams.get("replyLimit"), 50);
    const cursor = parsePositiveInt(url.searchParams.get("cursor"), 0);
    const requestSite = sanitizeText(site, 120) || "default";
    const sourceIp = clientIp(request, voteConfig.ipStorage.trustForwardedHeaders, getClientIp);
    const rateIdentity = rateLimitIdentity(sourceIp, securityConfig.rateLimit);

    if (request.method === "OPTIONS") {
      return json({}, { status: 204, cors });
    }

    const unsafeResponse = validateUnsafeRequest(request, cors, securityConfig);
    if (unsafeResponse) return unsafeResponse;

    if (request.method === "POST" && url.pathname.endsWith("/signup")) {
	      const limited = rateIdentity.response || await rateLimiter.check("signup", `${requestSite}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, securityConfig, voteConfig.accounts, input => store.signup(requestSite, input, voteConfig.accounts), {
        successStatus: voteConfig.accounts.discloseAccountExistence ? 201 : 202
      });
    }

    if (request.method === "POST" && url.pathname.endsWith("/login")) {
	      const limited = rateIdentity.response || await rateLimiter.check("login", `${requestSite}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, securityConfig, voteConfig.accounts, input => store.login(requestSite, input, voteConfig.accounts));
    }

    if (request.method === "POST" && url.pathname.endsWith("/reset/request")) {
	      const limited = rateIdentity.response || await rateLimiter.check("reset", `${requestSite}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, securityConfig, voteConfig.accounts, input => store.requestPasswordReset(requestSite, input, voteConfig.accounts));
    }

    if (request.method === "POST" && url.pathname.endsWith("/reset/confirm")) {
	      const limited = rateIdentity.response || await rateLimiter.check("reset", `${requestSite}:${rateIdentity.value}`);
	      if (limited instanceof Response) return limited;
	      if (limited) return json({ error: "Too many requests" }, { status: 429, cors });
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, securityConfig, voteConfig.accounts, input => store.confirmPasswordReset(requestSite, input, voteConfig.accounts));
    }

    if (request.method === "GET") {
      const payload = await store.list(requestSite, thread, { sort, limit, replyLimit, cursor });
      return json({ ...payload, capabilities: publicCapabilities(voteConfig, postingConfig) }, { cors });
    }

    if (request.method === "POST") {
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

    if (request.method === "PATCH") {
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
      if (!securityConfig.sessionCookie.exposeToken) delete payload.token;
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
  const length = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > maxBytes) {
    return { response: json({ error: "Request body is too large" }, { status: 413, cors }) };
  }
  let text;
  try {
    text = await readTextWithLimit(request, maxBytes);
  } catch (error) {
    if (error.status) return { response: json({ error: error.message }, { status: error.status, cors }) };
    return { response: json({ error: "Invalid request body" }, { status: 400, cors }) };
  }
  try {
    return { value: JSON.parse(text || "{}") };
  } catch {
    return { response: json({ error: "Invalid JSON" }, { status: 400, cors }) };
  }
}

async function readTextWithLimit(request, maxBytes) {
  const reader = request.body?.getReader?.();
  if (!reader) return "";
  const decoder = new TextDecoder();
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
  return text;
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

function listThread(db, site, thread, options) {
  const sort = normalizeSort(options.sort);
  const start = Math.max(0, Number(options.cursor) || 0);
  const size = Math.max(1, Math.min(200, Number(options.limit) || 100));
  const repliesPerRoot = Math.max(0, Math.min(200, Number(options.replyLimit) || 50));
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
  db.exec("begin immediate");
  try {
    const row = db.prepare("select count(*) as count from votes where site = ? and thread = ? and comment_id = ? and identity_type = ? and identity_value = ?")
      .get(site, thread, id, identity.type, identity.value);
    const count = Number(row?.count || 0);
    if (count >= maxVotesPerIdentity) throw statusError("Vote limit reached for this identity", 429);
    db.prepare("insert into votes (site, thread, comment_id, identity_type, identity_value, vote_slot, label, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(site, thread, id, identity.type, identity.value, count, identity.label, new Date().toISOString());
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
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
    maxVotesPerIdentity: Math.max(1, Number(config.maxVotesPerIdentity || 1)),
    accounts: normalizeAccountConfig(config.accounts || config.login || {}),
    voting: { enabled: config.voting?.enabled !== false },
    login: { enabled: config.login?.enabled !== false },
    ipStorage: {
      enabled: Boolean(config.ipStorage?.enabled),
      localhost: Boolean(config.ipStorage?.localhost),
      allowRanges: config.ipStorage?.allowRanges || [],
      denyRanges: config.ipStorage?.denyRanges || [],
      trustForwardedHeaders: Boolean(config.ipStorage?.trustForwardedHeaders)
    }
  };
}

function normalizePostingConfig(config) {
  return {
    requireLogin: Boolean(config.requireLogin)
  };
}

function normalizeSecurityConfig(config) {
  return {
    request: {
      maxJsonBytes: Math.max(1024, Number(config.request?.maxJsonBytes || 8192))
    },
    sessionCookie: {
      enabled: config.sessionCookie?.enabled ?? "auto",
      name: sanitizeCookieName(config.sessionCookie?.name || "jcomment_session"),
      path: sanitizeCookiePath(config.sessionCookie?.path || "/"),
      sameSite: ["Strict", "Lax", "None"].includes(config.sessionCookie?.sameSite) ? config.sessionCookie.sameSite : "Lax",
      secure: config.sessionCookie?.secure !== false,
      exposeToken: Boolean(config.sessionCookie?.exposeToken)
    },
    csrf: {
      trustedOrigins: normalizeOriginList(config.csrf?.trustedOrigins)
    },
    rateLimit: {
      enabled: config.rateLimit?.enabled !== false,
      allowInMemory: Boolean(config.rateLimit?.allowInMemory),
      allowAnonymousIdentity: Boolean(config.rateLimit?.allowAnonymousIdentity),
      windowMs: Math.max(1000, Number(config.rateLimit?.windowMs || 60_000)),
      limits: {
        signup: Math.max(1, Number(config.rateLimit?.limits?.signup || 5)),
        login: Math.max(1, Number(config.rateLimit?.limits?.login || 10)),
        reset: Math.max(1, Number(config.rateLimit?.limits?.reset || 3)),
        post: Math.max(1, Number(config.rateLimit?.limits?.post || 20)),
        postSite: Math.max(1, Number(config.rateLimit?.limits?.postSite || config.rateLimit?.limits?.postGlobal || 60)),
        vote: Math.max(1, Number(config.rateLimit?.limits?.vote || 60))
      }
    },
    quotas: {
      maxCommentsPerThread: Math.max(1, Number(config.quotas?.maxCommentsPerThread || 512)),
      maxCommentsPerSite: Math.max(1, Number(config.quotas?.maxCommentsPerSite || 5000))
    }
  };
}

function validateConfig({ voteConfig, postingConfig, securityConfig, brokenConfig }) {
  const errors = [];
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
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!origin && !fetchSite && cookieToken(request.headers.get("cookie"), securityConfig.sessionCookie)) {
    return json({ error: "Cookie-authenticated state-changing requests require browser origin metadata" }, { status: 403, cors });
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

function normalizeOriginList(value) {
  const items = Array.isArray(value) ? value : [];
  return items.map(normalizeOrigin).filter(Boolean);
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function normalizeAccountConfig(config) {
  const rawEmail = typeof config.email === "string" ? config.email : config.email?.mode;
  const emailMode = ["none", "optional", "required"].includes(rawEmail) ? rawEmail : "none";
  const resetEnabled = Boolean(config.passwordReset?.enabled) && emailMode !== "none";
  return {
    email: { mode: emailMode },
    passwordReset: {
      requested: Boolean(config.passwordReset?.enabled),
      enabled: resetEnabled,
      ttlMs: Number(config.passwordReset?.ttlMs || 3600_000),
      onToken: config.passwordReset?.onToken
    },
    session: {
      ttlMs: Math.max(1, Number(config.session?.ttlMs || 30 * 24 * 60 * 60 * 1000))
    },
    discloseAccountExistence: Boolean(config.discloseAccountExistence),
	    public: {
	      email: emailMode,
	      passwordReset: resetEnabled
	    },
	    reservedUsernames: normalizeReservedUsernames(config.reservedUsernames || config.registration?.reservedUsernames)
	  };
	}

function normalizeReservedUsernames(value) {
  const defaults = ["admin", "administrator", "moderator", "mod", "staff", "system", "anonymous", "jcomment"];
  const items = Array.isArray(value) ? value : defaults;
  return new Set(items.map(item => sanitizeText(item, 80).toLowerCase()).filter(Boolean));
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
  const explicit = normalizeIp(getClientIp?.(request) || "");
  if (explicit) return explicit;
  return "";
}

function isLocalhostIp(ip) {
  return ip === "localhost" || ip === "::1" || ip === "0:0:0:0:0:0:0:1" || ip.startsWith("127.");
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
      return "";
    }
  }
  return "";
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

function sanitizeCookieName(value) {
  const name = String(value || "").trim();
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ? name : "jcomment_session";
}

function sanitizeCookiePath(value) {
  const path = String(value || "/").replace(/[\r\n;]/g, "");
  return path.startsWith("/") ? path : "/";
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

function ipToBigInt(ip, version) {
  if (version === 4) {
    const parts = ip.split(".").map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return parts.reduce((value, part) => (value << 8n) + BigInt(part), 0n);
  }
  const expanded = expandIpv6(ip);
  if (!expanded) return null;
  return expanded.reduce((value, part) => (value << 16n) + BigInt(part), 0n);
}

function normalizeIp(value) {
  const ip = String(value || "").trim().replace(/^\[|\]$/g, "");
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
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
  const roots = comments.filter(comment => !comment.parentId);
  const replies = new Map();
  for (const comment of comments) {
    if (!comment.parentId) continue;
    const items = replies.get(comment.parentId) || [];
    items.push(comment);
    replies.set(comment.parentId, items);
  }
  const sortedRoots = sortComments(roots, sort);
  const page = sortedRoots.slice(cursor, cursor + limit);
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
    nextCursor: cursor + limit < sortedRoots.length ? cursor + limit : null,
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

function parsePositiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, 500);
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
