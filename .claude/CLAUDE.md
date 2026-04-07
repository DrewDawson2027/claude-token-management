# Token Management System — Project Rules

## What This Project Is
A standalone collection of the token/budget management system extracted from Drew's Claude Code configuration (~/.claude/). These files are COPIES — the originals live in ~/.claude/ and are the canonical versions.

## Rules

1. **READ ONLY** — Do not modify source files unless explicitly asked. These are extracted copies for analysis.
2. **No Fabrication** — Every claim about code behavior must cite the specific file and line. "I think it does X" is never acceptable — read the code and confirm.
3. **Brutal Honesty** — The analysis must be ruthlessly honest. If something is bad, say it's bad. If something is half-finished, say it's half-finished. No diplomatic softening.
4. **Anthropic-Grade Evaluation** — Evaluate as if you were a senior engineer at Anthropic reviewing a contribution. What would pass? What would get rejected? What would get a "promising but needs work"?
5. **Community Context** — Every architectural decision should be evaluated against the real problems the community is experiencing (see docs/comparisons/).

## Key Files to Start With
1. `src/hooks/guards/token-guard.py` — The heavyweight guard (~1,500 lines)
2. `src/hooks/guards/budget-guard.py` — Budget enforcement (~500 lines)
3. `src/scripts/core/cost_runtime.py` — Cost aggregation engine
4. `src/scripts/core/pricing.py` — Pricing tables
5. `config/token-guard-config.json` — Master configuration
6. `config/budgets.json` — Budget definitions
7. `tests/run_token_system_regression.py` — Regression suite

## Testing
```bash
python3 tests/run_token_system_regression.py
```

## File Naming Conventions
- Python hooks: snake_case or kebab-case (legacy)
- JSON configs: kebab-case
- JS coordinator tools: kebab-case
