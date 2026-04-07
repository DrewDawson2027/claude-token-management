# Weaknesses

## 1. The Claimed Architecture Is Broader Than The Live Architecture

The biggest weakness is architectural truthfulness. The extracted tree contains many files that sound central, but the copied settings snapshot only wires a subset of them. `budget-guard.py`, `review-gate.py`, `read-cache.py`, `result-compressor.py`, `session-slo-check.py`, `self-heal.py`, and `routing-reminder.py` are not active in the snapshot (`config/settings-snapshot.json:143-325`). That means the directory structure overstates the live protection level.

## 2. The Extracted Repository Is Not Actually Standalone

Many files hardcode `~/.claude` paths instead of local repository paths, which is acceptable for the live personal system but weakens the extraction. The coordinator layer is worse: `index.js`, `team-dispatch.js`, and `cost-comparison.js` all import missing siblings or missing `./lib/*` modules, so the extracted coordinator cannot run as copied (`src/hooks/ops/ops_sources.py:14-24`, `src/coordinator/index.js:20-115`, `src/coordinator/team-dispatch.js:6-11`, `src/coordinator/cost-comparison.js:10-12`).

## 3. Several Dormant Hooks Would Break If Activated

`hook_utils.py` does not define `record_hook_outcome` or `track_context_growth`, yet `budget-guard.py`, `read-cache.py`, `result-compressor.py`, `cost-tagger.py`, and `session-tracker.py` all import them. That turns dormant code into latent failure (`src/hooks/infrastructure/hook_utils.py:40-165`, `src/hooks/infrastructure/result-compressor.py:56-60`, `src/hooks/infrastructure/result-compressor.py:95-108`, `src/hooks/guards/budget-guard.py:393-413`, `src/hooks/infrastructure/read-cache.py:176-187`, `src/hooks/tracking/cost-tagger.py:134-143`, `src/hooks/tracking/session-tracker.py:255-269`).

## 4. The Mandatory-Action Persistence Story Is Incomplete

The queue producers exist and clearly expect a re-delivery consumer, but the extracted project does not contain that consumer. `auto-review-dispatch.py`, `build-chain-dispatcher.py`, and `chain-advance.py` therefore describe a persistence model that the repository cannot execute on its own (`src/hooks/infrastructure/auto-review-dispatch.py:2-10`, `src/hooks/infrastructure/build-chain-dispatcher.py:2-9`, `src/hooks/infrastructure/chain-advance.py:2-9`).

## 5. The `cost_data.py` Refactor Is Half-Finished

`cost_data.py` claims the data I/O layer was extracted out of `cost_runtime.py`, but the runtime still defines its own `UsageRecord`, local record loader, `run_ccusage`, and budget computation. That leaves the repository in an awkward "before and after at the same time" state (`src/scripts/core/cost_data.py:1-13`, `src/scripts/core/cost_runtime.py:173-343`, `src/scripts/core/cost_runtime.py:544-652`).

## 6. The Reporting Layer Overreaches Its Data Contracts

`token_mgmt_monthly_report.py` assumes `usage-index.json` has a `sessions` dictionary with per-session `date` and `cost_usd` fields. The copied `usage-index-snapshot.json` only contains `fingerprint`, `generatedAt`, and `windows`. That means a core reporting script is built on a data shape the snapshot does not provide (`src/scripts/reporting/token_mgmt_monthly_report.py:494-507`, `data/usage-index-snapshot.json`).

## 7. Budget Enforcement Is Weaker Than The Narrative Implies

`token-guard.py` is live and strong for Task-spawn control, but it never invokes `budget-guard.py`, and the settings snapshot does not wire `budget-guard.py` separately. The monthly budget config exists, yet the dedicated budget hook is not part of the live graph represented here (`src/hooks/guards/token-guard.py:665-1123`, `src/hooks/guards/budget-guard.py:3-24`, `config/settings-snapshot.json:185-249`, `config/token-guard-config.json:39-48`).

## 8. Fail-Open Helps Availability But Hides Some Breakage

Many hooks intentionally exit cleanly on failure so they never block work. That is sensible for a personal CLI, but it also means missing helpers, malformed logs, broken subprocess calls, or stale data can quietly downgrade protection instead of surfacing as hard failures (`config/token-guard-config.json:9-18`, `src/hooks/tracking/session-summary.py:9-10`, `src/hooks/tracking/session-slo-check.py:10-16`, `src/hooks/infrastructure/self-heal.py:12-13`).

## 9. Routing Is Mostly Branding Around A Small Rule Set

The routing subsystem sounds policy-rich because `routing-policy.json` exists and `routing-reminder.py` describes user-prompt reminders. In reality, the live router just enforces an allowlist and a single hard Explore rule. That mismatch matters because it makes the routing stack look smarter than it is (`src/hooks/routing/model-router.py:57-83`, `config/routing-policy.json:1-47`, `src/hooks/routing/routing-reminder.py:2-14`).

## 10. The Regression Suite Validates The Home Directory More Than This Repository

The copied regression harness mostly shells into `~/.claude` tests, scripts, MCP, and shell helpers. That is useful for the live environment but weak evidence for the extracted repository’s health (`tests/run_token_system_regression.py:10-23`, `tests/run_token_system_regression.py:48-152`).
