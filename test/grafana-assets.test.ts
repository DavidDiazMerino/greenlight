import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "../src/util.ts";

test("versioned Grafana dashboard and alert share stable release-gate identities", async () => {
  const dashboard = JSON.parse(await readFile(join(projectRoot, "grafana", "dashboards", "greenlight-release-gate.json"), "utf8")) as {
    uid: string;
    title: string;
    panels: Array<{ id: number; targets: Array<{ expr: string }> }>;
  };
  const alert = JSON.parse(await readFile(join(projectRoot, "grafana", "alert-rule-mcp.json"), "utf8")) as {
    rule_uid: string;
    title: string;
    condition: string;
    data: Array<{ model: { expr: string } }>;
    labels: Record<string, string>;
  };
  assert.equal(dashboard.uid, "greenlight-release-gate");
  assert.equal(dashboard.title, "Greenlight Release Gate");
  assert.ok(dashboard.panels.some((panel) => panel.id === 2 && panel.targets.some((target) => target.expr.includes("greenlight_caption_safe_area_violation_px"))));
  assert.equal(alert.rule_uid, "greenlight-caption-safe-area");
  assert.equal(alert.title, "Greenlight caption safe-area violation");
  assert.equal(alert.condition, "A");
  assert.match(alert.data[0].model.expr, /greenlight_caption_safe_area_violation_px.*> 0/);
  assert.equal(alert.labels.owner, "deterministic-policy-evaluator");
});
