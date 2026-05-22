import { readFile } from "node:fs/promises";

const bytes = await readFile(new URL("../dist/jcomment.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, {});
const exports = instance.exports;
const memory = new Uint8Array(exports.memory.buffer);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function write(ptr, max, value) {
  const bytes = encoder.encode(value);
  memory.set(bytes.slice(0, max), ptr);
  return bytes.length;
}

const authorLen = write(exports.jcomment_author_ptr(), 96, "Ada <admin>");
const bodyLen = write(exports.jcomment_body_ptr(), 2048, "Hello & welcome\nNo scripts <script>");
const timeLen = write(exports.jcomment_time_ptr(), 64, "May 23, 2026");
const scoreLen = write(exports.jcomment_score_ptr(), 32, "4 votes / 1 reply");
const len = exports.jcomment_render(authorLen, bodyLen, timeLen, scoreLen);
const ptr = exports.jcomment_output_ptr();
const html = decoder.decode(memory.subarray(ptr, ptr + len));

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

console.log("wasm renderer ok");
