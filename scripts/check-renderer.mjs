import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../web/jcomment.js", import.meta.url), "utf8");
const match = source.match(/function renderCommentHtml\(comment\) \{[\s\S]*?\n\}/);
if (!match) throw new Error("renderCommentHtml was not found");
const articleMatch = source.match(/  renderArticle\(comment\) \{[\s\S]*?\n  \}/);
if (!articleMatch) throw new Error("renderArticle was not found");
const authHeadersMatch = source.match(/  authHeaders\(targetUrl = location\.href\) \{[\s\S]*?\n  \}/);
if (!authHeadersMatch) throw new Error("authHeaders was not found");
const getTokenMatch = source.match(/  getToken\(\) \{[\s\S]*?\n  \}/);
if (!getTokenMatch) throw new Error("getToken was not found");
const setTokenMatch = source.match(/  setToken\(token, sourceUrl = location\.href\) \{[\s\S]*?\n  \}/);
if (!setTokenMatch) throw new Error("setToken was not found");
const clearSecretFieldsMatch = source.match(/  clearSecretFields\(\) \{[\s\S]*?\n  \}/);
if (!clearSecretFieldsMatch) throw new Error("clearSecretFields was not found");
const clearContactFieldsMatch = source.match(/  clearContactFields\(\) \{[\s\S]*?\n  \}/);
if (!clearContactFieldsMatch) throw new Error("clearContactFields was not found");
const clearTokenMatch = source.match(/  clearToken\(\) \{[\s\S]*?\n  \}/);
if (!clearTokenMatch) throw new Error("clearToken was not found");
const loginMatch = source.match(/  async login\(\) \{[\s\S]*?\n  \}/);
if (!loginMatch) throw new Error("login was not found");
const signupMatch = source.match(/  async signup\(\) \{[\s\S]*?\n  \}/);
if (!signupMatch) throw new Error("signup was not found");
const requestResetMatch = source.match(/  async requestReset\(\) \{[\s\S]*?\n  \}/);
if (!requestResetMatch) throw new Error("requestReset was not found");
const confirmResetMatch = source.match(/  async confirmReset\(\) \{[\s\S]*?\n  \}/);
if (!confirmResetMatch) throw new Error("confirmReset was not found");

const formatDate = () => "May 23, 2026";
const scoreText = () => "4 votes / 1 reply";
const escapeHtml = value => String(value || "").replace(/[&<>"']/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
})[char]);

const renderCommentHtml = new Function("formatDate", "scoreText", "escapeHtml", `return (${match[0].replace("function renderCommentHtml", "function")});`)(formatDate, scoreText, escapeHtml);
const escapeAttr = value => String(value || "").replace(/[&<>"']/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
})[char]);
const renderArticle = new Function(
  "renderCommentHtml",
  "escapeAttr",
  `return function(comment) { return ({${articleMatch[0]}}).renderArticle.call({ capabilities: { voting: true } }, comment); };`
)(renderCommentHtml, escapeAttr);
const html = renderCommentHtml({
  author: "Ada <admin>",
  body: "Hello & welcome\nNo scripts <script>",
  createdAt: "2026-05-23T00:00:00.000Z",
  score: 4,
  replyCount: 1
});

if (!html.includes("Ada &lt;admin&gt;")) {
  throw new Error("author was not escaped");
}
if (!html.includes("Hello &amp; welcome<br>No scripts &lt;script&gt;")) {
  throw new Error("body was not escaped");
}
if (!html.includes("May 23, 2026")) {
  throw new Error("timestamp was not rendered");
}
if (!html.includes("4 votes / 1 reply")) {
  throw new Error("score was not rendered");
}

const articleHtml = renderArticle({
  id: `42" onmouseover="alert(1)`,
  parentId: `parent'><img src=x onerror=alert(1)>`,
  author: "Ada",
  body: "Safe body",
  createdAt: "2026-05-23T00:00:00.000Z",
  score: 4,
  replyCount: 1
});

if (articleHtml.includes(`onmouseover="alert(1)`) || articleHtml.includes("<img")) {
  throw new Error("article attributes were not escaped");
}
if (!articleHtml.includes(`data-id="42&quot; onmouseover=&quot;alert(1)"`)) {
  throw new Error("comment id attribute was not escaped");
}
if (!articleHtml.includes("parent&#39;&gt;&lt;img src=x onerror=alert(1)&gt;")) {
  throw new Error("parent id attribute was not escaped");
}

globalThis.location = { href: "https://page.example.test/article" };
const tokenClient = new Function(
  `return ({${authHeadersMatch[0].trim()}, ${getTokenMatch[0].trim()}, ${setTokenMatch[0].trim()}, ${clearSecretFieldsMatch[0].trim()}, ${clearContactFieldsMatch[0].trim()}, ${clearTokenMatch[0].trim()}});`
)();
tokenClient.setToken("secret-token", "https://auth.example.test/api/comments/login");
if (tokenClient.authHeaders("https://attacker.example.test/api/comments").authorization) {
  throw new Error("bearer token leaked to a different API origin");
}
if (tokenClient.authHeaders("https://auth.example.test/api/comments").authorization !== "Bearer secret-token") {
  throw new Error("bearer token was not sent to its issuing API origin");
}
tokenClient.setToken("", "https://auth.example.test/api/comments/login");
if (tokenClient.getToken() || tokenClient.tokenOrigin || tokenClient.authHeaders("https://auth.example.test/api/comments").authorization) {
  throw new Error("empty auth response did not clear stale bearer token state");
}
tokenClient.setToken("reset-cleared-token", "https://auth.example.test/api/comments/login");
tokenClient.clearToken();
if (tokenClient.getToken() || tokenClient.tokenOrigin) {
  throw new Error("password reset did not clear stale bearer token state");
}
tokenClient.loginPasswordInput = { value: "correct horse battery staple" };
tokenClient.resetTokenInput = { value: "reset-token" };
tokenClient.clearSecretFields();
if (tokenClient.loginPasswordInput.value || tokenClient.resetTokenInput.value) {
  throw new Error("secret auth fields were not cleared after credential use");
}
tokenClient.loginEmailInput = { value: "ada@example.test" };
tokenClient.clearContactFields();
if (tokenClient.loginEmailInput.value) {
  throw new Error("account contact field was not cleared after credential use");
}
if ((source.match(/this\.clearSecretFields\(\);/g) || []).length < 3) {
  throw new Error("expected login, signup, and reset confirmation to clear secret fields");
}
if ((source.match(/this\.clearContactFields\(\);/g) || []).length < 2) {
  throw new Error("expected signup and reset request to clear account contact fields");
}
if ((source.match(/if \(response\.status === 401\) \{\n\s+this\.clearToken\(\);/g) || []).length < 2) {
  throw new Error("expected authenticated 401 responses to clear stale bearer tokens");
}

const resetClient = new Function(
  `return ({${requestResetMatch[0].trim()}, ${clearContactFieldsMatch[0].trim()}});`
)();
const oldFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, token: "server-leaked-reset-token" })
  });
  resetClient.capabilities = { accounts: { passwordReset: true } };
  resetClient.loginInput = { value: "Ada" };
  resetClient.loginEmailInput = { value: "ada@example.test" };
  resetClient.resetTokenInput = { value: "" };
  resetClient.resetRequestApi = "https://auth.example.test/api/comments/reset/request";
  resetClient.site = "default";
  resetClient.error = { textContent: "" };
  await resetClient.requestReset();
  if (resetClient.resetTokenInput.value) {
    throw new Error("reset request exposed a server-returned reset token in the UI");
  }
  if (resetClient.loginEmailInput.value) {
    throw new Error("reset request did not clear the account contact field");
  }
} finally {
  globalThis.fetch = oldFetch;
}

const failedCredentialClient = new Function(
  `return ({${loginMatch[0].trim()}, ${signupMatch[0].trim()}, ${confirmResetMatch[0].trim()}, ${setTokenMatch[0].trim()}, ${clearSecretFieldsMatch[0].trim()}, ${clearContactFieldsMatch[0].trim()}, ${clearTokenMatch[0].trim()}});`
)();
try {
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: "rejected" })
  });
  Object.assign(failedCredentialClient, {
    api: "https://auth.example.test/api/comments",
    loginApi: "https://auth.example.test/api/comments/login",
    signupApi: "https://auth.example.test/api/comments/signup",
    resetConfirmApi: "https://auth.example.test/api/comments/reset/confirm",
    site: "default",
    loginPanel: { dataset: {} },
    authorInput: { value: "Ada" },
    loginInput: { value: "Ada" },
    loginPasswordInput: { value: "wrong password" },
    loginEmailInput: { value: "ada@example.test" },
    resetTokenInput: { value: "reset-token" },
    error: { textContent: "" }
  });
  await failedCredentialClient.login();
  if (failedCredentialClient.loginPasswordInput.value || failedCredentialClient.resetTokenInput.value) {
    throw new Error("failed login retained submitted secret fields");
  }
  failedCredentialClient.loginPasswordInput.value = "duplicate password";
  failedCredentialClient.resetTokenInput.value = "reset-token";
  failedCredentialClient.loginEmailInput.value = "ada@example.test";
  await failedCredentialClient.signup();
  if (failedCredentialClient.loginPasswordInput.value || failedCredentialClient.resetTokenInput.value || failedCredentialClient.loginEmailInput.value) {
    throw new Error("failed signup retained submitted credential fields");
  }
  failedCredentialClient.loginPasswordInput.value = "new password";
  failedCredentialClient.resetTokenInput.value = "reset-token";
  await failedCredentialClient.confirmReset();
  if (failedCredentialClient.loginPasswordInput.value || failedCredentialClient.resetTokenInput.value) {
    throw new Error("failed reset confirmation retained submitted secret fields");
  }
} finally {
  globalThis.fetch = oldFetch;
}

console.log("js renderer ok");
