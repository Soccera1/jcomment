import { createCommentHandler, createSqliteStore } from "./core.mjs";

export function jcommentExpress({ store = createSqliteStore(), cors = true } = {}) {
  const handleComments = createCommentHandler({ store, cors });

  return async function route(req, res, next) {
    try {
      const origin = `${req.protocol}://${req.get("host")}`;
      const request = new Request(new URL(req.originalUrl || req.url, origin), {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body || {}),
        duplex: "half"
      });
      const response = await handleComments(request);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.send(response.status === 204 ? undefined : await response.text());
    } catch (error) {
      next(error);
    }
  };
}
