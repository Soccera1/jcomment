import { createCommentHandler, createSqliteStore, json } from "./core.mjs";

const handleComments = process.env.JCOMMENT_DB
  ? createCommentHandler({ store: createSqliteStore({ path: process.env.JCOMMENT_DB }) })
  : null;

export default async function handler(request) {
  if (!handleComments) {
    return json({ error: "Set JCOMMENT_DB to a durable SQLite database path before using the Vercel adapter." }, { status: 500 });
  }
  return handleComments(request);
}
