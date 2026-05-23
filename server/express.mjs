import { createCommentHandler, createSqliteStore } from "./core.mjs";

export function jcommentExpress({
  store = createSqliteStore(),
  cors = false,
  getClientIp,
  publicOrigin = process.env.JCOMMENT_PUBLIC_ORIGIN || "",
  allowedHosts = splitList(process.env.JCOMMENT_ALLOWED_HOSTS),
  ...options
} = {}) {
  const configuredOrigin = normalizeOrigin(publicOrigin);
  if (publicOrigin && !configuredOrigin) throw new Error("jcommentExpress publicOrigin must be an absolute http(s) origin");
  if (configuredOrigin && allowedHosts.length === 0) allowedHosts = [new URL(configuredOrigin).host.toLowerCase()];
  const handleComments = createCommentHandler({
    ...options,
    store,
    cors,
    getClientIp: request => request.headers.get("x-jcomment-client-ip") || ""
  });

  return async function route(req, res, next) {
    try {
      const host = String(req.get("host") || "");
      if (allowedHosts.length > 0 && !allowedHosts.includes(host.toLowerCase())) {
        res.status(400).send("Bad Request");
        return;
      }
      const origin = configuredOrigin || `${req.protocol}://${host}`;
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body || {});
      const headers = new Headers(req.headers);
      headers.set("x-jcomment-client-ip", getClientIp?.(req) || req.socket?.remoteAddress || "");
      if (body === undefined) {
        headers.delete("content-length");
      } else {
        headers.set("content-length", String(Buffer.byteLength(body)));
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
      const request = new Request(new URL(req.originalUrl || req.url, origin), {
        method: req.method,
        headers,
        body,
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

function splitList(value) {
  return String(value || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}
