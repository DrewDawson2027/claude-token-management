# Regression Results

## Command Run

```bash
python3 tests/run_token_system_regression.py
```

Executed from `/Users/drewdawson/projects/token-management` on **April 7, 2026**.

## Summary

- Total checks: 8
- Passed: 6
- Failed: 2

The harness behaved as the code suggests: it primarily validated the live `~/.claude` environment rather than this extracted repository (`tests/run_token_system_regression.py:10-23`, `tests/run_token_system_regression.py:48-152`).

## Passes

- `scripts_pytests`: `96 passed` in `~/.claude/scripts/tests`.
- `cli_ops_today_smoke_cached`: passed.
- `cli_session_recap_smoke`: passed.
- `mcp_node_check`: passed.
- `mcp_coord_session_health`: passed.
- `trust_engine_adapter_smoke`: passed.

## Failures

### 1. `hooks_pytests`

- Result: `21 failed, 470 passed, 16 skipped, 11 errors`
- The most important pattern in the failures is that hook-counter tests error around missing `record_hook_outcome` behavior, which matches the source-analysis finding that several hooks import helpers not implemented in `hook_utils.py` (`src/hooks/infrastructure/hook_utils.py:40-165`, `src/hooks/guards/budget-guard.py:393-413`, `src/hooks/infrastructure/read-cache.py:176-187`, `src/hooks/infrastructure/result-compressor.py:95-108`, `src/hooks/tracking/cost-tagger.py:134-143`, `src/hooks/tracking/session-tracker.py:255-269`).

### 2. `health_check_stats`

- Result: failed with `STATUS: UNHEALTHY`.
- The output reported `coordinator MCP missing or miswired`.
- stderr also showed a shell expression error in `health-check.sh`.

## Interpretation

This regression run is useful as evidence about the live home-directory system, not as proof that the extracted project is self-contained.

- The strongest evidence from the run is that the live scripts test suite under `~/.claude/scripts/tests` is healthy.
- The strongest negative evidence is that the hook test suite and health check both surface the same class of integration problems already visible in source inspection.
- The run does not validate the extracted coordinator subtree because the test harness points at `~/.claude/mcp-coordinator`, not `src/coordinator/` in this repository.
