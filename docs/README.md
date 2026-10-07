# RedView — documentation

The technical reference for day-to-day work is [`CLAUDE.md`](../CLAUDE.md) at the
repository root (commands, architecture, conventions, the rules each subsystem
relies on). The documents below go deeper on one subject; most are in French.

## Architecture and plans

| Document | Subject |
|---|---|
| [REDVIEW_ROUTING_ARCHITECTURE.md](REDVIEW_ROUTING_ARCHITECTURE.md) | Routing stack: BRouter, generated BRF profiles, VPS services |
| [REDVIEW_COLLAB_TEMPS_REEL.txt](REDVIEW_COLLAB_TEMPS_REEL.txt) | Real-time co-editing and live presence: model, rules for changes, security (section 14), tests |
| [STRUCTURE_REFACTOR_PLAN.md](STRUCTURE_REFACTOR_PLAN.md) | Feature-sliced folder structure and its migration plan |
| [REDVIEW_ANALYSIS.md](REDVIEW_ANALYSIS.md) | Product and engine overview (physics, weather, snow, LiDAR) |
| [ANALYTICS.md](ANALYTICS.md) | Audience measurement: Umami (first-party, anonymous) + database reports, privacy rules, event dictionary, funnels, boards |
| [GUIDE_STATISTIQUES.md](GUIDE_STATISTIQUES.md) | Plain-language guide to the stats for the whole team (where to look, glossary, Monday questions) |

## Runbooks

| Document | Subject |
|---|---|
| [REDVIEW_SECURITY_RUNBOOK.md](REDVIEW_SECURITY_RUNBOOK.md) | Rollout order of the October 2026 security hardening |
| [../server/vps/README.md](../server/vps/README.md) | VPS host configuration: where each file goes, apply / roll back, memory floor |
| [../server/vps/backup/README.md](../server/vps/backup/README.md) | Backups (restic), weekly restore drill, disaster recovery |

## Dated audits

Point-in-time studies, kept for their method and measurements; the code may
have moved since.

| Date | Document |
|---|---|
| 2026-09-22 | [audits/REDVIEW_POI_DB_AUDIT.md](audits/REDVIEW_POI_DB_AUDIT.md) — POI database audit and rebuild |
| 2026-09-22 | [audits/REDVIEW_PREDICTION_DATA_AUDIT.md](audits/REDVIEW_PREDICTION_DATA_AUDIT.md) — use of rider data in the pace engine |
| 2026-09-23 | [audits/REDVIEW_POI_EXTERNAL_SOURCES.md](audits/REDVIEW_POI_EXTERNAL_SOURCES.md) — completing the POI base with four external sources |
| 2026-10-01 | [audits/REDVIEW_LAUNCH_AUDIT.md](audits/REDVIEW_LAUNCH_AUDIT.md) — pre-launch audit of the signed-in user journey |
