# Token Management System for Claude Code

A comprehensive token/budget management, cost tracking, and usage optimization system built for Claude Code (Anthropic's CLI).

## What This Is

This system was built by Drew Dawson (February-April 2026) to solve the token waste, cost overruns, and budget transparency problems that plague Claude Code usage. It consists of:

- **Budget Guards** — PreToolUse hooks that intercept agent dispatches and block/warn when spending is excessive
- **Cost Tracking** — Real-time cost aggregation from ccusage backend with caching and statusline display
- **Model Routing** — Automatic Haiku/Sonnet selection based on task complexity
- **Operational Alerting** — Anomaly detection, threshold alerts, and 7-day trending
- **Session Analytics** — Per-session, per-agent, and per-team cost attribution
- **MCP Coordinator Integration** — Cost tools exposed via MCP for multi-session coordination

## Architecture Overview

See `docs/architecture/` for full diagrams and data flow documentation.

## Key Parameters

| Parameter | Value | Where |
|-----------|-------|-------|
| Monthly Budget | $200 USD | config/budgets.json |
| Hourly Token Limit | 200,000 | budget-guard.py |
| Warn Threshold | 75% hourly / 80% monthly | budget-guard.py / budgets.json |
| Block Threshold | 92% hourly / 95% monthly | budget-guard.py / budgets.json |
| Max Concurrent Agents | 5 | config/token-guard-config.json |
| Max Per Agent Type | 1 | config/token-guard-config.json |
| Fail Mode | Open (warn, don't hard-block) | config/token-guard-config.json |
| Cache TTL | 60 seconds | config/cost-config.json |
| Plan Type | Max ($200/mo subscription) | config/token-guard-config.json |

## Directory Structure

```text
/Users/drewdawson/projects/token-management/
|-- src/
|   |-- hooks/
|   |   |-- guards/
|   |   |-- tracking/
|   |   |-- routing/
|   |   |-- ops/
|   |   |-- infrastructure/
|   |-- scripts/
|   |   |-- core/
|   |   |-- analytics/
|   |   |-- reporting/
|   |-- coordinator/
|-- config/
|-- data/
|   |-- sessions/
|   |-- weekly/
|   |-- monthly/
|   |-- daily/
|   |-- alerts/
|-- docs/
|   |-- architecture/
|   |-- analysis/
|   |-- comparisons/
|   |-- adrs/
|-- tests/
|-- README.md
|-- .claude/
|   |-- CLAUDE.md
```

## How to Run the Regression Tests

```bash
python3 tests/run_token_system_regression.py
```

Note: this harness primarily smoke-tests the live `~/.claude/` environment referenced by the extracted scripts, not a fully self-contained copy of this repository.

## Context: Why This Exists

In March-April 2026, the Claude Code community experienced a severe token usage crisis. Cache bugs inflated token costs 10-20x. Undisclosed peak-hour throttling drained session limits in fractions of expected time. Users on $200/month Max plans watched their usage jump from 21% to 100% on a single prompt.

This system was built to combat those exact problems at the local level — providing transparency, enforcement, and optimization that Anthropic's platform does not natively offer.
