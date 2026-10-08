# Security policy

[← Repository](README.md) · [Contributing](CONTRIBUTING.md) · [Docs index](docs/README.md)

## Reporting a vulnerability

Please report security issues **privately** through
[GitHub Security Advisories](https://github.com/RedView-lab/RedView-App/security/advisories/new),
not in a public issue.

Include:

- the affected component (app, API, real-time server, VPS service);
- the steps to reproduce;
- the impact you observed.

## How the code is protected

| Area | Where it lives |
|---|---|
| Rights on shared projects, always checked on the server; attributes the client writes are never trusted | [`server/lib/project-access.mjs`](server/lib/project-access.mjs) |
| Content-Security-Policy of every page and worker script (no `unsafe-eval`) | [`server/lib/csp.mjs`](server/lib/csp.mjs) |
| Request hardening shared by the development and production adapters: path normalisation, body limits, rate-limit keys, upstream allowlists | [`server/lib/http-security.mjs`](server/lib/http-security.mjs) |
| Errors sent to GlitchTip with URLs, headers and bodies scrubbed | [`server/lib/observability.mjs`](server/lib/observability.mjs), `src/shared/lib/errorReportScrub.ts` |

## Further reading

- Rollout of the October 2026 hardening:
  [`docs/operations/security-runbook.md`](docs/operations/security-runbook.md)
- Threat model of real-time co-editing: section 14 of
  [`docs/architecture/collab-realtime.txt`](docs/architecture/collab-realtime.txt)
