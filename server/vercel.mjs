import { createCommentHandler, createSqliteStore, json } from "./core.mjs";

const handleComments = process.env.JCOMMENT_DB
  ? createCommentHandler({
      store: createSqliteStore({ path: process.env.JCOMMENT_DB }),
      getClientIp: request => trustedHeaderIp(request)
    })
  : null;

export default async function handler(request) {
  if (!handleComments) {
    return json({ error: "Set JCOMMENT_DB to a durable SQLite database path before using the Vercel adapter." }, { status: 500 });
  }
  return handleComments(request);
}

function trustedHeaderIp(request) {
  return request.headers.get("x-real-ip") || "";
}
