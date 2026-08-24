import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./util.ts";

const port = Number(process.env.PORT ?? 4173);
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
};

export function resolveRequest(url: string, roots: { project: string; web: string }): string | null {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const base = pathname.startsWith("/artifacts/") ? roots.project : roots.web;
  const requested = pathname === "/" ? join(roots.web, "index.html") : join(base, normalize(pathname).replace(/^\/+/, ""));
  const full = resolve(requested);
  if (!full.startsWith(resolve(base) + "/") && full !== resolve(base)) return null;
  return full;
}

export function createGreenlightServer(roots = { project: projectRoot, web: join(projectRoot, "src", "web") }) {
  return createServer(async (request, response) => {
    try {
      const path = resolveRequest(request.url ?? "/", roots);
      if (!path || !(await stat(path)).isFile()) throw new Error("not found");
      response.writeHead(200, {
        "content-type": mime[extname(path)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      response.end(await readFile(path));
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found. Run `make canary` first for generated evidence.\n");
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createGreenlightServer().listen(port, "127.0.0.1", () => {
    process.stdout.write(`Greenlight Decision Card: http://127.0.0.1:${port}\n`);
  });
}
