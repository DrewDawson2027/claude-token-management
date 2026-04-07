# Drew's System Vs The March-April 2026 Community Crisis

The public crisis started surfacing on **March 23, 2026** and intensified through **April 4, 2026**. The core themes were abnormal usage drain, prompt-cache breakage, undisclosed peak-hour throttling, context-window bloat, and file-read overhead. This comparison uses the handoff's crisis map plus the extracted codebase and public issue trail such as [Issue #41930](https://github.com/anthropics/claude-code/issues/41930), [Issue #38335](https://github.com/anthropics/claude-code/issues/38335), and [Issue #20223](https://github.com/anthropics/claude-code/issues/20223).

## Comparison Map

| Community problem | Drew's system component | Addresses it? | How well? | Evidence |
| --- | --- | --- | --- | --- |
| Cache bugs (10-20x inflation) | `read-cache.py`, `result-compressor.py` | **No / weak** | These are local read/context helpers, not fixes for Anthropic prompt-cache invalidation. `read-cache.py` is also dormant, and `result-compressor.py` is both dormant and broken if activated. | `src/hooks/infrastructure/read-cache.py:2-16`, `src/hooks/infrastructure/result-compressor.py:56-60`, `src/hooks/infrastructure/hook_utils.py:40-165`, `config/settings-snapshot.json:143-325` |
| No usage visibility | `cost_runtime.py`, statusline cache, ops snapshot | **Yes** | This is one of the system's strongest wins. It produces local cached summaries, indexed history, and statusline output. | `src/scripts/core/cost_runtime.py:64-67`, `src/scripts/core/cost_runtime.py:655-761`, `src/scripts/core/cost_runtime.py:917-974`, `data/statusline-snapshot.json`, `data/ops-snapshot.json` |
| No budget enforcement | `token-guard.py`, `budget-guard.py` | **Partial** | Agent-spawn discipline is real, but dedicated budget enforcement is not live in the copied snapshot. | `src/hooks/guards/token-guard.py:665-1123`, `src/hooks/guards/budget-guard.py:3-24`, `config/settings-snapshot.json:185-249` |
| Agent spawn waste | `token-guard.py` | **Yes** | Strong. Necessity checks, one-per-session types, per-type caps, cooldowns, and type-switch detection are direct responses to runaway agent usage. | `src/hooks/guards/token-guard.py:14-23`, `src/hooks/guards/token-guard.py:665-1065` |
| Model cost differences | `model-router.py` | **Partial** | The live router only enforces `sonnet/haiku` plus `Explore -> haiku`. That helps, but it is a small ruleset, not a full cost-aware router. | `src/hooks/routing/model-router.py:57-83`, `config/routing-policy.json:1-47` |
| No alerting on overuse | `ops_alerts.py`, `ops_trends.py`, `ops_aggregator.py` | **Partial to yes** | The implementation is real, with deduped alerts and trend windows, but it is not fully live-hook-driven in the snapshot. | `src/hooks/ops/ops_alerts.py:92-156`, `src/hooks/ops/ops_alerts.py:194-291`, `src/hooks/ops/ops_trends.py:206-236`, `config/settings-snapshot.json:143-325` |
| Redundant file reads | `read-efficiency-guard.py` | **Yes** | Strong. This is one of the cleanest direct responses to a known waste mode. | `src/hooks/guards/read-efficiency-guard.py:147-246`, `config/settings-snapshot.json:243-249` |
| No historical analytics | `session-summary.py`, `token_snapshots.py`, `data/sessions`, `data/weekly` | **Yes** | Strong. The system keeps day-level session summaries and rollups for retrospective analysis. | `src/hooks/tracking/session-summary.py:30-102`, `src/scripts/analytics/token_snapshots.py:2-14`, `data/sessions`, `data/weekly` |
| Peak-hour throttling | none, except indirect burn/anomaly detection | **No** | The code can detect faster burn, but it cannot change Anthropic's peak-hour policy or reserve session capacity. | `src/scripts/core/cost_runtime.py:1237-1262`, `src/hooks/ops/ops_alerts.py:222-235` |
| Context window bloat | `result-compressor.py`, read guard, lean-agent ideas outside this repo | **Weak / partial** | The extracted source has only a dormant result-compression hook and upstream read discipline. There is no robust live context-budget controller here. | `src/hooks/infrastructure/result-compressor.py:2-13`, `src/hooks/guards/read-efficiency-guard.py:147-246`, `config/settings-snapshot.json:143-183` |
| File line-number overhead | none directly | **No** | The system reduces repeated reads, but it does not change how Claude Code formats file-read payloads. | `src/hooks/guards/read-efficiency-guard.py:147-246` |
| Third-party tool compatibility | coordinator concepts | **No** | The copied coordinator is incomplete and nothing here solves Anthropic's subscription restrictions on third-party agentic tools. | `src/coordinator/index.js:20-115`, `src/coordinator/team-dispatch.js:6-11` |

## What It Truly Solves

The system is best understood as a local defense stack against **self-inflicted waste**:

- unnecessary agent spawns,
- redundant reads,
- poor local visibility,
- lack of session-level attribution,
- and lack of retrospective analytics.

It is materially weaker against **platform-inflicted waste**:

- Anthropic prompt-cache bugs,
- peak-hour throttling,
- line-number overhead,
- and third-party subscription changes.

## Bottom Line

Against the March-April 2026 crisis, Drew's system is strong where the user still has local control and weak where the platform is the bottleneck. It meaningfully reduces avoidable local waste. It does not and cannot fully solve upstream usage-drain bugs or platform policy changes.

## External Sources

- [GitHub Issue #41930](https://github.com/anthropics/claude-code/issues/41930)
- [GitHub Issue #38335](https://github.com/anthropics/claude-code/issues/38335)
- [GitHub Issue #20223](https://github.com/anthropics/claude-code/issues/20223)
- [Anthropic: Manage costs effectively](https://code.claude.com/docs/en/costs)
