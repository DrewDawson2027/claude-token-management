# Component Grades

## Weighted Anthropic Rubric

| Dimension | Weight | Grade | Justification |
| --- | --- | --- | --- |
| Architecture | 25% | B | The project separates guards, tracking, routing, ops, and reporting cleanly, and the hook lifecycle is used in sensible places. The downgrade comes from architecture drift: the snapshot does not wire several advertised hooks, `routing-policy.json` is unused, and the coordinator extraction is incomplete (`config/settings-snapshot.json:143-325`, `src/hooks/routing/model-router.py:28-83`, `src/coordinator/index.js:20-115`). |
| Reliability | 20% | C | The system uses atomic writes, file locks, and many fail-open paths, which is good for local resilience, but it also relies on implicit file schemas, local disk health, and helper functions that do not actually exist in `hook_utils.py` (`src/hooks/infrastructure/hook_utils.py:17-165`, `src/hooks/infrastructure/result-compressor.py:56-60`, `src/hooks/tracking/session-tracker.py:255-269`). |
| Observability | 15% | B | Per-agent transcript parsing, cost caches, ops snapshots, alert logs, and recap tools give far better local visibility than stock Claude Code. The downgrade is because much of that observability is operator-driven rather than live-hook-driven (`src/hooks/tracking/agent-metrics.py:138-205`, `src/scripts/core/cost_runtime.py:917-974`, `src/hooks/ops/ops_alerts.py:194-291`, `src/hooks/ops/ops_aggregator.py:124-273`). |
| Cost Efficiency | 20% | C | The live Task guard and Read guard attack real waste sources, and the cost runtime/statusline reduce blindness. The grade stays in the C range because budget enforcement is not actually live in the snapshot, result compression is dormant, and model routing is far simpler than the policy story suggests (`src/hooks/guards/token-guard.py:665-1123`, `src/hooks/guards/read-efficiency-guard.py:147-246`, `config/settings-snapshot.json:185-249`, `src/hooks/infrastructure/result-compressor.py:2-13`, `src/hooks/routing/model-router.py:64-83`). |
| Code Quality | 10% | C | There are good docstrings, typed dicts, and normalization helpers, but naming is inconsistent, the codebase mixes polished modules with one-off scripts, and the partial `cost_data.py` extraction plus broken helper imports show incomplete cleanup (`src/hooks/infrastructure/guard_contracts.py:1-19`, `src/scripts/core/cost_data.py:1-13`, `src/scripts/core/cost_runtime.py:173-343`, `src/hooks/infrastructure/hook_utils.py:40-165`). |
| Completeness | 5% | C | The system covers dispatch waste, read waste, local cost visibility, session analytics, and ops recap. It does not solve platform throttling, prompt-cache bugs, file-line-number overhead, or native billing integration, and several built components are dormant (`src/hooks/infrastructure/read-cache.py:2-16`, `src/hooks/infrastructure/self-heal.py:3-13`, `src/scripts/core/cost_runtime.py:1717-1752`). |
| Production Readiness | 5% | D | This is a strong local power-user system, not a productized Anthropic feature. Hardcoded `~/.claude` paths, incomplete extraction, file-backed state, and tests aimed at the original home directory would block shipping (`src/hooks/ops/ops_sources.py:14-24`, `src/coordinator/index.js:20-115`, `tests/run_token_system_regression.py:10-23`, `tests/run_token_system_regression.py:48-152`). |

## Overall Grade

**Overall: C+**

This system is better than a hobby script and worse than a shippable platform feature. The live spine is real: agent-dispatch enforcement, redundant-read blocking, transcript-derived telemetry, cached cost summaries, and historical analytics all work toward the stated goal. The reason it does not reach B territory overall is that the architecture overstates how integrated the system really is. Too many protections are dormant, some hooks would fail if activated, the coordinator slice is incomplete, and the extracted test story validates the original home directory rather than the extracted repository.

### Top 3 strengths

- Hard controls are placed before expensive behavior runs, especially `Task` and `Read` (`src/hooks/guards/token-guard.py:10-22`, `src/hooks/guards/read-efficiency-guard.py:10-18`).
- The telemetry layer measures from real transcripts rather than relying only on estimated counters (`src/hooks/tracking/agent-metrics.py:2-8`, `src/hooks/tracking/agent-metrics.py:138-205`).
- Local visibility is far better than stock CLI defaults because `cost_runtime.py`, `ops_alerts.py`, and `ops_aggregator.py` build durable cost state and operational views (`src/scripts/core/cost_runtime.py:655-761`, `src/hooks/ops/ops_alerts.py:107-156`, `src/hooks/ops/ops_aggregator.py:199-273`).

### Top 3 weaknesses

- The live hook graph is narrower than the directory tree and docs imply (`config/settings-snapshot.json:143-325`).
- Several dormant hooks depend on helper functions that do not exist (`src/hooks/infrastructure/result-compressor.py:56-60`, `src/hooks/infrastructure/read-cache.py:176-187`, `src/hooks/infrastructure/hook_utils.py:40-165`).
- The extracted coordinator is not runnable because its dependency tree was not copied (`src/coordinator/index.js:20-115`, `src/coordinator/team-dispatch.js:6-11`).

### Most impressive thing

The most impressive thing is the transcript-derived attribution path. `agent-metrics.py` and `session-tracker.py` extract real usage from the artifacts Claude Code already writes, which gives the system a factual measurement layer instead of a purely aspirational one (`src/hooks/tracking/agent-metrics.py:138-205`, `src/hooks/tracking/session-tracker.py:72-249`).

### Most concerning thing

The most concerning thing is the gap between claimed enforcement and actual live enforcement. Budget guard, read cache, result compression, self-heal, session SLO checks, and review gating all exist in the tree, but the snapshot does not actually run them (`config/settings-snapshot.json:143-325`).

### What Anthropic Would Say

Anthropic would likely describe this as a promising internal-tool proposal with sharp ideas and insufficient systems rigor. The review would praise decision-time guard placement, transcript-based telemetry, and low-infrastructure experimentation. It would reject the current implementation for shipping because of dormant components, incomplete packaging, file-backed fragility, and missing authoritative integration with the platform's own meter and rate-limit systems.

## Subsystem Grades

### Guards — **B**

- Does well: `token-guard.py` enforces necessity, per-type caps, session caps, cooldowns, and type-switch detection before agent spend happens (`src/hooks/guards/token-guard.py:665-1065`).
- Does well: `read-efficiency-guard.py` attacks a real waste source with clear block thresholds and session-local state (`src/hooks/guards/read-efficiency-guard.py:147-246`).
- Does poorly: the guard story is overstated because `budget-guard.py` and `review-gate.py` are not live in the copied snapshot (`config/settings-snapshot.json:185-249`).
- Missing: real authoritative budget enforcement on the live Task path and integration between token guard and budget guard.
- Anthropic PR review: "Strong prevention instincts, but the submitted design document claims more live coverage than the code path actually has."

### Tracking — **B**

- Does well: the lifecycle model is coherent across `SessionStart`, `SubagentStop`, and `Stop` (`config/settings-snapshot.json:112-139`, `config/settings-snapshot.json:263-325`).
- Does well: `agent-metrics.py` measures actual transcript usage rather than guessed budgets (`src/hooks/tracking/agent-metrics.py:138-205`).
- Does poorly: some exit-path bookkeeping depends on missing `record_hook_outcome` helpers (`src/hooks/tracking/session-tracker.py:255-269`, `src/hooks/tracking/cost-tagger.py:134-143`).
- Missing: stronger idempotency contracts and explicit schema validation between writers and downstream reports.
- Anthropic PR review: "Keep the telemetry architecture; tighten contracts and remove implicit coupling before merge."

### Routing — **C**

- Does well: the live router does at least hard-block unsupported models and enforces `Explore -> haiku` (`src/hooks/routing/model-router.py:57-83`).
- Does poorly: the router ignores `routing-policy.json`, so the policy surface is largely dead configuration (`src/hooks/routing/model-router.py:28-83`, `config/routing-policy.json:1-47`).
- Missing: actual task-complexity scoring, policy evaluation, and a live `UserPromptSubmit` reminder path.
- Anthropic PR review: "Good guardrail, but this is not yet a routing subsystem. It is an allowlist with one special case."

### Ops — **B**

- Does well: alert deduplication, burn/anomaly checks, source freshness, and aggregated ops snapshots are substantial and useful (`src/hooks/ops/ops_alerts.py:92-156`, `src/hooks/ops/ops_aggregator.py:177-273`).
- Does well: trend generation from raw JSONL avoids depending entirely on a single cache (`src/hooks/ops/ops_trends.py:75-157`).
- Does poorly: the ops stack is mostly CLI/manual in the snapshot rather than fully live-hook-driven (`config/settings-snapshot.json:143-325`).
- Missing: automated remediation and a real-time operator dashboard.
- Anthropic PR review: "Promising observability tooling; convert it from personal operations scripts into supported product telemetry."

### Infrastructure — **C**

- Does well: normalization, contracts, portable locks, and atomic writes are strong foundational choices (`src/hooks/infrastructure/guard_contracts.py:1-19`, `src/hooks/infrastructure/hook_utils.py:17-128`).
- Does poorly: `hook_utils.py` does not implement helper functions required by several other modules, which turns dormant features into latent breakage (`src/hooks/infrastructure/hook_utils.py:40-165`, `src/hooks/infrastructure/result-compressor.py:56-60`).
- Does poorly: the mandatory-action queue is only half-present in the extracted project because producers were copied without the consumer shell script.
- Missing: a single authoritative queue consumer and explicit package boundaries.
- Anthropic PR review: "The infrastructure intent is good; the integration discipline is not finished."

### Core Runtime — **B**

- Does well: `cost_runtime.py` is the most valuable executable in the tree and materially improves local cost visibility (`src/scripts/core/cost_runtime.py:655-761`, `src/scripts/core/cost_runtime.py:917-974`).
- Does well: `pricing.py` is clean and composable (`src/scripts/core/pricing.py:94-211`).
- Does poorly: `cost_data.py` is an incomplete refactor because the runtime still duplicates its core data layer (`src/scripts/core/cost_data.py:1-13`, `src/scripts/core/cost_runtime.py:173-343`).
- Missing: authoritative product-meter integration and cleaner decomposition.
- Anthropic PR review: "Keep the runtime concepts, but finish the refactor or revert it; don't land both states at once."

### Analytics — **C**

- Does well: the system has a credible historical spine via `token_snapshots.py`, per-session JSONL, and subagent usage summaries (`src/scripts/analytics/token_snapshots.py:2-14`, `src/scripts/analytics/subagent-usage.py:2-17`).
- Does well: `savings_calculator.py` at least grounds counterfactuals in observed medians (`src/scripts/analytics/savings_calculator.py:2-9`).
- Does poorly: savings remain heuristic, and `calculate_real_savings.py` reads as a corrective side script instead of a finished replacement.
- Missing: stronger validation tying savings estimates back to authoritative billing.
- Anthropic PR review: "Useful analysis layer, but don't let heuristic savings turn into product claims without stronger proof."

### Reporting — **C**

- Does well: the reporting scripts package operational and executive views for a human operator.
- Does poorly: `token_mgmt_monthly_report.py` assumes a `usage-index.json.sessions` structure that the copied snapshot does not have, so budget math can silently fall back to zero (`src/scripts/reporting/token_mgmt_monthly_report.py:494-507`, `data/usage-index-snapshot.json`).
- Does poorly: the monthly report mixes grounded measurement with speculative roadmap text, which weakens trust (`src/scripts/reporting/token_mgmt_monthly_report.py:641-767`).
- Missing: validated data contracts and slimmer, evidence-only reports.
- Anthropic PR review: "Separate measured reporting from strategy memo content before considering this production-safe."

### Tests — **D**

- Does well: there is at least a single entry point intended to smoke-test hooks, CLI, MCP, and fallback utilities (`tests/run_token_system_regression.py:48-152`).
- Does poorly: the suite primarily targets `~/.claude`, not the extracted project, so it is not a true repository regression suite (`tests/run_token_system_regression.py:10-23`).
- Missing: self-contained tests for the copied repository, fixtures for file-backed state, and coverage for dormant components.
- Anthropic PR review: "This is a home-directory smoke harness, not a portable regression suite."

### Coordinator — **D**

- Does well: the schema/profile surface shows real thought about schema tax and MCP ergonomics (`src/coordinator/index.js:117-171`, `src/coordinator/index.js:218-291`).
- Does well: `team-dispatch.js` threads budget policy fields into worker spawn (`src/coordinator/team-dispatch.js:161-183`).
- Does poorly: the extraction is incomplete, so the coordinator cannot actually run here (`src/coordinator/index.js:20-115`, `src/coordinator/team-dispatch.js:6-11`, `src/coordinator/cost-comparison.js:10-12`).
- Missing: the required `lib/` dependency tree and a self-contained packaging boundary for coordinator features.
- Anthropic PR review: "Interesting interface surface, but this repository does not include the implementation needed to evaluate it."
