import { createCommentHandler } from "../server/core.mjs";
import { createD1Store } from "../server/cloudflare-d1.js";

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
const handler = createCommentHandler({
  store: createD1Store({ db: d1 }),
  site: "worker-site",
  voteIdentity: {
    login: { enabled: false }
  }
});

let response = await handler(new Request("https://example.test/api/comments?thread=worker", {
  method: "POST",
  headers: { "content-type": "application/json" },
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
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id, action: "upvote" })
}));
payload = await response.json();
if (response.status !== 200 || payload.comments[0].score !== 1) {
  throw new Error("expected D1-backed voting");
}

const accountHandler = createCommentHandler({
  store: createD1Store({
    db: new D1Compat(),
    hashPassword: async password => `test:${password}`,
    verifyPassword: async (password, stored) => stored === `test:${password}`
  }),
  site: "worker-site"
});
response = await accountHandler(new Request("https://example.test/api/comments/signup?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
if (response.status !== 201 || !payload.token) {
  throw new Error("expected D1-backed signup");
}
response = await accountHandler(new Request("https://example.test/api/comments/login?site=worker-site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "Ada", password: "correct horse battery staple" })
}));
payload = await response.json();
if (response.status !== 201 || !payload.token) {
  throw new Error("expected D1-backed login");
}

console.log("cloudflare d1 store ok");
