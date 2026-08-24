import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PersistentGrafanaOAuthProvider } from "../src/adapters/grafana-oauth.ts";

test("Grafana OAuth state persists outside artifacts with user-only permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "greenlight-oauth-test-"));
  const storePath = join(root, "config", "grafana-oauth.json");
  const provider = new PersistentGrafanaOAuthProvider({ storePath, onAuthorizationUrl: () => undefined });
  try {
    await provider.saveClientInformation({ client_id: "test-client" });
    await provider.saveCodeVerifier("test-verifier");
    await provider.saveTokens({ access_token: "test-access", token_type: "Bearer", refresh_token: "test-refresh" });
    assert.deepEqual(await provider.status(), { hasClientRegistration: true, hasTokens: true, hasRefreshToken: true });
    assert.equal((await stat(storePath)).mode & 0o777, 0o600);
    assert.match(await readFile(storePath, "utf8"), /test-refresh/);

    await provider.invalidateCredentials("tokens");
    assert.deepEqual(await provider.status(), { hasClientRegistration: true, hasTokens: false, hasRefreshToken: false });
    assert.doesNotMatch(await readFile(storePath, "utf8"), /test-access|test-refresh/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grafana OAuth redirect is pinned to loopback", () => {
  assert.throws(() => new PersistentGrafanaOAuthProvider({ redirectUrl: "https://example.com/callback" }), /127\.0\.0\.1/);
});
