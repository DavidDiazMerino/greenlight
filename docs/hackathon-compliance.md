# Agentic Cinema submission compliance

Last reviewed: 2026-08-25. Deadline: **2026-09-09 14:00 PDT / 23:00 CEST (Madrid)**.

This checklist is based on the [Devpost overview](https://agentic-cinema.devpost.com/), [official rules](https://agentic-cinema.devpost.com/rules), [Grafana track resources](https://agentic-cinema.devpost.com/details/grafana-resources), and the official [Google ADK Grafana Cloud integration](https://google.github.io/adk-docs/integrations/grafana-cloud/). When this document and the contest pages disagree, the contest pages control.

Status markers: `PASS` is verified in the repository, `PARTIAL` needs live evidence or submission work, `BLOCKED` needs an external account or user action, and `USER` can only be confirmed by the entrant.

## Stage-one eligibility and submission gates

| Requirement | Current evidence | Status | Required action |
| --- | --- | --- | --- |
| Entrant is eligible, above the age of majority, and not subject to an exclusion or conflict | Cannot be established from source code | USER | David must review sections 4 and 7.B of the official rules and confirm eligibility. |
| Project was newly created during the contest period | First public commit is `80a46b5` on 2026-08-24; source records date from August 2026 | USER | Confirm Greenlight is original work first created after 2026-07-27. |
| Team has at most four eligible people and every member is on Devpost | No team record in the repository | USER | Join the hackathon and add the final team/representative in Devpost. |
| Functional web, Android, or iOS project | Local Decision Card and container smoke test are functional | PARTIAL | Deploy and record the public hosted URL. |
| Functional production-ready AI agent or multi-agent network for a media/entertainment workflow | The ADK Experiment and Grafana Evidence agents completed the full 16-render, three-signal live mission; the deterministic gate produced a receipted Decision Card | PASS | Preserve the live verification record and show the same workflow in the demo. |
| Gemini and Google Cloud Agent Builder usage at runtime | `@google/adk` 2.0 `LlmAgent`/`Runner` called Vertex AI `gemini-2.5-flash` in the billing-enabled `greenlight-agentic-cinema` project | PASS | Keep the live entry point reproducible and show it in the demo. |
| Grafana stack actively used at runtime primarily through official Grafana MCP | Hosted `MCPToolset` used OAuth 2.1, discovered 118 tools, and returned non-empty Prometheus, Loki, and Tempo evidence in four result-hashed calls | PASS | Keep the sanitized verification record and demonstrate Grafana/MCP evidence in the video. |
| AI Observability is not presented as satisfying the Grafana requirement | Current docs already treat it as optional | PASS | Keep MCP calls as the primary evidence; add AI Observability only if time permits. |
| Only Google Cloud AI and built-in partner AI are used | Runtime invokes only Vertex AI Gemini; the MCP protocol SDK used by Google ADK is transport, not a non-Google model or agent framework | PASS | Re-run the dependency/source audit before submission. |
| Public source repository with detectable open-source license | `DavidDiazMerino/greenlight` is public and contains an MIT `LICENSE` | PASS | Keep repository public; verify GitHub still detects the license before submitting. |
| Repository contains source, assets, and reproducible instructions | Synthetic geometry/text, generators, policy, tests, Dockerfile, live integration instructions, and sanitized runtime evidence are checked in | PASS | Add the final hosted URL after deployment. |
| Hosted project URL | None | BLOCKED | Deploy after Google Cloud project selection and authentication. |
| Public demo video on YouTube or Vimeo, no longer than three minutes | None | BLOCKED | Record the actual project functioning; use English narration or English subtitles. |
| Written submission in English | No final Devpost copy | BLOCKED | Prepare feature summary, technologies, data sources, findings, and learnings in English. |
| Third-party integrations and media are authorized | Demo visuals are original synthetic/MIT; Google/Grafana use must follow their terms | PARTIAL | Do not add unlicensed footage, music, logos, slogans, or third-party personal data. |

## Runtime proof that must exist in the final repository

Devpost explicitly requires Google Cloud and partner services to be imported and actually called in code, not merely named in documentation. Items 1–5 now have credentialed runtime evidence; item 6 still needs deployment:

1. `@google/adk` in `package.json` and a reachable runtime entry point using `LlmAgent`/`Runner`.
2. `MCPToolset` configured for the official Grafana MCP service.
3. A real Gemini agent mission that performs multiple steps and uses Grafana results to choose or explain an experiment.
4. Real Prometheus, Loki, and Tempo queries retrieved through MCP and attached to the Decision Card with exact tool/query/result hashes. Verified in [`verification/live-adk-grafana-mcp-2026-08-25.json`](verification/live-adk-grafana-mcp-2026-08-25.json).
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

The verified live mission is deterministic in shape while the agent executes the tool calls:

1. discover the MCP tools advertised by the connected server;
2. execute two exact `query_prometheus` calls for baseline/candidate render duration;
3. execute one exact `query_loki_logs` call for experiment-scoped structured media-QA records;
4. execute one exact `tempo_traceql-search` call for experiment-scoped traces, including a paired baseline/candidate clip;
5. reject altered calls or empty results and record exact query/result hashes;
6. preserve the committed policy verdict and render the supplemental Decision Card.

Tool names must still be discovered at runtime and validated before calls. The names above are the current official catalog, not permission to fabricate a successful discovery or receipt.

## Judging readiness

The four stage-two criteria are equally weighted:

- **Technological implementation:** real Google ADK/Gemini and Grafana MCP execution, strict provenance, reproducible container, and robust failure modes.
- **Design:** one coherent workflow from candidate change to visual evidence and Decision Card, not a collection of dashboards.
- **Potential impact:** make the cost of catching an unsafe vertical-video release concrete for post-production supervisor Maya.
- **Quality of the idea:** emphasize media-native pixel QA plus agentic observability correlation, with deterministic governance instead of an LLM-generated verdict.

## Entrant actions still required

- Join the Agentic Cinema hackathon and confirm personal/team eligibility.
- Approve the final public deployment, demo video, and Devpost submission text.
