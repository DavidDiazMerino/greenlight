# Grafana alert-to-decision workflow

Greenlight's live path is a media-native release investigation, not a generic observability demo. A canary exports the measured caption regression, a Grafana-managed rule fires, and the Google ADK agent performs a bounded MCP mission before a human reviews the deterministic `HOLD`.

## Versioned Grafana resources

- [`../grafana/dashboards/greenlight-release-gate.json`](../grafana/dashboards/greenlight-release-gate.json) is the classic dashboard with the stable UID `greenlight-release-gate`. Its panels use the five `greenlight_*` metrics and an `experiment_id` variable.
- [`../grafana/alert-rule-mcp.json`](../grafana/alert-rule-mcp.json) is the exact `alerting_manage_rules` payload for the stable rule UID `greenlight-caption-safe-area`.
- [`../grafana/provisioning/alerting/greenlight.yaml`](../grafana/provisioning/alerting/greenlight.yaml) and [`../grafana/provisioning/dashboards/greenlight.yaml`](../grafana/provisioning/dashboards/greenlight.yaml) are the equivalent file-provisioning boundaries for a self-hosted Grafana deployment.

The blocking expression is `max(greenlight_caption_safe_area_violation_px{variant="candidate"}) > 0`. It observes the same pixel measurement used by Greenlight's committed policy, but the alert does not own or modify the release verdict.

## One-time or idempotent setup

With `.env` populated, run:

```bash
make grafana-setup
```

The command uses the official hosted Grafana MCP endpoint to:

1. find or create the stable `Greenlight` folder;
2. create or update the versioned dashboard;
3. find or create/update the versioned alert rule;
4. read both resources back and fail if their stable identities cannot be verified.

The hosted MCP connection must advertise its write tools. Grafana may request `grafana:write` consent when an older OAuth grant was read-only. The command records result hashes under ignored `artifacts/grafana-setup.json`; it never fabricates setup success.

## Live investigation

`make agent-live` keeps the previous exact Prometheus/Loki/Tempo evidence plan and adds four bounded workflow calls:

1. `alerting_manage_rules` must return the named rule in `firing` state;
2. `search_dashboards` must return the stable dashboard UID;
3. `create_annotation` writes the already-fixed verdict, affected-clip count, exact highest-failure clip/overflow/trace ID, and immutable Decision Receipt fingerprint;
4. `generate_deeplink` returns a same-stack dashboard URL scoped to the experiment and evidence window.

Evidence receipts and workflow receipts are deliberately separate. Only the metric, log, and trace receipts can satisfy the policy evaluator's MCP evidence requirement. The alert, dashboard, annotation, and link prove workflow closure; they cannot promote a candidate or alter a threshold.

The hardened 2026-09-03 credentialed run is sanitized in [`verification/live-alert-dashboard-mcp-2026-09-03.json`](verification/live-alert-dashboard-mcp-2026-09-03.json). It proves exact `v02` / 61 px / Tempo trace correlation and a matching MCP-required policy re-evaluation. Raw MCP results remain ignored locally.
