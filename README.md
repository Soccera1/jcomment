# jcomment

Lightweight JavaScript comment widget for ordinary web pages.

## What is included

- `web/jcomment.js` - browser custom element for `<j-comment-section>`.
- `demo/index.html` - static demo page.
- `server/` - reusable handlers and adapters for common hosting environments.
- `scripts/build.sh` - copies the browser widget and demo assets without requiring Zig.

## Features

- Comment posting with author persistence in `localStorage`.
- Nested replies with compact visual indentation.
- Upvotes with server-side identity limits.
- Per-site login for voting without global jcomment accounts.
- Newest, oldest, and top sorting.
- Character counter and server-side length validation.
- Fetch-compatible server core with pagination metadata.
- Escaped HTML rendering in the browser custom element.

## Requirements

- Node 24+ for the JavaScript validation scripts and JavaScript adapters that use Node's native SQLite module
- SQLite 3 CLI only for the native CGI server
- Zig 0.14+ only for building the native CGI server or local Zig demo runner

## Build

```sh
npm run build
```

The build emits:

- `dist/jcomment.js`
- `dist/demo/index.html`

This default build does not require Zig.

To build the native CGI server:

```sh
npm run build:cgi
```

That emits `dist/jcomment-cgi` and requires Zig 0.14+.

To build everything, including the CGI server and local demo runner:

```sh
npm run build:all
```

The default validation path also avoids Zig:

```sh
npm run check
```

Run `npm run check:cgi` or `npm run check:all` when you want to validate the Zig CGI server too.

## Try the demo

```sh
npm run demo
```

Open `http://127.0.0.1:8787/demo/`. The demo runner is a small Zig HTTP server that serves only the public demo assets from `dist/` and delegates `/api/comments` to `dist/jcomment-cgi`.

`npm run demo` requires Zig because it builds and runs the local Zig demo server. Deploying the browser widget, Express adapter, Vercel/Netlify adapters, or Cloudflare Worker does not require Zig.

## Embed

```html
<script type="module" src="/jcomment.js"></script>
<j-comment-section
  data-api="/api/comments"
  data-thread="post-123"
></j-comment-section>
```

Use one `data-thread` value per article, page, product, or other discussion surface. Multiple widgets can point at the same `data-api`; their comments stay separate as long as their `data-thread` values are different.

```html
<j-comment-section data-api="/api/comments" data-thread="article-a"></j-comment-section>
<j-comment-section data-api="/api/comments" data-thread="article-b"></j-comment-section>
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

`GET` also accepts `sort=newest|oldest|top`, `limit=100`, `replyLimit=50`, and `cursor=0`. `limit` caps root comments per page; `replyLimit` caps replies returned per root comment.

`POST /api/comments/signup` accepts `{ "username": "...", "password": "...", "email": "..." }`.

`POST /api/comments/login` accepts `{ "username": "...", "password": "..." }`. Cookie-session deployments set an HttpOnly session cookie and do not expose a bearer token; bearer-token-only deployments return a token scoped to the server-configured site.

`POST /api/comments/reset/request` accepts `{ "username": "...", "email": "..." }` when password reset is enabled.

`POST /api/comments/reset/confirm` accepts `{ "token": "...", "password": "..." }`.

The JavaScript handler accepts only the configured API base and documented auth subpaths. The default base is `/api/comments`; pass `apiPath: "/your/comments/path"` to `createCommentHandler` when mounting the reusable handler somewhere else.

The server owns the site/auth realm. Query-string `site` values and widget `data-site` values are not trusted for authorization; configure `site` in JavaScript adapters, `JCOMMENT_SITE` in Worker/Vercel/Netlify deployments, or `JCOMMENT_SITE`/`SERVER_NAME` in CGI deployments. Site realm values are exact database partition keys: they must not contain control characters or surrounding whitespace, and must be at most 120 bytes.

Duplicate signup requests return a generic accepted response by default instead of revealing whether a username already exists. JavaScript deployments can opt back into explicit duplicate errors with `voteIdentity.accounts.discloseAccountExistence = true`; CGI and Worker deployments can set `JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE=1`.

Signup rejects reserved usernames by default: `admin`, `administrator`, `moderator`, `mod`, `staff`, `system`, `anonymous`, and `jcomment`. JavaScript deployments can override this list with `voteIdentity.accounts.reservedUsernames`; CGI and Worker deployments can set `JCOMMENT_RESERVED_USERNAMES` to a comma-separated list.

Posting can optionally require a per-site login token. This is independent of IP vote storage: an IP address that is eligible for vote limiting still cannot post when login-required posting is enabled.

When login-required posting is enabled, the stored comment author is taken from the authenticated account username. The browser still shows the name field for unauthenticated deployments, but authenticated posts cannot spoof another display name by changing request JSON.

Invalid server configurations fail at startup or request initialization. For example, requiring login to post while login is disabled is invalid, as is enabling password reset while email collection is disabled. Worker and CGI deployments also reject malformed boolean or positive-integer security environment variables instead of silently falling back to defaults. `BROKEN_CONFIG=1` downgrades these errors to warnings, but this is explicitly unsupported and may break any number of things; use it only to inspect or temporarily recover a deployment.

## Vote Identity And Privacy

By default, jcomment does not store upvoter IP addresses. Voting requires a per-site account token, created by the same site that hosts the comments. These accounts are local to that website's jcomment deployment; they are not global jcomment accounts.

This default is intentional. IP addresses can be personal data, and using them to enforce voting limits can trigger privacy, consent, disclosure, retention, security, and data-subject-rights obligations. The safest general-purpose deployment is the per-site login flow.

Localhost voting is available only when explicitly enabled for development with `voteIdentity.ipStorage.localhost = true` and the adapter supplies a trusted client IP such as `127.0.0.1` or `::1`. jcomment no longer infers localhost identity from the request URL or `Host` header.

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

Passwords are hashed before storage. The JavaScript server core uses Node's native `crypto.argon2`; the Zig CGI server uses `std.crypto.pwhash.argon2` in Argon2id mode. The Cloudflare Worker adapter requires a `JCOMMENT_ARGON2ID` service binding for account support.

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

Password resets are available only when email is not `none` and a token delivery callback is configured:

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

jcomment stores comments, votes, accounts, sessions, and reset tokens in SQLite. The JavaScript core defaults to `jcomment.sqlite3`; set `JCOMMENT_DB` or pass `createSqliteStore({ path })` to choose a database file. The built-in JavaScript SQLite store rejects group- or world-writable database directories, symlinked database directories, final database-path and sidecar-path symlinks, and sets the database file mode, plus any existing SQLite sidecar files, to `0600` after initialization; deploy it in a private directory so backups inherit the same access boundary. Session and reset tokens are stored as SHA-256 digests, and raw password reset tokens should be sent through the site's own email provider.

Login sessions expire after 30 days by default. For JavaScript deployments, set `voteIdentity.accounts.session.ttlMs` to choose a different lifetime. Password reset tokens expire after one hour by default through `voteIdentity.accounts.passwordReset.ttlMs`, and password reset invalidates existing sessions for that account.

If a valid password reset token is already pending for an account, another reset request returns the same generic success response without issuing a new token. This avoids account-specific reset email floods while preserving account enumeration resistance. If reset-token delivery fails, jcomment deletes the newly created token, logs the delivery failure server-side, and still returns the same generic success response so delivery outages do not reveal which accounts exist.

For HTTPS requests, signup and login responses use HttpOnly cookie sessions by default so the browser widget does not need JavaScript-readable session tokens. Plain HTTP development requests still receive bearer tokens unless cookie sessions are explicitly enabled with `secure: false`; the browser widget keeps those fallback bearer tokens in memory only and does not persist them to `localStorage` or `sessionStorage`.

```js
const handleComments = createCommentHandler({
  security: {
    sessionCookie: {
      enabled: true,
      secure: true,
      sameSite: "Lax"
    }
  }
});
```

When cookie sessions are enabled, signup and login responses set a `jcomment_session` HttpOnly cookie and never expose the raw token. Use cookies for browser deployments; use bearer tokens only for non-browser API clients or local HTTP development.

The JavaScript handler includes rate limits for signup, login, password reset requests, posting, and voting. The built-in SQLite and D1 stores persist rate-limit counters in the same database as comments and sessions. Custom stores must provide a `checkRateLimit(key, limit, windowMs)` method when rate limiting is enabled; in-process counters require an explicit `security.rateLimit.allowInMemory = true` opt-in and are suitable only for single-process development or low-risk deployments. State-changing requests fail closed when no trusted client IP is available, so adapters should provide `getClientIp`; set `security.rateLimit.allowAnonymousIdentity = true` only for single-process development or intentionally shared low-risk deployments. You can tune limits with:

```js
const handleComments = createCommentHandler({
  security: {
    rateLimit: {
      windowMs: 60_000,
      allowAnonymousIdentity: false,
      limits: {
        signup: 5,
        login: 10,
        reset: 3,
        post: 20,
        postSite: 60,
        vote: 60
      }
    }
  }
});
```

`post` limits one thread for one identity; `postSite` limits that same identity across all threads on the site so attackers cannot bypass posting limits by rotating thread names. For high-traffic deployments, edge or reverse-proxy rate limiting is still recommended as a first line of defense. JavaScript adapters should provide a trusted `getClientIp`; jcomment does not trust generic forwarded headers in the core.

The JavaScript SQLite and D1 stores also enforce storage quotas atomically while accepting comments:

```js
const handleComments = createCommentHandler({
  security: {
    quotas: {
      maxCommentsPerThread: 512,
      maxCommentsPerSite: 5000
    }
  }
});
```

Expired session and password-reset token rows are purged during startup and auth-related requests.

CORS is off by default. For cross-origin embeds with cookies, pass an explicit `cors` origin such as `cors: "https://www.example.com"`; the JavaScript core accepts only `*` or an exact absolute `http(s)` origin here. State-changing browser requests are also checked against the request origin, so cross-origin browser clients must use an explicit trusted origin rather than `cors: "*"`. Use `cors: "*"` only when a public non-browser or bearer-token API is intentional and no cookie session is used.

Unsafe requests (`POST` and `PATCH`) must use JSON when they send a `Content-Type` header. Browser cross-site unsafe requests are rejected with `Origin`/`Sec-Fetch-Site` checks to protect cookie and IP-based identities from CSRF. Cookie-authenticated unsafe requests also require either a trusted `Origin` or `Sec-Fetch-Site: same-origin`, so legacy clients without same-origin browser metadata should use bearer tokens instead of cookie sessions. If you need to allow additional browser origins beyond the same origin and the configured CORS origin, configure them explicitly as exact absolute `http(s)` origins:

```js
const handleComments = createCommentHandler({
  cors: "https://www.example.com",
  security: {
    csrf: {
      trustedOrigins: ["https://admin.example.com"]
    }
  }
});
```

### Disabling Login Or Voting

You can disable the per-site login feature:

```js
const handleComments = createCommentHandler({
  voteIdentity: {
    login: { enabled: false }
  }
});
```

If both login and IP storage are disabled while voting remains enabled, jcomment emits a server startup warning. In that configuration, the server has no durable identity for non-localhost voters, so vote requests are rejected. Use this only when voting is intentionally unavailable or for local development with explicit localhost voting.

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
JCOMMENT_PASSWORD_RESET_COMMAND=/usr/local/bin/send-jcomment-reset
JCOMMENT_LOGIN_ENABLED=1
JCOMMENT_VOTING_ENABLED=1
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

Forwarded IP headers are ignored by the JavaScript core. Custom adapters must pass a trusted `getClientIp` callback to `createCommentHandler` if IP identity is needed. The Cloudflare Worker adapter uses Cloudflare's `CF-Connecting-IP` header through that callback; generic client-supplied `X-Forwarded-For`, `X-Real-IP`, and `CF-Connecting-IP` headers are not parsed by the core.

### Per-Site Login Voting

The login flow exists for users and regions where IP storage is prohibited, risky, or unwanted. Login tokens are scoped to the server-configured `site` value and are not shared across unrelated jcomment deployments.

Treat login tokens as credentials: serve jcomment over HTTPS, protect the SQLite database, rotate or revoke tokens when needed, and document how users can request deletion if applicable.

## Hosting Integrations

The `server/` directory provides small adapters:

- `server/cgi/jcomment_cgi.zig` - native Zig CGI server for generic no-Node hosting.
- `server/express.mjs` - Express route adapter.
- `server/cloudflare-worker.js` - Cloudflare Workers module.
- `server/vercel.mjs` - Vercel serverless handler.
- `server/netlify.mjs` - Netlify Function handler.

The Zig CGI server is the generic server. The JavaScript files are integration adapters for JavaScript-based hosts.

The Express adapter uses the same file-backed SQLite store as the JavaScript core. Mount it behind `express.json({ limit: "8kb" })` or a stricter equivalent. By default the adapter uses `req.socket.remoteAddress` for server-side rate limiting and optional IP vote identity; pass `getClientIp: req => ...` only when you have a trusted reverse-proxy boundary. Cookie-capable Express deployments that use the default `security.sessionCookie.enabled = "auto"` must set `publicOrigin` or `JCOMMENT_PUBLIC_ORIGIN` to the canonical API origin so the adapter does not downgrade HTTPS login responses to JavaScript-readable bearer tokens when Express sees an internal HTTP hop. When cookie sessions are explicitly enabled or disabled, set `publicOrigin`/`JCOMMENT_PUBLIC_ORIGIN` or `allowedHosts`/`JCOMMENT_ALLOWED_HOSTS` so spoofed Host headers cannot influence same-origin CSRF checks. Vercel and Netlify functions must be pointed at a durable SQLite database path with `JCOMMENT_DB`; do not rely on the platform's ephemeral function filesystem for production data. Set `JCOMMENT_SITE` when those functions should share an auth/comment realm with another adapter or deployment. Cookie-capable Vercel and Netlify deployments must also set `JCOMMENT_PUBLIC_ORIGIN` to the canonical API origin, or explicitly set `JCOMMENT_SESSION_COOKIE_ENABLED=0` for bearer-token-only deployments. Requests that arrive on a different origin from `JCOMMENT_PUBLIC_ORIGIN` are rejected so alternate platform hostnames cannot become a parallel same-origin cookie surface.

The Cloudflare Worker adapter uses Cloudflare D1. Bind a D1 database as `JCOMMENT_DB`. Because Workers cannot use Node's `node:sqlite` module, storage goes through D1. Account signup/login requires a service binding exposed as `JCOMMENT_ARGON2ID` with `hashPassword(password)` and `verifyPassword(password, stored)` methods. If `JCOMMENT_PASSWORD_RESET_ENABLED=1`, also bind `JCOMMENT_PASSWORD_RESET` to a service with `sendToken({ site, username, email, token })`; the Worker fails closed instead of creating undeliverable reset tokens when this binding is missing. If you set `JCOMMENT_SITE` on a cookie-capable Worker, also set `JCOMMENT_PUBLIC_ORIGIN` to the canonical Worker origin, or explicitly set `JCOMMENT_SESSION_COOKIE_ENABLED=0` for bearer-token-only deployments. Requests that arrive on a different origin from `JCOMMENT_PUBLIC_ORIGIN` are rejected so alternate Worker hostnames cannot become a parallel same-origin cookie surface.

Worker and serverless boolean environment variables must use `1`, `true`, `on`, `yes`, `0`, `false`, `off`, or `no`. Cookie mode also accepts `auto` where documented. Malformed boolean values fail closed.

Common Cloudflare Worker environment variables:

```sh
JCOMMENT_SITE=example.com
JCOMMENT_PUBLIC_ORIGIN=https://comments.example.com
JCOMMENT_LOGIN_ENABLED=1
JCOMMENT_VOTING_ENABLED=1
JCOMMENT_REQUIRE_LOGIN_TO_POST=0
JCOMMENT_MAX_VOTES_PER_IDENTITY=1
JCOMMENT_IP_STORAGE_ENABLED=0
JCOMMENT_IP_ALLOW_RANGES=203.0.113.0/24
JCOMMENT_IP_DENY_RANGES=203.0.113.64/26
JCOMMENT_EMAIL_MODE=none
JCOMMENT_DISCLOSE_ACCOUNT_EXISTENCE=0
JCOMMENT_RESERVED_USERNAMES=admin,administrator,moderator,mod,staff,system,anonymous,jcomment
JCOMMENT_PASSWORD_RESET_ENABLED=0
JCOMMENT_SESSION_TTL_MS=2592000000
JCOMMENT_SESSION_COOKIE_ENABLED=1
JCOMMENT_SESSION_COOKIE_NAME=jcomment_session
JCOMMENT_SESSION_COOKIE_SAMESITE=Lax
JCOMMENT_SESSION_COOKIE_SECURE=1
JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN=0
JCOMMENT_PASSWORD_RESET_TTL_MS=3600000
JCOMMENT_RATE_LIMIT_ENABLED=1
JCOMMENT_RATE_LIMIT_WINDOW_MS=60000
JCOMMENT_RATE_LIMIT_POST_SITE=60
JCOMMENT_MAX_COMMENTS_PER_THREAD=512
JCOMMENT_MAX_COMMENTS_PER_SITE=5000
BROKEN_CONFIG=0
```

## Generic No-Node Server

For generic hosting, use the native CGI binary built at `dist/jcomment-cgi`. It is written in Zig and compiled with `zig build-exe`; it does not require Node, npm, Bun, or a JavaScript runtime on the server.

Build it explicitly with `npm run build:cgi`. The default `npm run build` does not build CGI and does not require Zig.

The CGI binary supports the same basic API shape:

- `GET /api/comments?thread=post-123`
- `POST /api/comments?thread=post-123`
- `PATCH /api/comments?thread=post-123`
- `POST /api/comments/signup`
- `POST /api/comments/login`
- `POST /api/comments/reset/request`
- `POST /api/comments/reset/confirm`

Set `JCOMMENT_DATA_DIR` to choose the directory for `jcomment.sqlite3`, which stores comments, votes, accounts, sessions, and reset tokens. This variable is required; do not store the database in a shared temporary directory for production. Existing CGI data directories must already be private (`0700` or stricter) and must not be symlinks; the database, SQLite sidecars, and schema marker inside that directory must not be symlinks either. Newly created data directories are set to `0700`.

The CGI server stores expiring sessions, expiring reset token digests, and persistent rate-limit counters in the same SQLite database. Use `JCOMMENT_SITE`, `JCOMMENT_SESSION_TTL_MS`, `JCOMMENT_PASSWORD_RESET_TTL_MS`, `JCOMMENT_RATE_LIMIT_ENABLED`, `JCOMMENT_RATE_LIMIT_WINDOW_MS`, `JCOMMENT_MAX_COMMENTS_PER_THREAD`, and `JCOMMENT_MAX_COMMENTS_PER_SITE` to tune those controls. It enforces comment caps inside the SQLite insert statement, plus the same public text-field limits as the JavaScript core. It reads only `REMOTE_ADDR` by default and fails closed for state-changing rate-limited requests when no client address is available; set `JCOMMENT_RATE_LIMIT_ALLOW_ANONYMOUS_IDENTITY=1` only for deliberately shared low-risk deployments. To use a forwarded IP, set `JCOMMENT_TRUST_PROXY_HEADERS=1` and choose exactly one trusted proxy header with `JCOMMENT_TRUST_PROXY_HEADER=cf-connecting-ip`, `x-real-ip`, or `x-forwarded-for`; this is honored only when `REMOTE_ADDR` is localhost, so deploy the CGI behind a same-host trusted proxy that strips incoming client copies of that header. CORS is disabled by default for CGI; set `JCOMMENT_CORS_ORIGIN=https://www.example.com` when cross-origin cookie use is intentional, or `JCOMMENT_CORS_ORIGIN=*` only for cookie-disabled public API deployments. Same-origin CSRF checks use `SERVER_NAME`, not client-supplied `HTTP_HOST`, so configure the server's canonical name correctly. If you set `JCOMMENT_SITE` on a cookie-capable CGI deployment, also set `JCOMMENT_PUBLIC_ORIGIN` to the canonical CGI origin, or keep cookie sessions disabled. Requests whose CGI origin does not match `JCOMMENT_PUBLIC_ORIGIN` are rejected. Set `JCOMMENT_SQLITE_BIN` to an absolute sqlite3 path when `/usr/bin/sqlite3` is not correct for the host.

CGI boolean environment variables must use `1`, `true`, `on`, `yes`, `0`, `false`, `off`, or `no`. `JCOMMENT_EMAIL_MODE` must be `none`, `optional`, or `required`. `JCOMMENT_CORS_ORIGIN` must be `*` or an absolute `http(s)` origin, and `JCOMMENT_PUBLIC_ORIGIN` must be an exact absolute `http(s)` origin when set. `JCOMMENT_RESERVED_USERNAMES` entries must be non-empty account names without control, invisible, or variation-selector characters. `JCOMMENT_SESSION_COOKIE_NAME` must be a valid cookie name, and `JCOMMENT_SESSION_COOKIE_SAMESITE` must be `Strict`, `Lax`, or `None`. Numeric TTL, rate-window, vote-limit, and comment-quota environment variables must be positive integers. When `JCOMMENT_TRUST_PROXY_HEADERS=1`, `JCOMMENT_TRUST_PROXY_HEADER` must be exactly `cf-connecting-ip`, `x-real-ip`, or `x-forwarded-for`. Malformed security values are rejected instead of guessed so auth, cookie, proxy, and rate-limit controls do not silently change behavior.

CGI password reset requires `JCOMMENT_PASSWORD_RESET_COMMAND` when `JCOMMENT_PASSWORD_RESET_ENABLED=1`. The command must be an absolute executable path; jcomment runs it without a shell and with a minimal environment containing `JCOMMENT_RESET_SITE`, `JCOMMENT_RESET_USERNAME`, and `JCOMMENT_RESET_EMAIL`. The raw reset token is written to the command's stdin with a trailing newline. Use that command to send the token through your email provider.

CGI signup and login can use HttpOnly cookies instead of JavaScript-readable bearer tokens by setting `JCOMMENT_SESSION_COOKIE_ENABLED=1`. Use `JCOMMENT_SESSION_COOKIE_NAME`, `JCOMMENT_SESSION_COOKIE_SAMESITE`, and `JCOMMENT_SESSION_COOKIE_SECURE` to tune cookie behavior. `JCOMMENT_SESSION_COOKIE_EXPOSE_TOKEN=1` is rejected when cookie sessions are enabled because exposing the bearer token defeats the HttpOnly cookie boundary.

Example Apache-style CGI environment:

```apache
SetEnv JCOMMENT_DATA_DIR /var/lib/jcomment
SetEnv JCOMMENT_SITE example.com
SetEnv JCOMMENT_PUBLIC_ORIGIN https://comments.example.com
ScriptAlias /api/comments /usr/local/libexec/jcomment-cgi
ScriptAlias /api/comments/login /usr/local/libexec/jcomment-cgi/login
ScriptAlias /api/comments/signup /usr/local/libexec/jcomment-cgi/signup
ScriptAlias /api/comments/reset/request /usr/local/libexec/jcomment-cgi/reset/request
ScriptAlias /api/comments/reset/confirm /usr/local/libexec/jcomment-cgi/reset/confirm
```

CGI localhost voting is disabled unless `JCOMMENT_LOCALHOST_VOTING_ENABLED=1` is set for development. For deployed non-localhost traffic, voting requires the per-site login flow. If login is disabled and voting remains enabled, non-localhost votes are rejected because the CGI server has no durable vote identity; set `JCOMMENT_VOTING_ENABLED=0` when voting should be unavailable.

Set `JCOMMENT_REQUIRE_LOGIN_TO_POST=1` to reject comment posting unless the request includes a valid bearer token for that site. This requires `JCOMMENT_LOGIN_ENABLED=1` and does not affect reading comments.

## License

jcomment is licensed under the Mozilla Public License Version 2.0. See `LICENSE`.
