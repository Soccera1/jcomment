import { createCommentHandler, createMemoryStore } from "../server/core.mjs";

const handler = createCommentHandler({ store: createMemoryStore(), cors: true, site: "check-site" });
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
  body: JSON.stringify({ id: parentId, action: "upvote" })
}));
if (response.status !== 401) {
  throw new Error("expected login requirement for voting without IP tracking");
}

const localHandler = createCommentHandler({
  store: createMemoryStore({
    local: [{ id: "local-comment", author: "Ada", body: "Local", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  voteIdentity: {
    maxVotesPerIdentity: 1
  }
});
response = await localHandler(new Request("http://localhost/api/comments?thread=local", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "local-comment", action: "upvote" })
}));
payload = await response.json();
if (response.status !== 200 || payload.comments[0].score !== 1) {
  throw new Error("expected localhost vote without IP tracking opt-in");
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
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
const token = payload.token;
if (response.status !== 201 || !token) {
  throw new Error("expected site signup token");
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

response = await handler(new Request("http://example.test/api/comments/login?site=check-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
if (response.status !== 201 || !payload.token) {
  throw new Error("expected account login token");
}

const postLoginHandler = createCommentHandler({
  store: createMemoryStore(),
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
payload = await response.json();
const postToken = payload.token;
response = await postLoginHandler(new Request("http://example.test/api/comments?thread=post-login&site=post-site", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${postToken}`, "x-forwarded-for": "203.0.113.7" },
  body: JSON.stringify({ author: "Ada", body: "Posted with login" })
}));
payload = await response.json();
if (response.status !== 201 || payload.comments[0].body !== "Posted with login") {
  throw new Error("expected logged-in posting to succeed");
}

let resetToken;
const resetHandler = createCommentHandler({
  store: createMemoryStore(),
  cors: true,
  site: "reset-site",
  voteIdentity: {
    accounts: {
      email: "required",
      passwordReset: {
        enabled: true,
        exposeTokens: true,
        onToken: ({ token }) => {
          resetToken = token;
        }
      }
    }
  }
});
response = await resetHandler(new Request("http://example.test/api/comments/signup?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Lin", email: "lin@example.test", password: "old password value" })
}));
if (response.status !== 201) {
  throw new Error("expected required-email signup");
}
response = await resetHandler(new Request("http://example.test/api/comments/reset/request?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Lin", email: "lin@example.test" })
}));
payload = await response.json();
if (response.status !== 201 || !resetToken || payload.token !== resetToken) {
  throw new Error("expected reset token");
}
response = await resetHandler(new Request("http://example.test/api/comments/reset/confirm?site=reset-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: resetToken, password: "new password value" })
}));
if (response.status !== 201) {
  throw new Error("expected password reset confirmation");
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

const warnings = [];
console.warn = message => warnings.push(message);
const anonymousHandler = createCommentHandler({
  store: createMemoryStore({
    anon: [{ id: "anon-comment", author: "Ada", body: "Anonymous voting", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
  voteIdentity: {
    login: { enabled: false }
  }
});
console.warn = originalWarn;
if (!warnings.some(message => message.includes("can be easily manipulated"))) {
  throw new Error("expected unidentified voting warning");
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
if (response.status !== 200 || payload.comments[0].score !== 1) {
  throw new Error("expected anonymous vote when login and IP storage are disabled");
}

const disabledHandler = createCommentHandler({
  store: createMemoryStore({
    off: [{ id: "off-comment", author: "Ada", body: "Disabled voting", createdAt: "2026-05-23T00:00:00.000Z" }]
  }),
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
  }
});
console.warn = originalWarn;
if (!warnings.some(message => message.includes("stores upvoter IP addresses indefinitely"))) {
  throw new Error("expected IP storage warning");
}

const ipUrl = "http://example.test/api/comments?thread=ip";
for (const expectedScore of [1, 2]) {
  response = await ipHandler(new Request(ipUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ id: "ip-comment", action: "upvote" })
  }));
  payload = await response.json();
  if (response.status !== 200 || payload.comments[0].score !== expectedScore) {
    throw new Error("expected IP vote to count within configured limit");
  }
}
response = await ipHandler(new Request(ipUrl, {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
  body: JSON.stringify({ id: "ip-comment", action: "upvote" })
}));
if (response.status !== 429) {
  throw new Error("expected IP vote limit");
}

response = await ipHandler(new Request(ipUrl, {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
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
  }
});
console.warn = originalWarn;
response = await ipNoLoginHandler(new Request(ipUrl, {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
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

const multiHandler = createCommentHandler({ store: createMemoryStore(), cors: true, site: "multi-site" });
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

console.log("server handler ok");
