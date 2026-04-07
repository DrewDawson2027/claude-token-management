# System Overview

## Verdict

This system is a serious local control plane around Claude Code, not a single clean product surface. Its strongest live pieces are the Task guard, the Read guard, the session and agent telemetry hooks, and the Python cost runtime. Its weakest areas are integration boundaries: several advertised components are not wired in the live settings snapshot, the mandatory-action consumer is absent from the extracted project, and the extracted coordinator slice is not self-contained because its imported dependency tree was not copied (`src/hooks/guards/token-guard.py:2-39`, `src/hooks/guards/read-efficiency-guard.py:2-23`, `src/hooks/tracking/session-tracker.py:1-9`, `src/hooks/tracking/agent-metrics.py:2-8`, `src/scripts/core/cost_runtime.py:64-67`, `src/scripts/core/cost_runtime.py:655-761`, `config/settings-snapshot.json:143-325`, `src/coordinator/index.js:20-115`, `src/coordinator/team-dispatch.js:6-11`).

## Architectural Shape

The extracted project contains 52 Python and JavaScript source files grouped into nine subsystems:

- Guards: hard decision-time enforcement before Task, Read, Bash, or write tools run.
- Tracking: session-start, subagent-stop, and stop-time telemetry capture.
- Routing: model-selection controls around Task dispatch.
- Ops: alerting, trends, and operational recap views.
- Infrastructure: shared contracts, normalization, audit, queue helpers, and self-heal tooling.
- Core runtime: the cost engine, pricing, batch queue, policy, and observability scripts.
- Analytics: historical snapshots, savings estimates, and subagent usage summaries.
- Reporting: monthly and weekly rollups plus a separate system dashboard.
- Coordinator: MCP-facing JavaScript entry points intended to expose cost- and team-related tools.

That separation of concerns is real in the directory structure, and the top-level categories mostly line up with the code responsibilities (`src/hooks/infrastructure/guard_contracts.py:1-5`, `src/hooks/ops/ops_sources.py:1-24`, `src/scripts/core/cost_base.py:1-12`, `src/scripts/analytics/token_snapshots.py:2-14`).

## Actual Live Wiring

The April 7, 2026 settings snapshot shows the live system is narrower than the extracted tree implies.

### Hooks wired in the snapshot

- `Stop`: `session-summary.py` is wired, alongside unrelated lifecycle hooks (`config/settings-snapshot.json:112-139`).
- `PostToolUse`: `auto-review-dispatch.py` is wired for `Bash`; there is no `result-compressor.py` entry (`config/settings-snapshot.json:143-183`).
- `PreToolUse`: `token-guard.py`, `model-router.py`, `credential-guard.py`, `risky-command-guard.py`, and `read-efficiency-guard.py` are wired; `budget-guard.py`, `review-gate.py`, and `read-cache.py` are not (`config/settings-snapshot.json:185-249`).
- `SubagentStop`: `agent-metrics.py`, `build-chain-dispatcher.py`, and `session-tracker.py` are wired (`config/settings-snapshot.json:263-287`).
- `SessionStart`: `cost-tagger.py` is wired; `session-slo-check.py` and `self-heal.py` are not (`config/settings-snapshot.json:300-325`).

### Components present but not live in the snapshot

- `budget-guard.py` claims to be a PreToolUse hook for every tool call, but the snapshot does not register it (`src/hooks/guards/budget-guard.py:3-24`, `config/settings-snapshot.json:185-249`).
- `routing-reminder.py` claims `UserPromptSubmit`, but there is no `UserPromptSubmit` section in the copied snapshot (`src/hooks/routing/routing-reminder.py:2-14`, `config/settings-snapshot.json:1-325`).
- `result-compressor.py`, `read-cache.py`, `review-gate.py`, `session-slo-check.py`, `self-heal.py`, and the ops scripts exist but are not part of the active hook graph represented in the snapshot (`src/hooks/infrastructure/result-compressor.py:2-13`, `src/hooks/infrastructure/read-cache.py:2-16`, `src/hooks/guards/review-gate.py:2-13`, `src/hooks/tracking/session-slo-check.py:2-16`, `src/hooks/infrastructure/self-heal.py:3-13`).

## Runtime Centers

### 1. Dispatch enforcement

`token-guard.py` is the live center of policy enforcement. It loads configuration and state, performs necessity scoring, one-per-session checks, per-type caps, global cooldowns, and type-switch detection, then writes allowed-agent and Explore-target metadata back to session state (`src/hooks/guards/token-guard.py:431-534`, `src/hooks/guards/token-guard.py:665-1123`). `read-efficiency-guard.py` is the other meaningful hard guard: it blocks repeated reads, blocks long sequential-read bursts, and emits post-Explore advisories using the state written by `token-guard.py` (`src/hooks/guards/read-efficiency-guard.py:90-119`, `src/hooks/guards/read-efficiency-guard.py:147-246`, `src/hooks/guards/read-efficiency-guard.py:261-296`).

### 2. Cost aggregation

`cost_runtime.py` is the real cost data plane. It owns cache paths, local record loading, budget evaluation, statusline generation, indexed history refresh, burn-rate checks, anomaly checks, and opportunistic alert triggering (`src/scripts/core/cost_runtime.py:64-67`, `src/scripts/core/cost_runtime.py:116-169`, `src/scripts/core/cost_runtime.py:205-291`, `src/scripts/core/cost_runtime.py:608-761`, `src/scripts/core/cost_runtime.py:917-974`, `src/scripts/core/cost_runtime.py:1237-1262`, `src/scripts/core/cost_runtime.py:1717-1752`). `pricing.py` is the cleanest supporting module; it normalizes model names and converts usage dictionaries to estimated USD (`src/scripts/core/pricing.py:2-13`, `src/scripts/core/pricing.py:94-211`).

### 3. Session and agent telemetry

The session lifecycle is concrete and useful. `cost-tagger.py` tags sessions at start, `session-tracker.py` maintains hot per-session state incrementally via transcript offsets, `agent-metrics.py` parses real usage from subagent transcripts on `SubagentStop`, and `session-summary.py` writes day-level session summaries on `Stop` (`src/hooks/tracking/cost-tagger.py:2-18`, `src/hooks/tracking/cost-tagger.py:90-123`, `src/hooks/tracking/session-tracker.py:2-9`, `src/hooks/tracking/session-tracker.py:72-249`, `src/hooks/tracking/agent-metrics.py:2-8`, `src/hooks/tracking/agent-metrics.py:138-205`, `src/hooks/tracking/session-summary.py:2-10`, `src/hooks/tracking/session-summary.py:30-102`).

### 4. Ops and alerting

The ops stack is coherent on paper and substantial in code. `ops_sources.py` centralizes file and subprocess reads, `ops_alerts.py` performs deduped alert emission, `ops_aggregator.py` builds a cached operational snapshot, `ops_trends.py` scans raw JSONL into rolling cost series, and `ops_recap.py` reconstructs a per-session narrative from audit and metrics logs (`src/hooks/ops/ops_sources.py:1-24`, `src/hooks/ops/ops_alerts.py:2-31`, `src/hooks/ops/ops_alerts.py:194-291`, `src/hooks/ops/ops_aggregator.py:124-273`, `src/hooks/ops/ops_trends.py:75-157`, `src/hooks/ops/ops_recap.py:1-24`, `src/hooks/ops/ops_recap.py:60-164`). The main limitation is not implementation depth; it is that these hooks are not wired into the snapshot's active hook lifecycle (`config/settings-snapshot.json:143-325`).

## State Model

The entire design is file-backed:

- Hook state uses JSON and JSONL plus portable file locking in `hook_utils.py` (`src/hooks/infrastructure/hook_utils.py:17-128`).
- Default guard policy lives in `token-guard-config.json`, with live behavior set to `fail_open` and `max_agents = 5` (`config/token-guard-config.json:2-18`, `config/token-guard-config.json:20-48`).
- Cost limits live in `budgets.json`, which currently sets `monthlyUSD = 200` and leaves `dailyUSD = null` (`config/budgets.json:1-11`).
- Cost runtime caches are plain JSON files: `cache.json`, `usage-index.json`, `pricing-cache.json`, and `statusline-cache.json` (`src/scripts/core/cost_runtime.py:64-67`, `src/scripts/core/cost_runtime.py:751-782`, `src/scripts/core/cost_runtime.py:953-973`).

This makes the system portable and inspectable, but it also means reliability depends on local file health, implicit schemas, and scripts agreeing on file shapes.

## Intended Architecture vs Actual Architecture

The extracted tree preserves both implemented code and unrealized intent.

- `budget-guard.py` is documented as hot-path spend enforcement, but `token-guard.py` never imports or calls it, and the settings snapshot never registers it. The dispatch path therefore enforces agent-spawn rules but not the separate budget hook in the live snapshot (`src/hooks/guards/budget-guard.py:3-24`, `src/hooks/guards/token-guard.py:665-1123`, `config/settings-snapshot.json:185-249`).
- `model-router.py` is live, but the advertised `routing-policy.json` is unused; routing is effectively a small allowlist plus a hard `Explore -> haiku` rule (`src/hooks/routing/model-router.py:28-83`, `config/routing-policy.json:1-47`).
- `read-cache.py` and `result-compressor.py` are positioned as context-efficiency features, but neither is wired, and `result-compressor.py` depends on helper functions that `hook_utils.py` does not define (`src/hooks/infrastructure/read-cache.py:2-16`, `src/hooks/infrastructure/result-compressor.py:56-60`, `src/hooks/infrastructure/result-compressor.py:95-108`, `src/hooks/infrastructure/hook_utils.py:40-165`).
- The mandatory-action queue has working producers inside the extracted tree, but the extracted project contains no consumer script at all. `auto-review-dispatch.py`, `build-chain-dispatcher.py`, and `chain-advance.py` all assume a `check-inbox.sh` consumer exists (`src/hooks/infrastructure/auto-review-dispatch.py:2-10`, `src/hooks/infrastructure/build-chain-dispatcher.py:2-9`, `src/hooks/infrastructure/chain-advance.py:2-9`).
- The coordinator layer is incomplete as extracted. `index.js`, `team-dispatch.js`, and `cost-comparison.js` import helpers and `./lib/*` modules that are not present in this repository (`src/coordinator/index.js:20-115`, `src/coordinator/team-dispatch.js:6-11`, `src/coordinator/cost-comparison.js:10-12`).

## Bottom Line

The real architecture is a strong local guard-and-telemetry spine surrounded by partially integrated ambitions. The backbone is credible: Task gating, Read gating, transcript-derived telemetry, cached cost summaries, and trend/alert scripts. The system stops being coherent when it crosses subsystem boundaries: budget enforcement is not live in the snapshot, routing policy is detached from routing code, multiple hooks would fail if wired, the extracted coordinator cannot run on its own, and the mandatory-action persistence story is incomplete inside the extracted project.
