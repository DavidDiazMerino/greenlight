# Agentic Cinema submission compliance

Last reviewed: 2026-08-24. Deadline: **2026-09-09 14:00 PDT / 23:00 CEST (Madrid)**.

This checklist is based on the [Devpost overview](https://agentic-cinema.devpost.com/), [official rules](https://agentic-cinema.devpost.com/rules), [Grafana track resources](https://agentic-cinema.devpost.com/details/grafana-resources), and the official [Google ADK Grafana Cloud integration](https://google.github.io/adk-docs/integrations/grafana-cloud/). When this document and the contest pages disagree, the contest pages control.

Status markers: `PASS` is verified in the repository, `PARTIAL` needs live evidence or submission work, `BLOCKED` needs an external account or user action, and `USER` can only be confirmed by the entrant.

## Stage-one eligibility and submission gates

| Requirement | Current evidence | Status | Required action |
| --- | --- | --- | --- |
| Entrant is eligible, above the age of majority, and not subject to an exclusion or conflict | Cannot be established from source code | USER | David must review sections 4 and 7.B of the official rules and confirm eligibility. |
| Project was newly created during the contest period | First public commit is `80a46b5` on 2026-08-24; source records date from August 2026 | USER | Confirm Greenlight is original work first created after 2026-07-27. |
| Team has at most four eligible people and every member is on Devpost | No team record in the repository | USER | Join the hackathon and add the final team/representative in Devpost. |
| Functional web, Android, or iOS project | Local Decision Card and container smoke test are functional | PARTIAL | Deploy and record the public hosted URL. |
| Functional production-ready AI agent or multi-agent network for a media/entertainment workflow | Deterministic experiment planner and policy exist, but no live Gemini/ADK run yet | PARTIAL | Import and call official Google ADK at runtime; capture a live run. |
| Gemini and Google Cloud Agent Builder usage at runtime | Adapter boundary exists; no Google SDK was imported or called in the latest verified run | BLOCKED | Add `@google/adk`, authenticate a Google Cloud project, and retain real execution evidence. |
| Grafana stack actively used at runtime primarily through official Grafana MCP | Strict adapter and negative guardrail exist; no MCP connection or receipt yet | BLOCKED | Connect ADK to the hosted or official self-hosted MCP server and call real Grafana tools. |
| AI Observability is not presented as satisfying the Grafana requirement | Current docs already treat it as optional | PASS | Keep MCP calls as the primary evidence; add AI Observability only if time permits. |
| Only Google Cloud AI and built-in partner AI are used | No OpenAI, Anthropic, AWS, or Microsoft AI dependency exists | PASS | Re-run the dependency/source audit before submission. |
| Public source repository with detectable open-source license | `DavidDiazMerino/greenlight` is public and contains an MIT `LICENSE` | PASS | Keep repository public; verify GitHub still detects the license before submitting. |
| Repository contains source, assets, and reproducible instructions | Synthetic geometry/text, generators, policy, tests, Dockerfile, and README are checked in | PASS | Add live integration and deployment instructions once verified. |
| Hosted project URL | None | BLOCKED | Deploy after Google Cloud project selection and authentication. |
| Public demo video on YouTube or Vimeo, no longer than three minutes | None | BLOCKED | Record the actual project functioning; use English narration or English subtitles. |
| Written submission in English | No final Devpost copy | BLOCKED | Prepare feature summary, technologies, data sources, findings, and learnings in English. |
| Third-party integrations and media are authorized | Demo visuals are original synthetic/MIT; Google/Grafana use must follow their terms | PARTIAL | Do not add unlicensed footage, music, logos, slogans, or third-party personal data. |

## Runtime proof that must exist in the final repository

Devpost explicitly requires Google Cloud and partner services to be imported and actually called in code, not merely named in documentation. Greenlight therefore needs all of the following:

1. `@google/adk` in `package.json` and a reachable runtime entry point using `LlmAgent`/`Runner`.
2. `MCPToolset` configured for the official Grafana MCP service.
3. A real Gemini agent mission that performs multiple steps and uses Grafana results to choose or explain an experiment.
4. At least one real Prometheus query, one Loki query, and one Tempo query retrieved through MCP and attached to the Decision Card with exact tool/query/result hashes.
5. The deterministic policy must remain the sole verdict owner; Gemini may select tests and explain results, but must not alter thresholds or override `PROMOTE`, `HOLD`, or `REJECT`.
6. A public hosted web experience that displays the real run without exposing OAuth tokens, Google credentials, Grafana service-account tokens, or raw secret headers.

## Chosen Grafana path

The initial integration path is the hosted Grafana Cloud MCP endpoint:

- endpoint: `https://mcp.grafana.com/mcp`;
- transport: Streamable HTTP (not SSE);
- SDK: `MCPToolset` from `@google/adk`;
- recommended routing header: `X-Grafana-URL: https://<stack>.grafana.net`;
- authentication: interactive OAuth 2.1;
- scope: read-only for least privilege.

The Grafana track page explicitly allows the development machine for the one-time browser authorization and demo recording. The hosted endpoint has no unattended service-account mode. If Greenlight later needs server-side unattended MCP calls, use the official open-source `grafana/mcp-grafana` server with a Grafana service-account token instead.

AI Observability can be added to show Gemini latency, token cost, and MCP activity, but it is optional and does not replace the MCP connection.

## Grafana evidence mission

The final live mission should be deterministic in shape even though the agent drives tool selection:

1. discover the MCP tools advertised by the connected server;
2. execute `query_prometheus` for canary coverage, safe-area failures, output validity, and p95 render time;
3. execute `query_loki_logs` for the five failed `caption_layout` records;
4. execute `tempo_traceql-search` and `tempo_get-trace` for a paired baseline/candidate clip;
5. correlate all three signals into a receipt-complete EvidenceBundle;
6. apply the committed policy and render the Decision Card;
7. generate a Grafana deep link for human review if the advertised toolset provides it.

Tool names must still be discovered at runtime and validated before calls. The names above are the current official catalog, not permission to fabricate a successful discovery or receipt.

## Judging readiness

The four stage-two criteria are equally weighted:

- **Technological implementation:** real Google ADK/Gemini and Grafana MCP execution, strict provenance, reproducible container, and robust failure modes.
- **Design:** one coherent workflow from candidate change to visual evidence and Decision Card, not a collection of dashboards.
- **Potential impact:** make the cost of catching an unsafe vertical-video release concrete for post-production supervisor Maya.
- **Quality of the idea:** emphasize media-native pixel QA plus agentic observability correlation, with deterministic governance instead of an LLM-generated verdict.

## Entrant actions still required

- Join the Agentic Cinema hackathon and confirm personal/team eligibility.
- Create or select a billing-enabled Google Cloud project; request the hackathon credits before **2026-08-31 23:59 PDT** if desired.
- Create a Grafana Cloud stack, accept the Grafana Assistant terms as stack administrator, and confirm Editor-or-higher access.
- Complete the one-time read-only OAuth authorization when the ADK/MCP runtime is ready.
- Approve the final public deployment, demo video, and Devpost submission text.
