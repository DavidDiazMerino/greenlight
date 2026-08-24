# Security notes

Last reviewed: 2026-08-24.

- Live credentials are environment inputs and `.env*` is ignored except for the empty example.
- Grafana OAuth data is stored outside the repository in `~/.config/greenlight/grafana-oauth.json` with file mode `0600`; public artifacts contain MCP query results and hashes, never OAuth tokens or OTLP authorization headers.
- The OAuth redirect is restricted to `127.0.0.1`, uses PKCE, and validates the state parameter.
- `GRAFANA_URL` accepts only credential-free `https://*.grafana.net` origins. Remote MCP endpoints require HTTPS.
- Use a dedicated Grafana stack containing only Greenlight synthetic canary telemetry. Raw MCP responses are retained for hash verification and must not include unrelated production data.
- `npm audit --omit=dev` currently reports 11 moderate transitive OpenTelemetry advisories under `@google/adk@2.0.0`. npm's proposed forced fix is an incompatible ADK downgrade, so it is intentionally not applied. The high-severity `adm-zip` advisory is mitigated with the compatible `0.6.0` override, and Greenlight does not load untrusted ADK skill archives.
