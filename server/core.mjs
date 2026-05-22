export function createMemoryStore(seed = {}) {
  return createSqliteStore({ path: ":memory:", seed });
}

export function createSqliteStore({ path = process.env.JCOMMENT_DB || "jcomment.sqlite3", seed = {} } = {}) {
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(path);
  initDb(db);
  for (const [thread, comments] of Object.entries(seed)) {
    for (const comment of comments.map(normalizeComment)) {
      db.prepare("insert or ignore into comments (id, thread, parent_id, author, body, created_at, score) values (?, ?, ?, ?, ?, ?, ?)")
        .run(comment.id, thread, comment.parentId, comment.author, comment.body, comment.createdAt, comment.score);
    }
  }

  return {
    async list(thread, options = {}) {
      return listThread(db, thread, options);
    },
    async add(thread, input) {
      const parentId = sanitizeText(input.parentId, 120);
      if (parentId && !db.prepare("select 1 from comments where thread = ? and id = ?").get(thread, parentId)) {
        throw statusError("Parent comment was not found", 404);
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
      db.prepare("insert into comments (id, thread, parent_id, author, body, created_at, score) values (?, ?, ?, ?, ?, ?, ?)")
        .run(comment.id, thread, comment.parentId, comment.author, comment.body, comment.createdAt, comment.score);
      return listThread(db, thread, { sort: input.sort });
    },
    async react(thread, id, delta = 1, options = {}) {
      const comment = db.prepare("select id, score from comments where thread = ? and id = ?").get(thread, id);
      if (!comment) throw statusError("Comment was not found", 404);
      rememberVote(db, thread, id, options.identity, options.maxVotesPerIdentity);
      db.prepare("update comments set score = ? where thread = ? and id = ?")
        .run(clampScore((comment.score || 0) + delta), thread, id);
      return listThread(db, thread, options);
    },
    async signup(site, input, accountConfig) {
      const username = sanitizeText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
      const password = String(input.password || "");
      if (!username) throw statusError("Username is required", 400);
      if (password.length < 8) throw statusError("Password must be at least 8 characters", 400);
      if (accountConfig.email.mode === "required" && !email) throw statusError("Email is required", 400);
      if (accountConfig.email.mode === "none" && email) throw statusError("Email is disabled for this site", 400);
      if (db.prepare("select 1 from accounts where site = ? and lower(username) = lower(?)").get(site, username)) {
        throw statusError("Account already exists for this site", 409);
      }
      const account = {
        id: crypto.randomUUID(),
        site,
        username,
        email: accountConfig.email.mode === "none" ? "" : email,
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString()
      };
      db.prepare("insert into accounts (id, site, username, email, password_hash, created_at) values (?, ?, ?, ?, ?, ?)")
        .run(account.id, account.site, account.username, account.email, account.passwordHash, account.createdAt);
      return createSession(db, account);
    },
    async login(site, input) {
      const username = sanitizeText(input.username || input.name, 80);
      const password = String(input.password || "");
      const account = db.prepare("select id, site, username, email, password_hash as passwordHash, created_at as createdAt from accounts where site = ? and lower(username) = lower(?)")
        .get(site, username);
      if (!account || !(await verifyPassword(password, account.passwordHash))) {
        throw statusError("Invalid username or password", 401);
      }
      return createSession(db, account);
    },
    async requestPasswordReset(site, input, accountConfig) {
      if (!accountConfig.passwordReset.enabled) throw statusError("Password reset is disabled for this site", 403);
      if (accountConfig.email.mode === "none") throw statusError("Password reset requires email support", 403);
      const username = sanitizeText(input.username || input.name, 80);
      const email = sanitizeEmail(input.email);
      const account = db.prepare("select id, site, username, email from accounts where site = ? and lower(username) = lower(?)")
        .get(site, username);
      if (!account || !account.email || account.email !== email) return { ok: true };
      const token = crypto.randomUUID();
      db.prepare("insert into reset_tokens (token, account_id, site, expires_at) values (?, ?, ?, ?)")
        .run(token, account.id, site, Date.now() + accountConfig.passwordReset.ttlMs);
      await accountConfig.passwordReset.onToken?.({ site, username: account.username, email: account.email, token });
      return {
        ok: true,
        token: accountConfig.passwordReset.exposeTokens ? token : undefined
      };
    },
    async confirmPasswordReset(site, input, accountConfig) {
      if (!accountConfig.passwordReset.enabled) throw statusError("Password reset is disabled for this site", 403);
      const token = sanitizeText(input.token, 200);
      const password = String(input.password || "");
      if (password.length < 8) throw statusError("Password must be at least 8 characters", 400);
      const reset = db.prepare("select token, account_id as accountId, site, expires_at as expiresAt from reset_tokens where token = ?")
        .get(token);
      if (!reset || reset.site !== site || reset.expiresAt < Date.now()) {
        throw statusError("Invalid or expired reset token", 400);
      }
      const account = db.prepare("select id from accounts where id = ? and site = ?").get(reset.accountId, site);
      if (!account) throw statusError("Invalid or expired reset token", 400);
      db.prepare("update accounts set password_hash = ? where id = ?").run(await hashPassword(password), reset.accountId);
      db.prepare("delete from reset_tokens where token = ?").run(token);
      return { ok: true };
    },
    async identify(token, site) {
      const session = db.prepare("select token, site, account_id as accountId, username from sessions where token = ?").get(token);
      if (!session || session.site !== site) return null;
      return {
        type: "login",
        value: session.accountId,
        label: session.username
      };
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

export function createCommentHandler({
  store = createSqliteStore(),
  cors = true,
  site = "default",
  voteIdentity = {},
  posting = {},
  brokenConfig = isBrokenConfigEnabled()
} = {}) {
  const voteConfig = normalizeVoteIdentityConfig(voteIdentity);
  const postingConfig = normalizePostingConfig(posting);
  validateConfig({ voteConfig, postingConfig, brokenConfig });
  warnForIpVoteStorage(voteConfig);
  warnForUnidentifiedVoting(voteConfig);

  return async function handleCommentRequest(request) {
    const url = new URL(request.url);
    const thread = url.searchParams.get("thread") || "default";
    const sort = url.searchParams.get("sort") || "newest";
    const limit = parsePositiveInt(url.searchParams.get("limit"), 100);
    const cursor = parsePositiveInt(url.searchParams.get("cursor"), 0);
    const requestSite = sanitizeText(url.searchParams.get("site"), 120) || site;

    if (request.method === "OPTIONS") {
      return json({}, { status: 204, cors });
    }

    if (request.method === "POST" && url.pathname.endsWith("/signup")) {
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, input => store.signup(requestSite, input, voteConfig.accounts));
    }

    if (request.method === "POST" && url.pathname.endsWith("/login")) {
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, input => store.login(requestSite, input));
    }

    if (request.method === "POST" && url.pathname.endsWith("/reset/request")) {
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, input => store.requestPasswordReset(requestSite, input, voteConfig.accounts));
    }

    if (request.method === "POST" && url.pathname.endsWith("/reset/confirm")) {
      if (!voteConfig.login.enabled) return json({ error: "Login is disabled for this site" }, { status: 403, cors });
      return accountJson(request, cors, input => store.confirmPasswordReset(requestSite, input, voteConfig.accounts));
    }

    if (request.method === "GET") {
      const payload = await store.list(thread, { sort, limit, cursor });
      return json({ ...payload, capabilities: publicCapabilities(voteConfig, postingConfig) }, { cors });
    }

    if (request.method === "POST") {
      if (postingConfig.requireLogin) {
        if (!voteConfig.login.enabled) {
          return json({ error: "Posting requires login, but login is disabled for this site" }, { status: 403, cors });
        }
        const token = bearerToken(request.headers.get("authorization"));
        const identity = token ? await store.identify(token, requestSite) : null;
        if (!identity) return json({ error: "Login is required to post comments" }, { status: 401, cors });
      }
      let input;
      try {
        input = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, { status: 400, cors });
      }
      try {
        return json(await store.add(thread, { ...input, sort }), { status: 201, cors });
      } catch (error) {
        return json({ error: error.message }, { status: error.status || 500, cors });
      }
    }

    if (request.method === "PATCH") {
      if (!voteConfig.voting.enabled) return json({ error: "Voting is disabled for this site" }, { status: 403, cors });
      let input;
      try {
        input = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, { status: 400, cors });
      }
      try {
        const delta = input.action === "downvote" ? -1 : 1;
        const identity = await resolveVoteIdentity(request, requestSite, store, voteConfig);
        return json(await store.react(thread, sanitizeText(input.id, 120), delta, {
          sort,
          limit,
          cursor,
          identity,
          maxVotesPerIdentity: voteConfig.maxVotesPerIdentity
        }), { cors });
      } catch (error) {
        return json({ error: error.message }, { status: error.status || 500, cors });
      }
    }

    return json({ error: "Method not allowed" }, { status: 405, cors, allow: "GET, POST, PATCH, OPTIONS" });
  };
}

export function json(body, { status = 200, cors = true, allow } = {}) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (cors) {
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
    headers.set("access-control-allow-headers", "authorization, content-type");
  }
  if (allow) headers.set("allow", allow);
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

async function accountJson(request, cors, fn) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400, cors });
  }
  try {
    return json(await fn(input || {}), { status: 201, cors });
  } catch (error) {
    return json({ error: error.message }, { status: error.status || 500, cors });
  }
}

function initDb(db) {
  db.exec(`
    create table if not exists comments (
      id text primary key,
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
      comment_id text not null,
      identity_type text not null,
      identity_value text not null,
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
      created_at text not null
    );
    create table if not exists reset_tokens (
      token text primary key,
      account_id text not null,
      site text not null,
      expires_at integer not null
    );
  `);
}

function listThread(db, thread, options) {
  const comments = db.prepare("select id, parent_id as parentId, author, body, created_at as createdAt, score from comments where thread = ?")
    .all(thread);
  return listComments(comments, options);
}

function createSession(db, account) {
  const session = {
    token: crypto.randomUUID(),
    site: account.site,
    accountId: account.id,
    username: account.username,
    createdAt: new Date().toISOString()
  };
  db.prepare("insert into sessions (token, site, account_id, username, created_at) values (?, ?, ?, ?, ?)")
    .run(session.token, session.site, session.accountId, session.username, session.createdAt);
  return {
    user: {
      username: session.username,
      name: session.username,
      createdAt: session.createdAt
    },
    token: session.token
  };
}

function rememberVote(db, thread, id, identity, maxVotesPerIdentity = 1) {
  if (!identity) throw statusError("Login is required to vote from this network", 401);
  const row = db.prepare("select count(*) as count from votes where thread = ? and comment_id = ? and identity_type = ? and identity_value = ?")
    .get(thread, id, identity.type, identity.value);
  const count = Number(row?.count || 0);
  if (count >= maxVotesPerIdentity) throw statusError("Vote limit reached for this identity", 429);
  db.prepare("insert into votes (thread, comment_id, identity_type, identity_value, label, created_at) values (?, ?, ?, ?, ?, ?)")
    .run(thread, id, identity.type, identity.value, identity.label, new Date().toISOString());
}

async function resolveVoteIdentity(request, site, store, config) {
  const token = bearerToken(request.headers.get("authorization"));
  if (token && config.login.enabled) {
    const identity = await store.identify(token, site);
    if (identity) return identity;
  }

  const ip = clientIp(request);
  if (ip && isLocalhostIp(ip)) return { type: "localhost", value: ip, label: "localhost" };
  if (config.ipStorage.enabled && ip && shouldTrackIp(ip, config.ipStorage)) {
    return { type: "ip", value: ip, label: "ip" };
  }
  if (!config.login.enabled && !config.ipStorage.enabled) {
    return { type: "anonymous", value: crypto.randomUUID(), label: "anonymous" };
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
      allowRanges: config.ipStorage?.allowRanges || [],
      denyRanges: config.ipStorage?.denyRanges || []
    }
  };
}

function normalizePostingConfig(config) {
  return {
    requireLogin: Boolean(config.requireLogin)
  };
}

function validateConfig({ voteConfig, postingConfig, brokenConfig }) {
  const errors = [];
  if (postingConfig.requireLogin && !voteConfig.login.enabled) {
    errors.push("posting.requireLogin requires voteIdentity.login.enabled to be true");
  }
  if (voteConfig.accounts.passwordReset.requested && voteConfig.accounts.email.mode === "none") {
    errors.push("password reset requires account email mode to be optional or required");
  }
  if (errors.length === 0) return;
  const message = `Invalid jcomment configuration: ${errors.join("; ")}`;
  if (brokenConfig) {
    console.warn(`${message}. BROKEN_CONFIG=1 is unsupported and may break any number of things.`);
    return;
  }
  throw new Error(message);
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
      exposeTokens: Boolean(config.passwordReset?.exposeTokens),
      onToken: config.passwordReset?.onToken
    },
    public: {
      email: emailMode,
      passwordReset: resetEnabled
    }
  };
}

function publicCapabilities(config, postingConfig) {
  return {
    voting: config.voting.enabled,
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
    "Upvotes have no durable server-side identity and can be easily manipulated. " +
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

function clientIp(request) {
  const forwarded = request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    String(request.headers.get("x-forwarded-for") || "").split(",")[0];
  const ip = normalizeIp(forwarded);
  if (ip) return ip;
  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost") return "127.0.0.1";
  return normalizeIp(hostname);
}

function isLocalhostIp(ip) {
  return ip === "localhost" || ip === "::1" || ip === "0:0:0:0:0:0:0:1" || ip.startsWith("127.");
}

function bearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? sanitizeText(match[1], 200) : "";
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
