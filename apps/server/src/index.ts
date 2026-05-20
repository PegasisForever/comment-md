import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router.js";
import { resolve, join, dirname, extname } from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? "3210");

const here = dirname(fileURLToPath(import.meta.url));
// Web dist resolution order:
// 1. WEB_DIST env (production override / docker)
// 2. ../../web/dist (monorepo source layout, when running from apps/server/src)
// 3. ../web/dist (compiled / packaged side-by-side)
const webDistCandidates = [
  process.env.WEB_DIST,
  resolve(here, "../../web/dist"),
  resolve(here, "../web/dist"),
].filter(Boolean) as string[];
const WEB_DIST = webDistCandidates.find((p) => existsSync(p));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function tryServeStatic(pathname: string): Response | null {
  if (!WEB_DIST) return null;
  // strip leading slash, prevent traversal
  const clean = pathname.replace(/^\/+/, "");
  if (clean.includes("..")) return new Response("forbidden", { status: 403 });
  const candidate = join(WEB_DIST, clean);
  if (existsSync(candidate)) {
    const s = statSync(candidate);
    if (s.isFile()) {
      const ext = extname(candidate).toLowerCase();
      const type = MIME[ext] ?? "application/octet-stream";
      return new Response(Bun.file(candidate), { headers: { "content-type": type } });
    }
  }
  return null;
}

function serveIndex(): Response {
  if (!WEB_DIST) {
    return new Response("Web UI is not built. Run `bun run build:web`.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const indexPath = join(WEB_DIST, "index.html");
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Web UI index.html missing.", { status: 503 });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (path.startsWith("/trpc")) {
      return fetchRequestHandler({
        endpoint: "/trpc",
        req,
        router: appRouter,
        createContext: ({ req }) => ({ req }),
        onError({ error, path }) {
          if (error.code === "INTERNAL_SERVER_ERROR") {
            console.error(`[trpc] error on ${path ?? "(unknown)"}:`, error);
          }
        },
      });
    }

    // try static asset
    if (path !== "/" && path !== "") {
      const staticResponse = tryServeStatic(path);
      if (staticResponse) return staticResponse;
    }

    // SPA fallback for /notes/* and /
    return serveIndex();
  },
});

console.log(`comment-md server listening on http://${HOST}:${PORT}`);
console.log(`  web dist: ${WEB_DIST ?? "(not found — UI requests will 503)"}`);

// Graceful shutdown
const shutdown = () => {
  console.log("\nShutting down…");
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
