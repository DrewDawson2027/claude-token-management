# Claude Token Management

Claude Token Management is a self-contained local control plane for Claude Code token usage. It hardens the live `~/.claude` runtime and ships the same behavior as a standalone repository with certification, schemas, CI, coordinator tests, and operator documentation.

## Current Status

- Live `~/.claude` runtime and repository sources were re-converged on 2026-04-07.
- Fresh-runtime certification passes: `10/10` checks green.
- Schema validation passes: `1,307` documents validated, `0` errors.
- Source-tree coordinator suite passes: `316/316`.
- Repo-native certification tests pass: `14 passed`.
- Live hook suite passes: `481 passed, 37 skipped`.
- Live runtime health-check passes: `42 passed, 0 failed, 0 warnings`.
- Live drain benchmark passes: `9/9`.
- Live compatibility summary reports `9` tracked issue classes with `unresolved_critical = 0`.

## What It Does

- Blocks wasteful or policy-breaking subagent dispatch before spend happens.
- Enforces read-discipline through duplicate-read and burst-read controls.
- Tracks session, agent, and cost activity into local audit, metrics, and summary files.
- Surfaces burn, anomaly, budget, and ops views through Python reporting and statusline output.
- Tracks known Claude Code token-drain issue classes through a compatibility registry with repro commands, intake, and operator reporting.
- Runs a filesystem-native MCP coordinator with worker launch, messaging, planning, and lead tooling.
- Ships versioned schemas for the core record formats so file-backed state is contract-tested instead of implied.
- Blocks resumed/continued sessions with known prompt-cache risk until the operator explicitly acknowledges the compatibility warning.

## Repository Layout

```text
src/
  cli/claude_token_guard/      Unified operator CLI
  coordinator/                 MCP coordinator package and tests
  hooks/
    guards/                    Dispatch, budget, credential, shell, and read guards
    infrastructure/            Shared contracts, queue helpers, self-heal, context tools
    ops/                       Alerts, trends, recap, and ops snapshot builders
    routing/                   Model routing and prompt reminders
    runtime/                   Shell/runtime hooks and lifecycle helpers
    tracking/                  Session, agent, and lifecycle telemetry
  lead-tools/                  Shell wrappers for lead workflows
  scripts/
    core/                      Cost runtime, observability, pricing, policy tools
    analytics/                 Snapshot and savings analysis
    reporting/                 Higher-level operational reports
config/                        Canonical settings and policy/config inputs
data/                          Snapshots and fixtures for certification
docs/                          Architecture, operator, migration, release, and comparison docs
schemas/v1/                    JSON schemas for audit, metrics, alerts, summaries, and caches
tests/                         Fresh-runtime cert harness and schema validator
```

## Certification

Primary commands:

```bash
python3 tests/validate_schemas.py
python3 tests/run_token_system_regression.py
PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/npm --prefix src/coordinator test
```

Convenience wrappers:

```bash
npm run cert:schemas
npm run cert:a-plus:fresh
npm run cert:coordinator
npm run cert:all
```

## Core Docs

- `docs/architecture/system-overview.md`
- `docs/architecture/hook-lifecycle.md`
- `docs/architecture/data-flow.md`
- `docs/analysis/component-grades.md`
- `docs/analysis/production-readiness.md`
- `docs/analysis/regression-results.md`
- `docs/TOKEN_MANAGEMENT_OPERATOR_PLAYBOOK.md`
- `docs/TOKEN_MANAGEMENT_MIGRATION_GUIDE.md`
- `docs/COMPATIBILITY_MATRIX.md`
- `docs/RELEASE_PROCESS.md`

## Real Limits

- This is a local Claude Code control plane, not Anthropic's billing or rate-limit service.
- Upstream prompt-cache regressions, peak-hour throttling, and subscription policy changes are now tracked, benchmarked, and worked around locally; the root platforms remain upstream-owned.
- The coordinator dependency tree is currently clean, but dependency hygiene remains an active maintenance obligation.
