# Contributing

Thanks for contributing to Claude Token Management.

## What Matters Here

This project exists to reduce real Claude Code token waste with evidence, not to accumulate speculative controls. Good contributions do at least one of these:

- block avoidable spend before it happens
- measure a drain class more accurately
- improve operator visibility
- improve fresh-runtime or live-runtime certification
- package a real-world regression into a reproducible benchmark or fixture

## Development Setup

```bash
git clone https://github.com/DrewDawson2027/claude-token-management.git
cd claude-token-management
npm run cert:all
```

Primary checks:

```bash
python3 tests/validate_schemas.py
python3 tests/run_token_system_regression.py
PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/npm --prefix src/coordinator test
```

## Pull Request Expectations

Every pull request should:

- state the problem it fixes
- explain why the change reduces, measures, or clarifies token drain
- include tests or explain why no new test is needed
- keep repo-mode and live-runtime behavior aligned when the change affects shared paths
- update docs if behavior, commands, or proof outputs change

## Reporting Drain Regressions

If you are reporting a token-drain regression, provide:

- exact Claude Code workflow
- whether the session was fresh, resumed, continued, or reopened
- expected behavior versus actual behavior
- model or routing context if relevant
- commands, logs, or screenshots that make the failure reproducible

Use the dedicated issue template when possible so the report can be benchmarked rather than debated.

## Scope Guardrails

- Do not market hypothetical savings as measured results.
- Do not claim upstream Anthropic behavior is fixed when the project only detects or routes around it.
- Do not remove fail-open or degraded-state semantics without proving the replacement is safer.

## Style

- Prefer small, test-backed changes.
- Preserve ASCII unless the file already requires Unicode.
- Keep code comments sparse and useful.
- Keep operational claims tied to file-level evidence or cert output.
