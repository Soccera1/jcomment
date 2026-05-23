import { createCommentHandler } from "../server/core.mjs";
import { createD1Store } from "../server/cloudflare-d1.js";
import worker from "../server/cloudflare-worker.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

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
        db.prepare(sql).run(...values);
        return { success: true };
      }
    };
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true }));
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
let payload = await response.json();
if (response.status !== 201 || payload.count !== 1) {
  throw new Error("expected D1-backed comment creation");
}
const id = payload.comments[0].id;

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
payload = await response.json();
if (response.status !== 202 || payload.token || payload.ok !== true || response.headers.get("set-cookie")) {
  throw new Error("expected Worker HTTPS signup to avoid account existence disclosure by default");
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
response = await failedDeliveryHandler(new Request("https://example.test/api/comments/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1Reset", email: "d1-reset@example.test", password: "correct horse battery staple" })
}));
if (response.status !== 202) {
  throw new Error("expected D1 failed-delivery signup");
}
const savedError = console.error;
console.error = () => {};
response = await failedDeliveryHandler(new Request("https://example.test/api/comments/reset/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "D1Reset", email: "d1-reset@example.test" })
}));
console.error = savedError;
if (response.status !== 500 || failedDeliveryTokens.length !== 1) {
  throw new Error("expected D1 failed reset delivery to fail closed");
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
