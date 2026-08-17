import { createServer, type Server } from "node:http";
import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { EligibilityService } from "./eligibility.js";

function html(message: string): string {
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OpenSea verification</title></head><body><main><h1>OpenSea verification</h1><p>${escaped}</p></main></body></html>`;
}

/**
 * Starts the small callback listener required by OpenSea's PKCE flow. It is
 * intentionally enabled only when a redirect URI is configured, so existing
 * deployments can continue running while the public Railway URL is set up.
 */
export function startEligibilityCallbackServer(
  service: EligibilityService,
  env: AppEnv,
): Server | null {
  const redirectUri = env.OPENSEA_OAUTH_REDIRECT_URI?.trim();
  if (!redirectUri) {
    logger.warn("OpenSea eligibility callback disabled: OPENSEA_OAUTH_REDIRECT_URI is not configured");
    return null;
  }
  const callback = new URL(redirectUri);
  const callbackPath = callback.pathname || "/";
  const configuredPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = configuredPort && Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : (callback.port ? Number(callback.port) : 8151);
  const host = callback.hostname === "localhost" || callback.hostname === "127.0.0.1"
    ? callback.hostname
    : "0.0.0.0";
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const outcome = service.handleCallback(requestUrl);
    response.writeHead(outcome.statusCode, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(html(outcome.message));
  });
  server.on("listening", () => logger.info({ host, port, callbackPath }, "OpenSea eligibility callback listening"));
  server.on("error", (error) => logger.error({ err: error, host, port }, "OpenSea eligibility callback server error"));
  server.listen(port, host);
  return server;
}
