# jcomment

Lightweight C99/WebAssembly comment widget for ordinary web pages. The widget is compiled with `zig cc` directly, no Emscripten runtime.

## What is included

- `src/widget.c` - the C99 wasm renderer. It escapes comment data and returns compact HTML fragments.
- `web/jcomment.js` - browser loader/custom element for `<j-comment-section>`.
- `demo/index.html` - static demo page.
- `server/` - reusable handlers and adapters for common hosting environments.
- `scripts/build.sh` - builds `dist/jcomment.wasm` and copies web/demo assets.

## Features

- Comment posting with author persistence in `localStorage`.
- Nested replies with compact visual indentation.
- Upvotes with server-side identity limits.
- Per-site login for voting without global jcomment accounts.
- Newest, oldest, and top sorting.
- Character counter and server-side length validation.
- Fetch-compatible server core with pagination metadata.
- Escaped HTML rendering in the C99 wasm module.

## Requirements

- Zig 0.14+
- SQLite 3 CLI for the native CGI server
- Node 24+ only for the JavaScript validation scripts and optional JavaScript adapters that use Node's native SQLite module

## Build

```sh
./scripts/build.sh
```

The build emits:

- `dist/jcomment.wasm`
- `dist/jcomment.js`
- `dist/demo/index.html`
- `dist/jcomment-cgi`

## Try the demo

```sh
npm run demo
```

Open `http://127.0.0.1:8787/demo/`. The demo runner is a small Zig HTTP server that serves `dist/` and delegates `/api/comments` to `dist/jcomment-cgi`.

## Embed

```html
<script type="module" src="/jcomment.js"></script>
<j-comment-section
  data-api="/api/comments"
  data-wasm="/jcomment.wasm"
  data-thread="post-123"
></j-comment-section>
```

Use one `data-thread` value per article, page, product, or other discussion surface. Multiple widgets can point at the same `data-api` and `data-site`; their comments stay separate as long as their `data-thread` values are different.

```html
<j-comment-section data-api="/api/comments" data-wasm="/jcomment.wasm" data-thread="article-a" data-site="example.com"></j-comment-section>
<j-comment-section data-api="/api/comments" data-wasm="/jcomment.wasm" data-thread="article-b" data-site="example.com"></j-comment-section>
```

The API accepts and returns JSON comments:

```json
{
  "comments": [
    {
      "id": "c1",
      "author": "Ada",
      "body": "First comment.",
      "createdAt": "2026-05-23T00:00:00.000Z"
    }
  ]
}
```

`POST /api/comments?thread=post-123` accepts `{ "author": "...", "body": "...", "parentId": "optional-comment-id" }`.

`PATCH /api/comments?thread=post-123` accepts `{ "id": "comment-id", "action": "upvote" }`.

`GET` also accepts `sort=newest|oldest|top`, `limit=100`, and `cursor=0`.

`POST /api/comments/signup?site=example.com` accepts `{ "username": "...", "password": "...", "email": "..." }`.

`POST /api/comments/login?site=example.com` accepts `{ "username": "...", "password": "..." }` and returns a bearer token scoped to that site.

`POST /api/comments/reset/request?site=example.com` accepts `{ "username": "...", "email": "..." }` when password reset is enabled.

`POST /api/comments/reset/confirm?site=example.com` accepts `{ "token": "...", "password": "..." }`.

Posting can optionally require a per-site login token. This is independent of IP vote storage: an IP address that is eligible for vote limiting still cannot post when login-required posting is enabled.

Invalid server configurations fail at startup or request initialization. For example, requiring login to post while login is disabled is invalid, as is enabling password reset while email collection is disabled. `BROKEN_CONFIG=1` downgrades these errors to warnings, but this is explicitly unsupported and may break any number of things; use it only to inspect or temporarily recover a deployment.

## Vote Identity And Privacy

By default, jcomment does not store upvoter IP addresses. Voting requires a per-site account token, created by the same site that hosts the comments. These accounts are local to that website's jcomment deployment; they are not global jcomment accounts.

This default is intentional. IP addresses can be personal data, and using them to enforce voting limits can trigger privacy, consent, disclosure, retention, security, and data-subject-rights obligations. The safest general-purpose deployment is the per-site login flow.

Localhost is the only built-in exception. Requests from `localhost`, `127.0.0.0/8`, or `::1` can use IP-style vote limiting even when `ipStorage.enabled` is false, because this is useful during development. This exception is treated as a separate `localhost` vote identity and should not be used as a privacy model for deployed traffic.

### High-Risk IP Storage Mode

Server administrators can opt in to IP-based vote limiting, but this mode should be treated as legally sensitive. When enabled, jcomment stores each upvoter IP address with the vote record indefinitely so that future votes from the same identity can be counted against `maxVotesPerIdentity`.

Do not enable `ipStorage.enabled` unless all of these are true:

- You have confirmed that storing IP addresses indefinitely for vote limiting is lawful for the specific users, regions, and sites involved.
- Your privacy notice explains that IP addresses are stored for vote-abuse prevention or vote limiting.
- You have a lawful basis, consent mechanism, or equivalent legal justification where required.
- You have considered retention limits, deletion requests, access requests, breach obligations, and security controls.
- You have configured `allowRanges` and `denyRanges` so that IP addresses from prohibited or uncertain regions are not stored.
- You provide the per-site login flow for users whose IP addresses must not be stored.

This README is not legal advice. If there is any uncertainty, keep IP storage disabled and use login-based voting.

### Site-Local Accounts

jcomment accounts are scoped to one site. A username and password registered on one jcomment deployment do not work on any other jcomment site unless that site separately creates the same account.

Passwords are hashed before storage. The JavaScript server core uses Node's native `crypto.argon2`; the Zig CGI server uses `std.crypto.pwhash.argon2` in Argon2id mode. The Cloudflare Worker adapter uses WebCrypto PBKDF2-SHA-256 by default because Workers do not expose Argon2id; deployments that need Argon2id on Workers can provide a `JCOMMENT_ARGON2ID` service binding.

Email collection is configurable per site:

```js
const handleComments = createCommentHandler({
  voteIdentity: {
    accounts: {
      email: "none" // "none", "optional", or "required"
    }
  }
});
```

Password resets are available only when email is not `none`:

```js
const handleComments = createCommentHandler({
  voteIdentity: {
    accounts: {
      email: "required",
      passwordReset: {
        enabled: true,
        onToken: async ({ email, token }) => {
          // Send the token through your site's email provider.
        }
      }
    }
  }
});
```

jcomment stores comments, votes, accounts, sessions, and reset tokens in SQLite. The JavaScript core defaults to `jcomment.sqlite3`; set `JCOMMENT_DB` or pass `createSqliteStore({ path })` to choose a database file. Password reset tokens should be sent through the site's own email provider.

### Disabling Login Or Voting

You can disable the per-site login feature:

```js
const handleComments = createCommentHandler({
  voteIdentity: {
    login: { enabled: false }
  }
});
```

If both login and IP storage are disabled while voting remains enabled, jcomment emits a server startup warning. In that configuration, the server has no durable identity for non-localhost voters, so upvotes can be easily manipulated by repeated requests. Use this only for low-stakes demos or sites where vote integrity does not matter.

If you do not want login and cannot lawfully or safely store IP addresses, the recommended production setting is to disable voting:

```js
const handleComments = createCommentHandler({
  voteIdentity: {
    voting: { enabled: false },
    login: { enabled: false }
  }
});
```

For the native CGI server, use environment variables:

```sh
JCOMMENT_EMAIL_MODE=required # none, optional, or required
JCOMMENT_PASSWORD_RESET_ENABLED=1
JCOMMENT_LOGIN_ENABLED=0
JCOMMENT_VOTING_ENABLED=0
JCOMMENT_REQUIRE_LOGIN_TO_POST=1
BROKEN_CONFIG=0
```

### Third-Party IP Range Recommendation

A practical approach is to use MaxMind GeoIP2 Enterprise as the IP intelligence source, then apply an allowlist that your organization has approved separately. MaxMind data can provide the network in CIDR format, country and subdivision fields, EU membership, ISP/ASN fields, connection type, and a `user_type` field. Use those fields to decide whether an IP is in a counsel-approved residential range before adding it to `allowRanges`.

Do not use any third-party IP database as the authority for whether consent is legally required. The provider can help classify and geolocate an IP address; it cannot determine your legal basis, the user's real residence, whether a privacy law applies, whether your notice is sufficient, or whether indefinite storage is allowed for your exact purpose.

Recommended operating model:

- Keep `ipStorage.enabled` off until a privacy review approves specific countries, subdivisions, and use cases.
- Build a scheduled job that imports MaxMind GeoIP2 Enterprise data and generates `allowRanges` only for approved jurisdictions.
- Include only ranges classified as residential by your policy, such as MaxMind `user_type` values that your review has accepted.
- Exclude EU member states by default using MaxMind's `is_in_european_union` field unless counsel explicitly approves them.
- Exclude VPNs, proxies, hosting providers, Tor exits, and residential proxies using MaxMind Anonymous IP data.
- Use confidence and accuracy fields conservatively; if location data is missing, low-confidence, disputed, or only broad enough to be ambiguous, require login instead of IP storage.
- Refresh the database on the vendor's required update schedule and treat stale data as ineligible for IP storage.
- Log which database version and policy version produced each range so you can audit decisions later.

Example opt-in configuration:

```js
import { createCommentHandler, createSqliteStore } from "./server/core.mjs";

const handleComments = createCommentHandler({
  store: createSqliteStore({ path: "/var/lib/jcomment/jcomment.sqlite3" }),
  site: "example.com",
  voteIdentity: {
    maxVotesPerIdentity: 2,
    ipStorage: {
      enabled: true,
      allowRanges: ["203.0.113.0/24"],
      denyRanges: ["203.0.113.64/26"]
    }
  }
});
```

When `ipStorage.enabled` is true, jcomment emits a server startup warning. That warning is deliberately noisy: this mode can be unlawful in many jurisdictions if enabled without the required analysis, notices, and safeguards.

`allowRanges` and `denyRanges` accept exact IPv4/IPv6 addresses, CIDR ranges, or `*`. Deny ranges take precedence. If `allowRanges` is empty, every IP not in `denyRanges` is eligible for IP tracking.

Prefer an allowlist over a denylist. A broad denylist can miss users whose location, VPN, proxy, carrier NAT, or hosting network does not map cleanly to the ranges you expect. If a request IP is outside `allowRanges`, or inside `denyRanges`, jcomment refuses IP-based voting and requires per-site login instead.

### Per-Site Login Voting

The login flow exists for users and regions where IP storage is prohibited, risky, or unwanted. Login tokens are scoped to one `site` value and are not shared across unrelated jcomment deployments.

Treat login tokens as credentials: serve jcomment over HTTPS, protect the SQLite database, rotate or revoke tokens when needed, and document how users can request deletion if applicable.

## Hosting Integrations

The `server/` directory provides small adapters:

- `server/cgi/jcomment_cgi.zig` - native Zig CGI server for generic no-Node hosting.
- `server/express.mjs` - Express route adapter.
- `server/cloudflare-worker.js` - Cloudflare Workers module.
- `server/vercel.mjs` - Vercel serverless handler.
- `server/netlify.mjs` - Netlify Function handler.

The Zig CGI server is the generic server. The JavaScript files are integration adapters for JavaScript-based hosts.

The Express adapter uses the same file-backed SQLite store as the JavaScript core. Vercel and Netlify functions must be pointed at a durable SQLite database path with `JCOMMENT_DB`; do not rely on the platform's ephemeral function filesystem for production data.

The Cloudflare Worker adapter uses Cloudflare D1. Bind a D1 database as `JCOMMENT_DB`. Because Workers cannot use Node's `node:sqlite` module, storage goes through D1. Account signup/login works out of the box with WebCrypto PBKDF2-SHA-256. If you need Argon2id on Workers, provide a service binding exposed as `JCOMMENT_ARGON2ID` with `hashPassword(password)` and `verifyPassword(password, stored)` methods; the Worker will use that instead of PBKDF2.

Common Cloudflare Worker environment variables:

```sh
JCOMMENT_SITE=example.com
JCOMMENT_LOGIN_ENABLED=0
JCOMMENT_VOTING_ENABLED=1
JCOMMENT_REQUIRE_LOGIN_TO_POST=0
JCOMMENT_MAX_VOTES_PER_IDENTITY=1
JCOMMENT_IP_STORAGE_ENABLED=0
JCOMMENT_IP_ALLOW_RANGES=203.0.113.0/24
JCOMMENT_IP_DENY_RANGES=203.0.113.64/26
JCOMMENT_EMAIL_MODE=none
JCOMMENT_PASSWORD_RESET_ENABLED=0
BROKEN_CONFIG=0
```

## Generic No-Node Server

For generic hosting, use the native CGI binary built at `dist/jcomment-cgi`. It is written in Zig and compiled with `zig build-exe`; it does not require Node, npm, Bun, Emscripten, or a JavaScript runtime on the server.

The CGI binary supports the same basic API shape:

- `GET /api/comments?thread=post-123`
- `POST /api/comments?thread=post-123`
- `PATCH /api/comments?thread=post-123`
- `POST /api/comments/signup?site=example.com`
- `POST /api/comments/login?site=example.com`
- `POST /api/comments/reset/request?site=example.com`
- `POST /api/comments/reset/confirm?site=example.com`

Set `JCOMMENT_DATA_DIR` to choose the directory for `jcomment.sqlite3`, which stores comments, votes, accounts, sessions, and reset tokens. If unset, it uses `/tmp/jcomment`, which is suitable only for local testing.

Example Apache-style CGI environment:

```apache
SetEnv JCOMMENT_DATA_DIR /var/lib/jcomment
ScriptAlias /api/comments /usr/local/libexec/jcomment-cgi
ScriptAlias /api/comments/login /usr/local/libexec/jcomment-cgi/login
ScriptAlias /api/comments/signup /usr/local/libexec/jcomment-cgi/signup
ScriptAlias /api/comments/reset/request /usr/local/libexec/jcomment-cgi/reset/request
ScriptAlias /api/comments/reset/confirm /usr/local/libexec/jcomment-cgi/reset/confirm
```

The CGI server keeps the localhost development exception for voting. For deployed non-localhost traffic, voting requires the per-site login flow unless `JCOMMENT_LOGIN_ENABLED=0` is set. If login is disabled and voting remains enabled, upvotes are intentionally low-integrity and easy to manipulate; set `JCOMMENT_VOTING_ENABLED=0` when that is not acceptable.

Set `JCOMMENT_REQUIRE_LOGIN_TO_POST=1` to reject comment posting unless the request includes a valid bearer token for that site. This does not affect reading comments.

## License

jcomment is licensed under the Mozilla Public License Version 2.0. See `LICENSE`.
