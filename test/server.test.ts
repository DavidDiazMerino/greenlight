import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGreenlightServer } from "../src/server.ts";

test("Decision Card server exposes UI and artifacts while containing traversal", async () => {
  const project = await mkdtemp(join(tmpdir(), "greenlight-server-test-"));
  const web = join(project, "web");
  await mkdir(join(project, "artifacts", "latest"), { recursive: true });
  await mkdir(web, { recursive: true });
  await writeFile(join(web, "index.html"), "<!doctype html><title>Greenlight</title>", "utf8");
  await writeFile(join(project, "artifacts", "latest", "decision-card.json"), '{"decision":"HOLD"}\n', "utf8");
  const server = createGreenlightServer({ project, web });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const [health, home, card, traversal] = await Promise.all([
      fetch(`${origin}/healthz`),
      fetch(`${origin}/`),
      fetch(`${origin}/artifacts/latest/decision-card.json`),
      fetch(`${origin}/artifacts/%2e%2e/package.json`),
    ]);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await home.text(), /Greenlight/);
    assert.equal(card.status, 200);
    assert.match(card.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await card.json(), { decision: "HOLD" });
    assert.equal(traversal.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(project, { recursive: true, force: true });
  }
});
