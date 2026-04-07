# Vs Community Issues

This document tracks the main token-drain complaint classes and whether this repository addresses them locally.

| Issue Class | Current Local Response | Status | Notes |
|---|---|---|---|
| Blind spend / no visibility | `cost_runtime.py`, statusline cache, ops snapshot, observability | `Implemented` | Local visibility is one of the strongest parts of the system. |
| Wasteful subagent fan-out | `token-guard.py`, `model-router.py`, budget policy | `Implemented` | Dispatch is gated before spend, not only reported after. |
| Duplicate reads / oversized read loops | `read-efficiency-guard.py`, `read-cache.py` | `Implemented` | Read waste is actively constrained. |
| Budget overrun with no hot-path enforcement | `budget-guard.py` plus pre-tool hook registration | `Implemented` | Budget enforcement is now part of the active graph. |
| Context bloat from large tool output | `result-compressor.py` plus session/context tracking | `Implemented` | Local context-pressure handling exists, though it still relies on shell/runtime heuristics rather than native model support. |
| Poor routing / expensive model misuse | `model-router.py`, `routing-reminder.py` | `Implemented` | Model choice is constrained locally, not left purely to habit. |
| No alerting on anomalous burn | `ops_alerts.py`, `ops_trends.py`, `ops_aggregator.py` | `Implemented` | Alerts, dedupe state, and operator views are live. |
| Missing historical attribution | `agent-metrics.py`, `session-summary.py`, `token_snapshots.py` | `Implemented` | Daily summaries and per-agent usage are retained. |
| Review/workflow queue breakage | `check-inbox.sh`, `chain-advance.py`, review/build dispatch hooks | `Implemented` | Mandatory-action production and consumption are wired end to end. |
| Prompt-cache invalidation upstream | Detection and workaround only | `Partial` | The repo can expose the burn and steer behavior, but it cannot repair Anthropic-side cache invalidation. |
| Peak-hour throttling / upstream rate behavior | Detection and workaround only | `Partial` | The system can highlight anomalies and budgets, but upstream throttling remains outside local control. |
| Third-party subscription restrictions | No local fix | `Not solvable locally` | A local control plane cannot override product policy. |

## Intake Rule

New issue classes are only considered “covered” when all four are true:

1. There is a prevention or mitigation path.
2. There is a detection or measurement path.
3. There is a reproducible test or benchmark path.
4. The docs describe the operator-facing behavior honestly.
