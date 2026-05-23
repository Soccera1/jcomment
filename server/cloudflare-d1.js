export function createD1Store({
  db,
  hashPassword,
  verifyPassword,
  initSchema = true
} = {}) {
  if (!db) throw new Error("createD1Store requires a Cloudflare D1 binding");
  let schemaReady = false;

  async function ensureSchema() {
    if (!initSchema || schemaReady) return;
    await db.batch([
      db.prepare("create table if not exists comments (id text primary key, site text not null default 'default', thread text not null, parent_id text not null default '', author text not null, body text not null, created_at text not null, score integer not null default 0)"),
      db.prepare("create index if not exists comments_thread_idx on comments(thread, created_at)"),
      db.prepare("create table if not exists votes (site text not null default 'default', thread text not null, comment_id text not null, identity_type text not null, identity_value text not null, vote_slot integer not null default 0, label text not null, created_at text not null)"),
      db.prepare("create index if not exists votes_identity_idx on votes(thread, comment_id, identity_type, identity_value)"),
      db.prepare("create table if not exists accounts (id text primary key, site text not null, username text not null, email text not null default '', password_hash text not null, created_at text not null, unique(site, username))"),
      db.prepare("create table if not exists sessions (token text primary key, site text not null, account_id text not null, username text not null, created_at text not null, expires_at integer not null default 0)"),
      db.prepare("create table if not exists reset_tokens (token text primary key, account_id text not null, site text not null, expires_at integer not null)"),
      db.prepare("create table if not exists rate_limits (key text primary key, count integer not null, reset_at integer not null)")
    ]);
    await tryMigration(db, "alter table comments add column site text not null default 'default'");
    await tryMigration(db, "alter table votes add column site text not null default 'default'");
    await db.prepare("create index if not exists comments_site_thread_idx on comments(site, thread, created_at)").run();
    await db.prepare("create unique index if not exists accounts_site_username_key_idx on accounts(site, lower(username))").run();
    await tryMigration(db, "alter table votes add column vote_slot integer not null default 0");
    await tryMigration(db, "alter table sessions add column expires_at integer not null default 0");
    await db.prepare(`
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
      )
    `).run();
    await db.prepare("create unique index if not exists votes_identity_slot_idx on votes(site, thread, comment_id, identity_type, identity_value, vote_slot)").run();
    await db.prepare("update sessions set expires_at = unixepoch() * 1000 + 2592000000 where expires_at = 0").run();
    await cleanupExpiredAuth(db);
    schemaReady = true;
  }

  async function listThread(site, thread, options = {}) {
    await ensureSchema();
    const sort = normalizeSort(options.sort);
    const start = Math.max(0, Number(options.cursor) || 0);
    const size = Math.max(1, Math.min(200, Number(options.limit) || 100));
    const repliesPerRoot = Math.max(0, Math.min(200, Number(options.replyLimit) || 50));
    const rootCountRow = await db.prepare("select count(*) as count from comments where site = ? and thread = ? and parent_id = ''")
      .bind(site, thread)
      .first();
    const totalCountRow = await db.prepare("select count(*) as count from comments where site = ? and thread = ?")
      .bind(site, thread)
      .first();
    const { results: rootResults } = await db.prepare(`select id, parent_id as parentId, author, body, created_at as createdAt, score from comments where site = ? and thread = ? and parent_id = '' order by ${sqlSort(sort)} limit ? offset ?`)
      .bind(site, thread, size, start)
      .all();
    const roots = (rootResults || []).map(normalizeComment);
    const totalCount = Number(totalCountRow?.count || 0);
    if (roots.length === 0) {
      return { comments: [], count: totalCount, nextCursor: null, sort };
    }
    const rootIds = roots.map(comment => comment.id);
    const placeholders = rootIds.map(() => "?").join(", ");
    const replyResults = repliesPerRoot === 0 ? [] : (await db.prepare(`select id, parent_id as parentId, author, body, created_at as createdAt, score from (
        select id, parent_id, author, body, created_at, score,
          row_number() over (partition by parent_id order by created_at asc) as reply_rank
        from comments
        where site = ? and thread = ? and parent_id in (${placeholders})
      ) where reply_rank <= ? order by parent_id asc, created_at asc`)
      .bind(site, thread, ...rootIds, repliesPerRoot)
      .all()).results || [];
    const { results: countResults } = await db.prepare(`select parent_id as parentId, count(*) as count from comments where site = ? and thread = ? and parent_id in (${placeholders}) group by parent_id`)
      .bind(site, thread, ...rootIds)
      .all();
    const counts = new Map((countResults || []).map(row => [row.parentId, Number(row.count || 0)]));
    const repliesByParent = new Map();
    for (const reply of replyResults.map(normalizeComment)) {
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
      nextCursor: start + size < Number(rootCountRow?.count || 0) ? String(start + size) : null,
      sort
    };
  }

  function requireHasher() {
    if (!hashPassword || !verifyPassword) {
      throw statusError("Cloudflare account support requires Argon2id hashPassword and verifyPassword callbacks", 501);
    }
  }

  return {
    async list(site, thread, options = {}) {
      return listThread(site, thread, options);
    },
    async add(site, thread, input) {
      await ensureSchema();
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
      const quotas = normalizeQuotas(input.quotas);
      const result = await db.prepare(`
        insert into comments (id, site, thread, parent_id, author, body, created_at, score)
        select ?, ?, ?, ?, ?, ?, ?, ?
        where (select count(*) from comments where site = ?) < ?
          and (select count(*) from comments where site = ? and thread = ?) < ?
          and (? = '' or exists (select 1 from comments where site = ? and thread = ? and id = ?))
      `).bind(
        comment.id, site, thread, comment.parentId, comment.author, comment.body, comment.createdAt, comment.score,
        site, quotas.maxCommentsPerSite,
        site, thread, quotas.maxCommentsPerThread,
        comment.parentId, site, thread, comment.parentId
      ).run();
      const inserted = Number(result?.meta?.changes || 0) > 0 || Boolean(await db.prepare("select 1 from comments where site = ? and thread = ? and id = ?")
        .bind(site, thread, comment.id)
        .first());
      if (!inserted) {
        if (parentId) {
          const parent = await db.prepare("select 1 from comments where site = ? and thread = ? and id = ?")
            .bind(site, thread, parentId)
            .first();
          if (!parent) throw statusError("Parent comment was not found", 404);
        }
        await enforceCommentQuota(db, site, thread, quotas);
        throw statusError("Comment could not be created", 409);
      }
      return listThread(site, thread, { sort: input.sort, limit: input.limit, replyLimit: input.replyLimit });
    },
    async react(site, thread, id, delta = 1, options = {}) {
      await ensureSchema();
      const comment = await db.prepare("select id, score from comments where site = ? and thread = ? and id = ?")
        .bind(site, thread, id)
        .first();
      if (!comment) throw statusError("Comment was not found", 404);
      await rememberVote(db, site, thread, id, options.identity, options.maxVotesPerIdentity);
      await db.prepare("update comments set score = max(-999999, min(999999, score + ?)) where site = ? and thread = ? and id = ?")
        .bind(delta, site, thread, id)
        .run();
      return listThread(site, thread, options);
    },
    async signup(site, input, accountConfig) {
      await ensureSchema();
      requireHasher();
      const username = sanitizeText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
	      const password = String(input.password || "");
	      if (!username) throw statusError("Username is required", 400);
	      if (isReservedUsername(username, accountConfig)) throw statusError("Username is reserved for this site", 400);
	      if (password.length < 8) throw statusError("Password must be at least 8 characters", 400);
      if (password.length > 256) throw statusError("Password must be at most 256 characters", 400);
      if (accountConfig.email.mode === "required" && !email) throw statusError("Email is required", 400);
      if (accountConfig.email.mode === "none" && email) throw statusError("Email is disabled for this site", 400);
	      const existing = await db.prepare("select 1 from accounts where site = ? and lower(username) = lower(?)")
	        .bind(site, username)
	        .first();
	      if (existing) {
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
        await db.prepare("insert into accounts (id, site, username, email, password_hash, created_at) values (?, ?, ?, ?, ?, ?)")
          .bind(account.id, account.site, account.username, account.email, account.passwordHash, account.createdAt)
          .run();
      } catch (error) {
        if (isUniqueConstraintError(error)) throw duplicateAccountError(accountConfig);
        throw error;
      }
      return accountConfig.discloseAccountExistence ? createSession(db, account, accountConfig) : { ok: true };
    },
    async login(site, input, accountConfig = defaultAccountConfig()) {
      await ensureSchema();
      requireHasher();
      const username = sanitizeText(input.username || input.name, 80);
      const password = String(input.password || "");
      if (password.length > 256) throw statusError("Invalid username or password", 401);
      const account = await db.prepare("select id, site, username, email, password_hash as passwordHash, created_at as createdAt from accounts where site = ? and lower(username) = lower(?)")
        .bind(site, username)
        .first();
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
      await ensureSchema();
      await cleanupExpiredAuth(db);
      if (!accountConfig.passwordReset.enabled) throw statusError("Password reset is disabled for this site", 403);
      if (accountConfig.email.mode === "none") throw statusError("Password reset requires email support", 403);
      const username = sanitizeText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
      const account = await db.prepare("select id, site, username, email from accounts where site = ? and lower(username) = lower(?)")
        .bind(site, username)
        .first();
	      if (!account || !account.email || account.email !== email) {
	        await resetDummyWork();
	        return { ok: true };
	      }
      const existing = await db.prepare("select 1 from reset_tokens where account_id = ? and site = ? and expires_at >= ?")
        .bind(account.id, site, Date.now())
        .first();
	      if (existing) {
	        await resetDummyWork();
	        return { ok: true };
	      }
      const token = crypto.randomUUID();
      const digest = await tokenDigest(token);
      await db.prepare("insert into reset_tokens (token, account_id, site, expires_at) values (?, ?, ?, ?)")
        .bind(digest, account.id, site, Date.now() + accountConfig.passwordReset.ttlMs)
        .run();
      try {
        await accountConfig.passwordReset.onToken?.({ site, username: account.username, email: account.email, token });
      } catch (error) {
        await db.prepare("delete from reset_tokens where token = ? and account_id = ? and site = ?")
          .bind(digest, account.id, site)
          .run();
        throw error;
      }
      return { ok: true };
    },
    async confirmPasswordReset(site, input, accountConfig) {
      await ensureSchema();
      await cleanupExpiredAuth(db);
      requireHasher();
      if (!accountConfig.passwordReset.enabled) throw statusError("Password reset is disabled for this site", 403);
      const token = sanitizeText(input.token, 200);
      const password = String(input.password || "");
      if (password.length < 8) throw statusError("Password must be at least 8 characters", 400);
      if (password.length > 256) throw statusError("Password must be at most 256 characters", 400);
      const reset = await db.prepare("select token, account_id as accountId, site, expires_at as expiresAt from reset_tokens where token = ?")
        .bind(await tokenDigest(token))
        .first();
      if (!reset || reset.site !== site || Number(reset.expiresAt) < Date.now()) {
        throw statusError("Invalid or expired reset token", 400);
      }
      const account = await db.prepare("select id from accounts where id = ? and site = ?")
        .bind(reset.accountId, site)
        .first();
      if (!account) throw statusError("Invalid or expired reset token", 400);
      await db.batch([
        db.prepare("update accounts set password_hash = ? where id = ?").bind(await hashPassword(password), reset.accountId),
        db.prepare("delete from reset_tokens where account_id = ? and site = ?").bind(reset.accountId, site),
        db.prepare("delete from sessions where account_id = ? and site = ?").bind(reset.accountId, site)
      ]);
      return { ok: true };
    },
    async identify(token, site) {
      await ensureSchema();
      await cleanupExpiredAuth(db);
      const session = await db.prepare("select token, site, account_id as accountId, username, expires_at as expiresAt from sessions where token = ?")
        .bind(await tokenDigest(token))
        .first();
      if (!session || session.site !== site) return null;
      if (Number(session.expiresAt || 0) < Date.now()) {
        await db.prepare("delete from sessions where token = ?").bind(await tokenDigest(token)).run();
        return null;
      }
      return {
        type: "login",
        value: session.accountId,
        label: session.username
      };
    },
    async checkRateLimit(key, limit, windowMs) {
      await ensureSchema();
      return checkD1RateLimit(db, key, limit, windowMs);
    }
  };
}

async function cleanupExpiredAuth(db) {
  const now = Date.now();
  await db.prepare("delete from sessions where expires_at < ?").bind(now).run();
  await db.prepare("delete from reset_tokens where expires_at < ?").bind(now).run();
}

async function checkD1RateLimit(db, key, limit, windowMs) {
  const now = Date.now();
  const resetAt = now + windowMs;
  await db.batch([
    db.prepare("delete from rate_limits where reset_at <= ?").bind(now),
    db.prepare(`
      insert into rate_limits (key, count, reset_at) values (?, 1, ?)
      on conflict(key) do update set
        count = case when reset_at <= ? then 1 else count + 1 end,
        reset_at = case when reset_at <= ? then ? else reset_at end
    `).bind(key, resetAt, now, now, resetAt)
  ]);
  const row = await db.prepare("select count from rate_limits where key = ?").bind(key).first();
  return Number(row?.count || 0) > limit;
}

async function enforceCommentQuota(db, site, thread, quotas = {}) {
  if (quotas.maxCommentsPerSite > 0) {
    const siteCount = await db.prepare("select count(*) as count from comments where site = ?").bind(site).first();
    if (Number(siteCount?.count || 0) >= quotas.maxCommentsPerSite) throw statusError("Comment store is full for this site", 507);
  }
  if (quotas.maxCommentsPerThread > 0) {
    const threadCount = await db.prepare("select count(*) as count from comments where site = ? and thread = ?").bind(site, thread).first();
    if (Number(threadCount?.count || 0) >= quotas.maxCommentsPerThread) throw statusError("Comment thread is full", 507);
  }
}

function normalizeQuotas(quotas = {}) {
  return {
    maxCommentsPerThread: Math.max(1, Number(quotas.maxCommentsPerThread || 512)),
    maxCommentsPerSite: Math.max(1, Number(quotas.maxCommentsPerSite || 5000))
  };
}

async function createSession(db, account, accountConfig = defaultAccountConfig()) {
  const token = crypto.randomUUID();
  const session = {
    token,
    site: account.site,
    accountId: account.id,
    username: account.username,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + accountConfig.session.ttlMs
  };
  await db.prepare("insert into sessions (token, site, account_id, username, created_at, expires_at) values (?, ?, ?, ?, ?, ?)")
    .bind(await tokenDigest(token), session.site, session.accountId, session.username, session.createdAt, session.expiresAt)
    .run();
  return {
    user: {
      username: session.username,
      name: session.username,
      createdAt: session.createdAt
    },
    token: session.token
  };
}

async function rememberVote(db, site, thread, id, identity, maxVotesPerIdentity = 1) {
  if (!identity) throw statusError("Login is required to vote from this network", 401);
  for (let slot = 0; slot < maxVotesPerIdentity; slot += 1) {
    try {
      await db.prepare("insert into votes (site, thread, comment_id, identity_type, identity_value, vote_slot, label, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(site, thread, id, identity.type, identity.value, slot, identity.label, new Date().toISOString())
        .run();
      return;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }
  }
  throw statusError("Vote limit reached for this identity", 429);
}

function listComments(comments, { sort = "newest", limit = 100, cursor = 0 } = {}) {
  const byParent = new Map();
  const normalized = comments.map(normalizeComment);
  for (const comment of normalized) {
    const key = comment.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(comment);
  }
  for (const comment of normalized) {
    comment.replyCount = (byParent.get(comment.id) || []).length;
  }
  const roots = (byParent.get("") || []).sort(sorter(sort));
  const ordered = [];
  for (const root of roots) {
    ordered.push(root);
    ordered.push(...(byParent.get(root.id) || []).sort(sorter("oldest")));
  }
  const start = Math.max(0, Number(cursor) || 0);
  const size = Math.max(1, Math.min(200, Number(limit) || 100));
  return {
    comments: ordered.slice(start, start + size),
    count: normalized.length,
    nextCursor: start + size < ordered.length ? String(start + size) : null,
    sort
  };
}

function normalizeComment(comment) {
  return {
    id: String(comment.id || crypto.randomUUID()),
    parentId: String(comment.parentId || comment.parent_id || ""),
    author: sanitizeText(comment.author, 80) || "Anonymous",
    body: sanitizeText(comment.body, 1800),
    createdAt: String(comment.createdAt || comment.created_at || new Date().toISOString()),
    score: clampScore(Number(comment.score || 0)),
    replyCount: Number(comment.replyCount || 0)
  };
}

function sorter(sort) {
  if (sort === "oldest") return (a, b) => a.createdAt.localeCompare(b.createdAt);
  if (sort === "top") return (a, b) => (b.score - a.score) || b.createdAt.localeCompare(a.createdAt);
  return (a, b) => b.createdAt.localeCompare(a.createdAt);
}

function normalizeSort(sort) {
  return sort === "oldest" || sort === "top" ? sort : "newest";
}

function sqlSort(sort) {
  if (sort === "oldest") return "created_at asc";
  if (sort === "top") return "score desc, created_at desc";
  return "created_at desc";
}

function sanitizeEmail(value) {
  const email = sanitizeText(value, 254).toLowerCase();
  if (!email) return "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function sanitizeText(value, max) {
  return String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

function clampScore(value) {
  return Math.max(-999999, Math.min(999999, Number.isFinite(value) ? Math.trunc(value) : 0));
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function duplicateAccountError(accountConfig) {
  const error = statusError(
    accountConfig.discloseAccountExistence ? "Account already exists for this site" : "Signup request accepted",
    accountConfig.discloseAccountExistence ? 409 : 202
  );
  error.duplicateAccount = true;
  return error;
}

function isReservedUsername(username, accountConfig) {
  return accountConfig.reservedUsernames?.has?.(String(username || "").toLowerCase());
}

async function tryMigration(db, sql) {
  try {
    await db.prepare(sql).run();
  } catch (error) {
    if (!String(error.message || "").toLowerCase().includes("duplicate column")) throw error;
  }
}

function defaultAccountConfig() {
  return {
    session: {
      ttlMs: 30 * 24 * 60 * 60 * 1000
    }
  };
}

async function tokenDigest(token) {
  const bytes = new TextEncoder().encode(String(token || ""));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${base64url(new Uint8Array(hash))}`;
}

async function resetDummyWork() {
  await tokenDigest(crypto.randomUUID());
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isUniqueConstraintError(error) {
  const message = String(error.message || "").toLowerCase();
  return message.includes("unique") || message.includes("constraint");
}
