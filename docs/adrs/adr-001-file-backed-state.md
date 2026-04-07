# ADR 001: File-Backed State As The Primary Control Plane

## Status

Accepted locally; not production-ready.

## Context

The token-management system stores nearly everything in local files: guard state, audit logs, metrics logs, cache files, statusline cache, usage indexes, alerts, and historical analytics. Shared helpers in `hook_utils.py` provide atomic JSON writes and portable locking, while `cost_runtime.py` names the main cache files (`src/hooks/infrastructure/hook_utils.py:17-128`, `src/scripts/core/cost_runtime.py:64-67`).

## Decision

Use local JSON and JSONL files under `~/.claude` as the system of record for hook decisions, usage aggregation, alerting state, and operator views.

## Why This Made Sense

- Zero external infrastructure.
- Easy local inspection and recovery.
- Fast iteration in a personal environment.
- Compatible with shell hooks and standalone Python scripts.

## Consequences

### Positive

- The system is easy to bootstrap.
- Operator debugging is straightforward because the state is inspectable.
- Historical artifacts can be copied directly into this extracted repository.

### Negative

- Cross-component contracts are implicit and fragile.
- Concurrency depends on local file locks and discipline, not a centralized data model.
- Multi-user, multi-device, and scale scenarios are weak by design.
- Reporting scripts can silently diverge from actual file shapes, as seen with `usage-index.json` assumptions in `token_mgmt_monthly_report.py` (`src/scripts/reporting/token_mgmt_monthly_report.py:494-507`, `data/usage-index-snapshot.json`).

## Assessment

This decision was correct for a personal power-user system and incorrect for a productized Anthropic feature.
