import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../web/jcomment.js", import.meta.url), "utf8");
const match = source.match(/function renderCommentHtml\(comment\) \{[\s\S]*?\n\}/);
if (!match) throw new Error("renderCommentHtml was not found");

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

console.log("js renderer ok");
