const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host {
      --jc-bg: #fbfaf8;
      --jc-panel: #ffffff;
      --jc-text: #1f2933;
      --jc-muted: #667085;
      --jc-line: #ded8ce;
      --jc-soft: #f4f1eb;
      --jc-accent: #0f766e;
      --jc-accent-strong: #115e59;
      display: block;
      color: var(--jc-text);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .jc-shell {
      background: var(--jc-bg);
      border: 1px solid var(--jc-line);
      border-radius: 8px;
      box-shadow: 0 18px 48px rgb(31 41 51 / 0.08);
      overflow: hidden;
    }
    .jc-top {
      align-items: center;
      border-bottom: 1px solid var(--jc-line);
      display: grid;
      gap: 12px;
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 16px 18px;
    }
    .jc-title {
      font-size: 15px;
      font-weight: 700;
      margin: 0;
    }
    .jc-count {
      color: var(--jc-muted);
      font-size: 12px;
      margin-top: 2px;
      white-space: nowrap;
    }
    .jc-tools {
      align-items: center;
      display: flex;
      gap: 8px;
    }
    .jc-sort {
      background: #fff;
      border: 1px solid var(--jc-line);
      border-radius: 6px;
      color: var(--jc-text);
      font: inherit;
      height: 34px;
      padding: 0 8px;
    }
    .jc-tool {
      align-items: center;
      background: #fff;
      border: 1px solid var(--jc-line);
      border-radius: 6px;
      color: var(--jc-text);
      display: inline-flex;
      height: 34px;
      justify-content: center;
      padding: 0 10px;
      white-space: nowrap;
    }
    .jc-list {
      display: grid;
      gap: 12px;
      padding: 16px 18px;
    }
    .jc-empty {
      color: var(--jc-muted);
      padding: 20px 0;
      text-align: center;
    }
    .jc-comment {
      background: var(--jc-panel);
      border: 1px solid color-mix(in srgb, var(--jc-line) 78%, transparent);
      border-radius: 8px;
      padding: 13px 14px;
    }
    .jc-comment[data-reply="true"] {
      margin-left: 28px;
      position: relative;
    }
    .jc-comment[data-reply="true"]::before {
      background: var(--jc-line);
      content: "";
      height: calc(100% - 8px);
      left: -15px;
      position: absolute;
      top: 4px;
      width: 2px;
    }
    .jc-comment__meta {
      align-items: baseline;
      display: flex;
      gap: 10px;
      justify-content: space-between;
      margin-bottom: 7px;
    }
    .jc-comment strong {
      font-size: 13px;
    }
    .jc-comment time,
    .jc-muted {
      color: var(--jc-muted);
      font-size: 12px;
    }
    .jc-comment p {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .jc-actions {
      align-items: center;
      display: flex;
      gap: 6px;
      margin-top: 10px;
    }
    .jc-score {
      color: var(--jc-muted);
      font-size: 12px;
      margin-right: auto;
    }
    .jc-link {
      background: transparent;
      border: 0;
      color: var(--jc-accent-strong);
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      padding: 3px 5px;
    }
    .jc-form {
      background: var(--jc-soft);
      border-top: 1px solid var(--jc-line);
      display: grid;
      gap: 10px;
      padding: 16px 18px 18px;
    }
    .jc-login {
      background: #fff;
      border: 1px solid var(--jc-line);
      border-radius: 6px;
      display: none;
      gap: 8px;
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 10px;
    }
    .jc-login[data-active="true"] {
      display: grid;
    }
    .jc-replying {
      align-items: center;
      background: #fff;
      border: 1px solid var(--jc-line);
      border-radius: 6px;
      display: none;
      gap: 8px;
      justify-content: space-between;
      padding: 8px 10px;
    }
    .jc-replying[data-active="true"] {
      display: flex;
    }
    .jc-row {
      display: grid;
      gap: 10px;
      grid-template-columns: minmax(0, 1fr) auto;
    }
    input,
    textarea {
      background: #fff;
      border: 1px solid var(--jc-line);
      border-radius: 6px;
      box-sizing: border-box;
      color: var(--jc-text);
      font: inherit;
      min-width: 0;
      padding: 10px 11px;
      width: 100%;
    }
    textarea {
      min-height: 94px;
      resize: vertical;
    }
    button {
      cursor: pointer;
    }
    .jc-post {
      align-self: stretch;
      background: var(--jc-accent);
      border: 0;
      border-radius: 6px;
      color: white;
      font: inherit;
      font-weight: 700;
      padding: 0 18px;
    }
    .jc-post:hover {
      background: var(--jc-accent-strong);
    }
    button:disabled {
      cursor: progress;
      opacity: 0.65;
    }
    .jc-error {
      color: #b42318;
      min-height: 1.2em;
    }
    .jc-foot {
      align-items: center;
      display: flex;
      gap: 10px;
      justify-content: space-between;
    }
    @media (max-width: 560px) {
      .jc-top,
      .jc-row {
        grid-template-columns: 1fr;
      }
      .jc-tools {
        justify-content: space-between;
      }
      .jc-post {
        min-height: 42px;
      }
      .jc-comment[data-reply="true"] {
        margin-left: 16px;
      }
    }
  </style>
  <section class="jc-shell">
    <header class="jc-top">
      <div>
        <h2 class="jc-title">Comments</h2>
        <div class="jc-count">0 comments</div>
      </div>
      <div class="jc-tools">
        <select class="jc-sort" aria-label="Sort comments">
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="top">Top</option>
        </select>
        <button class="jc-tool" type="button" data-action="account">Account</button>
        <button class="jc-tool" type="button" data-action="refresh">Refresh</button>
      </div>
    </header>
    <div class="jc-list"></div>
    <form class="jc-form">
      <div class="jc-replying">
        <span class="jc-muted"></span>
        <button class="jc-link" type="button" data-action="cancel-reply">Cancel</button>
      </div>
      <div class="jc-login">
        <input name="loginName" autocomplete="username" maxlength="80" placeholder="Username">
        <input name="loginEmail" autocomplete="email" maxlength="254" placeholder="Email">
        <input name="loginPassword" autocomplete="current-password" maxlength="256" type="password" placeholder="Password">
        <input name="resetToken" maxlength="256" placeholder="Reset token">
        <button class="jc-post" type="button" data-action="login">Sign in</button>
        <button class="jc-link" type="button" data-action="signup">Create account</button>
        <button class="jc-link" type="button" data-action="reset-request">Reset password</button>
        <button class="jc-link" type="button" data-action="reset-confirm">Use reset token</button>
      </div>
      <input name="author" autocomplete="name" maxlength="80" placeholder="Name" required>
      <textarea name="body" maxlength="1800" placeholder="Join the discussion" required></textarea>
      <div class="jc-foot">
        <span class="jc-muted jc-char">0 / 1800</span>
        <span class="jc-error" aria-live="polite"></span>
      </div>
      <div class="jc-row">
        <span class="jc-muted"></span>
        <button class="jc-post" type="submit">Post</button>
      </div>
    </form>
  </section>
`;

function renderCommentHtml(comment) {
  return `<header class="jc-comment__meta"><strong>${escapeHtml(comment.author || "Anonymous")}</strong><time>${escapeHtml(formatDate(comment.createdAt))}</time></header><p>${escapeHtml(comment.body || "").replace(/\n/g, "<br>")}</p><span class="jc-score">${escapeHtml(scoreText(comment))}</span>`;
}

function formatDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function scoreText(comment) {
  const score = Number(comment.score || 0);
  const replies = Number(comment.replyCount || 0);
  const voteText = `${score} ${Math.abs(score) === 1 ? "vote" : "votes"}`;
  if (!replies) return voteText;
  return `${voteText} / ${replies} ${replies === 1 ? "reply" : "replies"}`;
}

function normalizePayload(payload) {
  if (Array.isArray(payload)) return { comments: payload, count: payload.length, nextCursor: null };
  if (payload && Array.isArray(payload.comments)) {
    return {
      comments: payload.comments,
      count: Number(payload.count ?? payload.comments.length),
      nextCursor: payload.nextCursor ?? null,
      capabilities: payload.capabilities || {}
    };
  }
  return { comments: [], count: 0, nextCursor: null, capabilities: {} };
}

function escapeAttr(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

customElements.define("j-comment-section", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).append(template.content.cloneNode(true));
    this.comments = [];
    this.commentCount = 0;
    this.capabilities = { voting: true, login: true };
    this.parentId = "";
  }

  connectedCallback() {
    this.api = this.dataset.api || "/api/comments";
    this.loginApi = this.dataset.loginApi || `${this.api.replace(/\/$/, "")}/login`;
    this.signupApi = this.dataset.signupApi || `${this.api.replace(/\/$/, "")}/signup`;
    this.resetRequestApi = this.dataset.resetRequestApi || `${this.api.replace(/\/$/, "")}/reset/request`;
    this.resetConfirmApi = this.dataset.resetConfirmApi || `${this.api.replace(/\/$/, "")}/reset/confirm`;
    this.thread = this.dataset.thread || location.pathname;
    this.site = this.dataset.site || location.host;
    this.limit = Number(this.dataset.limit || 100);
    this.storageKey = `jcomment:${this.thread}:author`;
    this.tokenKey = `jcomment:${this.site}:token`;
    this.list = this.shadowRoot.querySelector(".jc-list");
    this.count = this.shadowRoot.querySelector(".jc-count");
    this.form = this.shadowRoot.querySelector("form");
    this.error = this.shadowRoot.querySelector(".jc-error");
    this.button = this.shadowRoot.querySelector(".jc-post");
    this.sort = this.shadowRoot.querySelector(".jc-sort");
    this.authorInput = this.form.elements.author;
    this.bodyInput = this.form.elements.body;
    this.loginInput = this.form.elements.loginName;
    this.loginEmailInput = this.form.elements.loginEmail;
    this.loginPasswordInput = this.form.elements.loginPassword;
    this.resetTokenInput = this.form.elements.resetToken;
    this.loginPanel = this.shadowRoot.querySelector(".jc-login");
    this.charCount = this.shadowRoot.querySelector(".jc-char");
    this.replying = this.shadowRoot.querySelector(".jc-replying");

    this.authorInput.value = localStorage.getItem(this.storageKey) || "";
    this.form.addEventListener("submit", event => this.submit(event));
    this.bodyInput.addEventListener("input", () => this.updateCharCount());
    this.sort.addEventListener("change", () => this.refresh());
    this.shadowRoot.addEventListener("click", event => this.handleClick(event));
    this.updateCharCount();
    this.refresh();
  }

  apiUrl(extra = {}) {
    const url = new URL(this.api, location.href);
    url.searchParams.set("thread", this.thread);
    url.searchParams.set("site", this.site);
    url.searchParams.set("sort", this.sort?.value || "newest");
    url.searchParams.set("limit", String(this.limit));
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async refresh() {
    try {
      const response = await fetch(this.apiUrl());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = normalizePayload(await response.json());
      this.comments = payload.comments;
      this.commentCount = payload.count;
      this.capabilities = { ...this.capabilities, ...payload.capabilities };
      this.render();
    } catch (error) {
      this.error.textContent = `Could not load comments: ${error.message}`;
    }
  }

  render() {
    const count = this.commentCount;
    this.count.textContent = `${count} ${count === 1 ? "comment" : "comments"}`;
    if (this.comments.length === 0) {
      this.list.innerHTML = `<div class="jc-empty">No comments yet.</div>`;
      return;
    }
    this.list.innerHTML = this.comments.map(comment => this.renderArticle(comment)).join("");
  }

  renderArticle(comment) {
    const id = escapeAttr(comment.id);
    const parentId = escapeAttr(comment.parentId);
    const voteButton = this.capabilities.voting === false
      ? ""
      : `<button class="jc-link" type="button" data-action="upvote">Upvote</button>`;
    return `
      <article class="jc-comment" id="comment-${id}" data-id="${id}" data-parent-id="${parentId}" data-reply="${Boolean(comment.parentId)}">
        ${renderCommentHtml(comment)}
        <div class="jc-actions">
          ${voteButton}
          <button class="jc-link" type="button" data-action="reply">Reply</button>
        </div>
      </article>
    `;
  }

  async handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "refresh") {
      await this.refresh();
      return;
    }
    if (action === "cancel-reply") {
      this.setReplyTarget("");
      return;
    }
    if (action === "account") {
      this.showLogin("Sign in or create an account for voting.");
      return;
    }
    if (action === "login") {
      await this.login();
      return;
    }
    if (action === "signup") {
      await this.signup();
      return;
    }
    if (action === "reset-request") {
      await this.requestReset();
      return;
    }
    if (action === "reset-confirm") {
      await this.confirmReset();
      return;
    }
    const article = button.closest(".jc-comment");
    if (!article) return;
    if (action === "reply") {
      this.setReplyTarget(article.dataset.id);
      this.bodyInput.focus();
      return;
    }
    if (action === "upvote") {
      await this.vote(article.dataset.id, button);
    }
  }

  setReplyTarget(id) {
    this.parentId = id || "";
    const comment = this.comments.find(item => item.id === this.parentId);
    this.replying.dataset.active = this.parentId ? "true" : "false";
    this.replying.querySelector("span").textContent = comment ? `Replying to ${comment.author || "Anonymous"}` : "";
  }

  async vote(id, button) {
    button.disabled = true;
    try {
      const response = await fetch(this.apiUrl(), {
        method: "PATCH",
        headers: this.authHeaders(),
        body: JSON.stringify({ id, action: "upvote" })
      });
      if (response.status === 401) {
        if (this.capabilities.login === false) {
          this.error.textContent = "Voting requires an identity, but login is disabled for this site.";
        } else {
          this.showLogin("Sign in to vote from this network.");
        }
        return;
      }
      if (response.status === 403) {
        this.capabilities.voting = false;
        this.render();
        this.error.textContent = "Voting is disabled for this site.";
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      const payload = normalizePayload(await response.json());
      this.comments = payload.comments;
      this.commentCount = payload.count;
      this.capabilities = { ...this.capabilities, ...payload.capabilities };
      this.render();
    } catch (error) {
      this.error.textContent = `Could not vote: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async login() {
    const name = String(this.loginInput.value || this.authorInput.value || "").trim();
    const password = String(this.loginPasswordInput.value || "");
    if (!name) {
      this.error.textContent = "Enter a username to sign in for voting.";
      return;
    }
    if (!password) {
      this.error.textContent = "Enter your password to sign in.";
      return;
    }
    try {
      const url = new URL(this.loginApi, location.href);
      url.searchParams.set("site", this.site);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name, password })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      localStorage.setItem(this.tokenKey, payload.token);
      if (!this.authorInput.value) this.authorInput.value = name;
      this.loginPanel.dataset.active = "false";
      this.error.textContent = "";
    } catch (error) {
      this.error.textContent = `Could not sign in: ${error.message}`;
    }
  }

  async signup() {
    const username = String(this.loginInput.value || this.authorInput.value || "").trim();
    const email = String(this.loginEmailInput.value || "").trim();
    const password = String(this.loginPasswordInput.value || "");
    if (!username) {
      this.error.textContent = "Enter a username to create an account.";
      return;
    }
    if (password.length < 8) {
      this.error.textContent = "Use a password of at least 8 characters.";
      return;
    }
    try {
      const url = new URL(this.signupApi, location.href);
      url.searchParams.set("site", this.site);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, email, password })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      const payload = await response.json();
      localStorage.setItem(this.tokenKey, payload.token);
      if (!this.authorInput.value) this.authorInput.value = username;
      this.loginPanel.dataset.active = "false";
      this.error.textContent = "";
    } catch (error) {
      this.error.textContent = `Could not create account: ${error.message}`;
    }
  }

  async requestReset() {
    const username = String(this.loginInput.value || "").trim();
    const email = String(this.loginEmailInput.value || "").trim();
    if (!this.capabilities.accounts?.passwordReset) {
      this.error.textContent = "Password reset is not enabled for this site.";
      return;
    }
    if (!username || !email) {
      this.error.textContent = "Enter your username and email to request a reset.";
      return;
    }
    try {
      const url = new URL(this.resetRequestApi, location.href);
      url.searchParams.set("site", this.site);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, email })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.token) this.resetTokenInput.value = payload.token;
      this.error.textContent = "If the account exists, a reset token has been issued.";
    } catch (error) {
      this.error.textContent = `Could not request reset: ${error.message}`;
    }
  }

  async confirmReset() {
    const token = String(this.resetTokenInput.value || "").trim();
    const password = String(this.loginPasswordInput.value || "");
    if (!token || password.length < 8) {
      this.error.textContent = "Enter a reset token and a new password of at least 8 characters.";
      return;
    }
    try {
      const url = new URL(this.resetConfirmApi, location.href);
      url.searchParams.set("site", this.site);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.error.textContent = "Password updated. You can sign in now.";
    } catch (error) {
      this.error.textContent = `Could not reset password: ${error.message}`;
    }
  }

  showLogin(message) {
    this.loginPanel.dataset.active = "true";
    this.error.textContent = message;
    this.loginInput.value = this.authorInput.value || this.loginInput.value;
    this.loginEmailInput.style.display = this.capabilities.accounts?.email === "none" ? "none" : "";
    this.resetTokenInput.style.display = this.capabilities.accounts?.passwordReset ? "" : "none";
    this.loginInput.focus();
  }

  authHeaders() {
    const headers = { "content-type": "application/json" };
    const token = localStorage.getItem(this.tokenKey);
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  async submit(event) {
    event.preventDefault();
    const author = String(this.authorInput.value || "").trim();
    const body = String(this.bodyInput.value || "").trim();
    if (!author || !body) return;

    this.button.disabled = true;
    this.error.textContent = "";
    try {
      const response = await fetch(this.apiUrl(), {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ author, body, parentId: this.parentId })
      });
      if (response.status === 401) {
        this.showLogin("Sign in to post comments.");
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      localStorage.setItem(this.storageKey, author);
      const payload = normalizePayload(await response.json());
      this.comments = payload.comments;
      this.commentCount = payload.count;
      this.bodyInput.value = "";
      this.setReplyTarget("");
      this.updateCharCount();
      this.render();
    } catch (error) {
      this.error.textContent = `Could not post comment: ${error.message}`;
    } finally {
      this.button.disabled = false;
    }
  }

  updateCharCount() {
    this.charCount.textContent = `${this.bodyInput.value.length} / ${this.bodyInput.maxLength}`;
  }

});

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}
