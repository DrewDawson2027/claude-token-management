# System Overview

Claude Token Management is a local token-control platform built around four cooperating planes:

1. Hook enforcement
2. File-backed telemetry and cost state
3. Ops and alerting
4. Coordinator and lead tooling

## Hook Enforcement Plane

The live hook graph now reflects the advertised control surface rather than a partial subset.

- `Task` dispatch is governed by `token-guard.py` and `model-router.py`.
- Global pre-tool spend enforcement is applied through `budget-guard.py` and `check-inbox.sh`.
- Read discipline is enforced by `read-efficiency-guard.py` plus `read-cache.py`.
- Write/edit guardrails include `review-gate.py` and `credential-guard.py`.
- Tool-result context control is applied through `result-compressor.py`.
- Session start runs `self-heal.py`, `cost-tagger.py`, and `session-slo-check.py`.
- Session and subagent lifecycle telemetry is written by `session-tracker.py`, `agent-metrics.py`, and `session-summary.py`.
- `routing-reminder.py` is live on `UserPromptSubmit`.

## Data Plane

The system still uses local JSON and JSONL files as its operational substrate, but the important difference is that those files now have explicit contracts and validation.

- Audit and metrics records are emitted through versioned hook contracts.
- Session summaries are stored as daily JSONL rows.
- Cost/runtime caches are stored under the cost directory and surfaced through the unified CLI and statusline.
- Ops snapshots and alert state are cached for operator views and historical analysis.
- `schemas/v1/` defines the supported shapes for the core record families.

## Ops Plane

The ops layer converts raw hook and cost records into operator-facing views.

- `ops_alerts.py` emits local and inbox alerts with dedupe state.
- `ops_trends.py` and `ops_aggregator.py` build rolling cost and anomaly views.
- `ops_recap.py` reconstructs recent session behavior from audit and metrics trails.
- `observability.py` and `cost_runtime.py` provide health, statusline, budget, and recap surfaces.

## Coordinator Plane

The coordinator extraction is now complete enough to run and test in the repository itself.

- Full `src/coordinator/` package, `lib/`, `scripts/`, `test/`, and package metadata are present.
- `src/lead-tools/` exposes shell wrappers expected by the coordinator lifecycle tests.
- The fresh-runtime certification materializes the coordinator into a temp `~/.claude/mcp-coordinator` and validates spawn behavior.
- The source-tree coordinator suite is part of the release gate, not an orphaned subtree.

## Current Architectural Truth

The repository is no longer best described as “strong core plus dormant ambitions.” The accurate picture is:

- Active hook graph with live enforcement for budget, review, cache, compression, routing reminder, self-heal, and session SLO checks
- Self-contained fresh-runtime certification
- Versioned schemas over the key file-backed state
- Complete coordinator package with lead-tool wrappers and green source-tree tests

The remaining real weaknesses are narrower:

- File-backed state is still the backbone, so operational integrity depends on good local filesystem behavior.
- Some code paths still assume `~/.claude` as the installed runtime target instead of using a cleaner path abstraction.
- Upstream prompt-cache bugs and platform throttling are only locally mitigable, not locally fixable.
