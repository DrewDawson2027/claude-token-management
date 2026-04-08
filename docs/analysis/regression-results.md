# Regression Results

## 2026-04-08 Certification Snapshot

### Fresh Runtime Certification

Command:

```bash
python3 tests/run_token_system_regression.py
```

Result:

- `10/10` checks passed
- `502 passed, 16 skipped` in vendored hook tests
- `6 passed` in repo-native pytest coverage for runtime overrides, drain bench, and guard behavior
- Schema validation included in the certification run
- Coordinator `npm ci`, syntax check, and spawn smoke all passed

Checks covered:

1. Vendored hook test suite against a materialized temporary runtime
2. Schema validation for audit, metrics, alerts, session summaries, cost cache, usage index, and ops snapshot
3. Repo-native pytest coverage for benchmark CLI, runtime overrides, and token-guard behavior
4. `drain_bench.py --json`
5. `health-check.sh --stats`
6. `cost_runtime.py statusline`
7. `observability.py health-report`
8. Coordinator dependency install
9. Coordinator syntax validation
10. Coordinator spawn smoke

### Standalone Schema Validation

Command:

```bash
python3 tests/validate_schemas.py
```

Result:

- `1,305` documents validated
- `0` schema errors

Coverage:

- Generated audit records
- Generated agent metrics lifecycle/usage records
- `833` alert events
- Alert state snapshot
- `463` session summary rows
- Cost cache snapshot
- Usage index snapshot
- Ops snapshot
- Benchmark report snapshot

### Live Runtime Validation

Commands:

```bash
cd ~/.claude && python3 -m pytest hooks/tests -q
bash ~/.claude/hooks/health-check.sh
```

Result:

- Hook suite: `481 passed, 37 skipped`
- Health-check: `42 passed, 0 failed, 0 warnings`
- Live drain benchmark: `9/9` passed
- Source-tree coordinator suite: `316 passed, 0 failed`
- Status: `HEALTHY`

## Current Read

The repository is no longer a thin analytical extraction. It now certifies as a self-contained runtime artifact, validates its core file contracts, and keeps the source-tree coordinator test surface green alongside the installed live runtime.
