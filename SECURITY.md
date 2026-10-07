# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/RedView-lab/RedView-App/security/advisories/new)
rather than in a public issue. Include the affected component (app, API,
real-time server, VPS service), steps to reproduce and the impact you observed.

## Scope and design notes

- Rights on shared projects are always checked server-side
  (`server/lib/project-access.mjs`); client-written project attributes are never trusted.
- The Content-Security-Policy is built in `server/lib/csp.mjs` (no `unsafe-eval`).
- Request hardening shared by the development and production adapters lives in
  `server/lib/http-security.mjs`.
- Operational runbook: [`docs/operations/security-runbook.md`](docs/operations/security-runbook.md);
  real-time co-editing threat model: section 14 of
  [`docs/architecture/collab-realtime.txt`](docs/architecture/collab-realtime.txt).
