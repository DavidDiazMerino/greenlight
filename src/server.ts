import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { projectRoot } from "./util.ts";

const port = Number(process.env.PORT ?? 4173);
const webRoot = join(projectRoot, "src", "web");
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
};

function resolveRequest(url: string): string | null {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const base = pathname.startsWith("/artifacts/") ? projectRoot : webRoot;
  const requested = pathname === "/" ? join(webRoot, "index.html") : join(base, normalize(pathname).replace(/^\/+/, ""));
  const full = resolve(requested);
  if (!full.startsWith(resolve(base) + "/") && full !== resolve(base)) return null;
  return full;
}

const server = createServer(async (request, response) => {
  try {
    const path = resolveRequest(request.url ?? "/");
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

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Greenlight Decision Card: http://127.0.0.1:${port}\n`);
});
