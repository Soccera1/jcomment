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
      db.prepare("create table if not exists comments (id text primary key, thread text not null, parent_id text not null default '', author text not null, body text not null, created_at text not null, score integer not null default 0)"),
      db.prepare("create index if not exists comments_thread_idx on comments(thread, created_at)"),
      db.prepare("create table if not exists votes (thread text not null, comment_id text not null, identity_type text not null, identity_value text not null, label text not null, created_at text not null)"),
      db.prepare("create index if not exists votes_identity_idx on votes(thread, comment_id, identity_type, identity_value)"),
      db.prepare("create table if not exists accounts (id text primary key, site text not null, username text not null, email text not null default '', password_hash text not null, created_at text not null, unique(site, username))"),
      db.prepare("create table if not exists sessions (token text primary key, site text not null, account_id text not null, username text not null, created_at text not null)"),
      db.prepare("create table if not exists reset_tokens (token text primary key, account_id text not null, site text not null, expires_at integer not null)")
    ]);
    schemaReady = true;
  }

  async function listThread(thread, options = {}) {
    await ensureSchema();
    const { results } = await db.prepare("select id, parent_id as parentId, author, body, created_at as createdAt, score from comments where thread = ?")
      .bind(thread)
      .all();
    return listComments(results || [], options);
  }

  function requireHasher() {
    if (!hashPassword || !verifyPassword) {
      throw statusError("Cloudflare account support requires Argon2id hashPassword and verifyPassword callbacks", 501);
    }
  }

  return {
    async list(thread, options = {}) {
      return listThread(thread, options);
    },
    async add(thread, input) {
      await ensureSchema();
      const parentId = sanitizeText(input.parentId, 120);
      if (parentId) {
        const parent = await db.prepare("select 1 from comments where thread = ? and id = ?")
          .bind(thread, parentId)
          .first();
        if (!parent) throw statusError("Parent comment was not found", 404);
      }
      const comment = normalizeComment({
        id: crypto.randomUUID(),
        parentId,
        author: sanitizeText(input.author, 80) || "Anonymous",
        body: sanitizeText(input.body, 1800),
        createdAt: new Date().toISOString(),
        score: 0
      });
      if (!comment.body) throw statusError("Comment body is required", 400);
      await db.prepare("insert into comments (id, thread, parent_id, author, body, created_at, score) values (?, ?, ?, ?, ?, ?, ?)")
        .bind(comment.id, thread, comment.parentId, comment.author, comment.body, comment.createdAt, comment.score)
        .run();
      return listThread(thread, { sort: input.sort });
    },
    async react(thread, id, delta = 1, options = {}) {
      await ensureSchema();
      const comment = await db.prepare("select id, score from comments where thread = ? and id = ?")
        .bind(thread, id)
        .first();
      if (!comment) throw statusError("Comment was not found", 404);
      await rememberVote(db, thread, id, options.identity, options.maxVotesPerIdentity);
      await db.prepare("update comments set score = ? where thread = ? and id = ?")
        .bind(clampScore(Number(comment.score || 0) + delta), thread, id)
        .run();
      return listThread(thread, options);
    },
    async signup(site, input, accountConfig) {
      await ensureSchema();
      requireHasher();
      const username = sanitizeText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
      const password = String(input.password || "");
      if (!username) throw statusError("Username is required", 400);
      if (password.length < 8) throw statusError("Password must be at least 8 characters", 400);
      if (accountConfig.email.mode === "required" && !email) throw statusError("Email is required", 400);
      if (accountConfig.email.mode === "none" && email) throw statusError("Email is disabled for this site", 400);
      const existing = await db.prepare("select 1 from accounts where site = ? and lower(username) = lower(?)")
        .bind(site, username)
        .first();
      if (existing) throw statusError("Account already exists for this site", 409);
      const account = {
        id: crypto.randomUUID(),
        site,
        username,
        email: accountConfig.email.mode === "none" ? "" : email,
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString()
      };
      await db.prepare("insert into accounts (id, site, username, email, password_hash, created_at) values (?, ?, ?, ?, ?, ?)")
        .bind(account.id, account.site, account.username, account.email, account.passwordHash, account.createdAt)
        .run();
      return createSession(db, account);
    },
    async login(site, input) {
      await ensureSchema();
      requireHasher();
      const username = sanitizeText(input.username || input.name, 80);
      const password = String(input.password || "");
      const account = await db.prepare("select id, site, username, email, password_hash as passwordHash, created_at as createdAt from accounts where site = ? and lower(username) = lower(?)")
        .bind(site, username)
        .first();
      if (!account || !(await verifyPassword(password, account.passwordHash))) {
        throw statusError("Invalid username or password", 401);
      }
      return createSession(db, account);
    },
    async requestPasswordReset(site, input, accountConfig) {
      await ensureSchema();
      if (!accountConfig.passwordReset.enabled) throw statusError("Password reset is disabled for this site", 403);
      if (accountConfig.email.mode === "none") throw statusError("Password reset requires email support", 403);
      const username = sanitizeText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
      const account = await db.prepare("select id, site, username, email from accounts where site = ? and lower(username) = lower(?)")
        .bind(site, username)
        .first();
      if (!account || !account.email || account.email !== email) return { ok: true };
      const token = crypto.randomUUID();
      await db.prepare("insert into reset_tokens (token, account_id, site, expires_at) values (?, ?, ?, ?)")
        .bind(token, account.id, site, Date.now() + accountConfig.passwordReset.ttlMs)
        .run();
      await accountConfig.passwordReset.onToken?.({ site, username: account.username, email: account.email, token });
      return {
        ok: true,
        token: accountConfig.passwordReset.exposeTokens ? token : undefined
      };
    },
    async confirmPasswordReset(site, input, accountConfig) {
      await ensureSchema();
      requireHasher();
      if (!accountConfig.passwordReset.enabled) throw statusError("Password reset is disabled for this site", 403);
      const token = sanitizeText(input.token, 200);
      const password = String(input.password || "");
      if (password.length < 8) throw statusError("Password must be at least 8 characters", 400);
      const reset = await db.prepare("select token, account_id as accountId, site, expires_at as expiresAt from reset_tokens where token = ?")
        .bind(token)
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
        db.prepare("delete from reset_tokens where token = ?").bind(token)
      ]);
      return { ok: true };
    },
    async identify(token, site) {
      await ensureSchema();
      const session = await db.prepare("select token, site, account_id as accountId, username from sessions where token = ?")
        .bind(token)
        .first();
      if (!session || session.site !== site) return null;
      return {
        type: "login",
        value: session.accountId,
        label: session.username
      };
    }
  };
}

async function createSession(db, account) {
  const session = {
    token: crypto.randomUUID(),
    site: account.site,
    accountId: account.id,
    username: account.username,
    createdAt: new Date().toISOString()
  };
  await db.prepare("insert into sessions (token, site, account_id, username, created_at) values (?, ?, ?, ?, ?)")
    .bind(session.token, session.site, session.accountId, session.username, session.createdAt)
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

async function rememberVote(db, thread, id, identity, maxVotesPerIdentity = 1) {
  if (!identity) throw statusError("Login is required to vote from this network", 401);
  const row = await db.prepare("select count(*) as count from votes where thread = ? and comment_id = ? and identity_type = ? and identity_value = ?")
    .bind(thread, id, identity.type, identity.value)
    .first();
  if (Number(row?.count || 0) >= maxVotesPerIdentity) {
    throw statusError("Vote limit reached for this identity", 429);
  }
  await db.prepare("insert into votes (thread, comment_id, identity_type, identity_value, label, created_at) values (?, ?, ?, ?, ?, ?)")
    .bind(thread, id, identity.type, identity.value, identity.label, new Date().toISOString())
    .run();
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
