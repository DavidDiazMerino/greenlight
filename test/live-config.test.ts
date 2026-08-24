import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLiveConfig } from "../src/live.ts";

const valid = {
  GOOGLE_GENAI_USE_VERTEXAI: "true",
  GOOGLE_CLOUD_PROJECT: "greenlight-test",
  GOOGLE_CLOUD_LOCATION: "europe-west1",
  GEMINI_MODEL: "gemini-2.5-flash",
  GRAFANA_URL: "https://greenlight-test.grafana.net",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.test/otlp",
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20redacted,X-Scope-OrgID=test",
};

test("live config requires Vertex AI and parses standard OTLP headers without logging them", () => {
  const config = loadLiveConfig(valid);
  assert.equal(config.project, "greenlight-test");
  assert.equal(config.otlpHeaders.Authorization, "Basic redacted");
  assert.equal(config.mcpEndpoint, "https://mcp.grafana.com/mcp");
});

test("live config fails before work when cloud or secret settings are incomplete", () => {
  assert.throws(() => loadLiveConfig({ ...valid, GOOGLE_GENAI_USE_VERTEXAI: "false" }), /Vertex AI/);
  assert.throws(() => loadLiveConfig({ ...valid, OTEL_EXPORTER_OTLP_HEADERS: "not-a-header" }), /key=value/);
  assert.throws(() => loadLiveConfig({ ...valid, GOOGLE_CLOUD_PROJECT: "" }), /GOOGLE_CLOUD_PROJECT/);
  assert.throws(() => loadLiveConfig({ ...valid, GRAFANA_URL: "https://example.com" }), /GRAFANA_URL/);
});
