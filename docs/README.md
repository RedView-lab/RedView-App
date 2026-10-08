# RedView documentation

[← Repository](../README.md) · [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

Everything written about RedView beyond the code, in one place. The day-to-day
technical reference (commands, architecture, the rules each subsystem relies on)
is [`CLAUDE.md`](../CLAUDE.md) at the repository root. The documents below go
deeper on one subject.

> **Language.** Folder maps and conventions are in English. Most in-depth notes,
> runbooks and audits are in French (marked **FR**).

## Where to start

| You want to… | Read |
|---|---|
| Find your way in the code | [Structure of `src/`](architecture/structure.md), then the folder maps: [`server/`](../server/README.md) · [`scripts/`](../scripts/README.md) · [`script-test-bench/`](../script-test-bench/README.md) |
| Understand the product and its engines | [Product and engine overview](architecture/overview.md) |
| Work on routing | [Routing architecture](architecture/routing.md) |
| Work on co-editing, comments or live presence | [Real-time co-editing](architecture/collab-realtime.txt) |
| Operate production | [VPS host configuration](../server/vps/README.md) · [Backups and disaster recovery](../server/vps/backup/README.md) · [Service watch](../server/vps/watch/README.md) |
| Read the product statistics | [Stats guide](analytics/stats-guide.md) (no jargon) |

## Architecture — [`architecture/`](architecture)

| Document | Lang | What it covers |
|---|---|---|
| [structure.md](architecture/structure.md) | EN | Where a file goes in `src/`: the roles of `shared/`, the shape of a feature, sub-domains, barrels and import cycles |
| [overview.md](architecture/overview.md) | FR | The product and its engines: physics, weather, snow, LiDAR |
| [routing.md](architecture/routing.md) | FR | Routing stack: BRouter, generated BRF profiles, VPS services |
| [collab-realtime.txt](architecture/collab-realtime.txt) | FR | Real-time co-editing and live presence: model, rules for changes, security (section 14), tests — plain text with an aligned layout |

## Operations — [`operations/`](operations)

| Document | Lang | What it covers |
|---|---|---|
| [security-runbook.md](operations/security-runbook.md) | FR | Rollout order of the October 2026 security hardening |
| [server-perf/](operations/server-perf) | FR | Reference performance snapshots of the VPS, taken before and after each tuning step (`bash scripts/vps/perf-snapshot.sh <label>`) |
| [VPS host configuration](../server/vps/README.md) | FR | Where each host file goes, how to apply and roll back, the Always Free memory floor |
| [Backups](../server/vps/backup/README.md) | FR | Nightly encrypted backups (restic), weekly restore drill, disaster recovery |
| [Service watch](../server/vps/watch/README.md) | FR | Checks run every 5 minutes through the public URLs, alert rules |

## Analytics — [`analytics/`](analytics)

| Document | Lang | What it covers |
|---|---|---|
| [stats-guide.md](analytics/stats-guide.md) | FR | Plain-language guide to the statistics for the whole team: where to look, glossary, the questions to ask each week |
| [measurement.md](analytics/measurement.md) | FR | Technical reference: anonymous first-party Umami + database reports, privacy rules, event dictionary, funnels, boards |

## Dated audits — [`audits/`](audits)

Point-in-time studies, kept for their method and their measurements. The code
may have changed since; file names start with the audit date. Raw outputs they
refer to are in [`audits/data/`](audits/data).

| Date | Document | Lang |
|---|---|---|
| 2026-09-22 | [POI database audit and rebuild](audits/2026-09-22-poi-database.md) | FR |
| 2026-09-22 | [Use of rider data in the pace engine](audits/2026-09-22-prediction-data.md) | FR |
| 2026-09-23 | [Completing the POI base with four external sources](audits/2026-09-23-poi-external-sources.md) | FR |
| 2026-10-01 | [Pre-launch audit of the signed-in user journey](audits/2026-10-01-launch.md) | FR |

## Writing a new document

- Put it in the folder of its subject: `architecture/`, `operations/` or
  `analytics/`. A point-in-time study goes in `audits/` as `YYYY-MM-DD-<subject>.md`.
- Use lowercase, hyphenated file names, with no `REDVIEW_` prefix.
- Add a row to this index.
- Use relative links, and check that they resolve.
- If the document changes a rule the code relies on, update `CLAUDE.md` in the same commit.
