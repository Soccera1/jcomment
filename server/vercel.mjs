import { createCommentHandler, createSqliteStore, json } from "./core.mjs";
import { canonicalRequest, methodAllowedForServerlessApiPath, publicOriginMatchesRequest, serverlessConfig, validServerlessApiPath, validServerlessRequestMetadata } from "./serverless.mjs";

const adapterConfig = serverlessConfig("Vercel");
let handleComments = null;
let initializationFailed = false;
if (process.env.JCOMMENT_DB && !adapterConfig.error) {
  try {
    handleComments = createCommentHandler({
      store: createSqliteStore({ path: process.env.JCOMMENT_DB }),
      site: adapterConfig.site,
      security: {
        sessionCookie: adapterConfig.sessionCookie
      },
      getClientIp: request => trustedHeaderIp(request)
    });
  } catch (error) {
    initializationFailed = true;
  }
}

export default async function handler(request) {
  if (!validServerlessRequestMetadata(request)) {
    return json({ error: "Request metadata is too large" }, { status: 400 });
  }
  if (!validServerlessApiPath(request)) {
    return json({ error: "Not found" }, { status: 404 });
  }
  if (!methodAllowedForServerlessApiPath(request)) {
    return json({ error: "Method not allowed" }, { status: 405, allow: "GET, POST, PATCH, OPTIONS" });
  }
  if (!publicOriginMatchesRequest(request, adapterConfig.publicOrigin)) {
    return json({ error: "Bad Request" }, { status: 400 });
  }
  if (!process.env.JCOMMENT_DB) {
    return json({ error: "Set JCOMMENT_DB to a durable SQLite database path before using the Vercel adapter." }, { status: 500 });
  }
  if (!handleComments) {
    if (adapterConfig.error) {
      return json({ error: adapterConfig.error }, { status: 500 });
    }
    if (initializationFailed) {
      return json({ error: "Vercel adapter storage was not initialized." }, { status: 500 });
    }
    return json({ error: "Vercel adapter was not initialized." }, { status: 500 });
  }
  return handleComments(canonicalRequest(request, adapterConfig.publicOrigin));
}

function trustedHeaderIp(request) {
  return request.headers.get("x-real-ip") || "";
}
