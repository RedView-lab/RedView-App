# RedView — documentation

The technical reference for day-to-day work is [`CLAUDE.md`](../CLAUDE.md) at the
repository root (commands, architecture, conventions, the rules each subsystem
relies on). The documents below go deeper on one subject; most are in French.

## Architecture — `architecture/`

| Document | Subject |
|---|---|
| [structure.md](architecture/structure.md) | Folder conventions of `src/`: the roles of `shared/`, the shape of a feature, sub-domains, barrels and import cycles |
| [routing.md](architecture/routing.md) | Routing stack: BRouter, generated BRF profiles, VPS services |
| [collab-realtime.txt](architecture/collab-realtime.txt) | Real-time co-editing and live presence: model, rules for changes, security (section 14), tests (plain text, aligned layout) |
| [overview.md](architecture/overview.md) | Product and engine overview (physics, weather, snow, LiDAR) |

## Operations — `operations/`

| Document | Subject |
|---|---|
| [security-runbook.md](operations/security-runbook.md) | Rollout order of the October 2026 security hardening |
| [../server/vps/README.md](../server/vps/README.md) | VPS host configuration: where each file goes, apply / roll back, memory floor |
| [../server/vps/backup/README.md](../server/vps/backup/README.md) | Backups (restic), weekly restore drill, disaster recovery |

## Analytics — `analytics/`

| Document | Subject |
|---|---|
| [measurement.md](analytics/measurement.md) | Audience measurement: Umami (first-party, anonymous) + database reports, privacy rules, event dictionary, funnels, boards |
| [stats-guide.md](analytics/stats-guide.md) | Plain-language guide to the stats for the whole team (where to look, glossary, Monday questions) |

## Dated audits — `audits/`

Point-in-time studies, kept for their method and measurements; the code may
have moved since. File names start with the audit date.

| Date | Document |
|---|---|
| 2026-09-22 | [2026-09-22-poi-database.md](audits/2026-09-22-poi-database.md) — POI database audit and rebuild |
| 2026-09-22 | [2026-09-22-prediction-data.md](audits/2026-09-22-prediction-data.md) — use of rider data in the pace engine |
| 2026-09-23 | [2026-09-23-poi-external-sources.md](audits/2026-09-23-poi-external-sources.md) — completing the POI base with four external sources |
| 2026-10-01 | [2026-10-01-launch.md](audits/2026-10-01-launch.md) — pre-launch audit of the signed-in user journey |
