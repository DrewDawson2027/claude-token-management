# Token Management Migration Guide

## From Old Extracted Snapshot To Current Canonical Repo

The repository used to be an analysis-first extraction. It is now the canonical hardened artifact.

## What Changed

- Active settings were copied into `config/settings.json` and `config/settings.local.json`.
- Coordinator packaging was completed.
- Lead-tool wrapper scripts were added to the repo.
- The fresh-runtime harness now materializes a temporary installed runtime instead of validating the operator's home directory.
- Core record families now have schemas under `schemas/v1/`.
- CI now gates schema validation, fresh-runtime certification, and coordinator tests.

## If You Still Have Old Mental Models

Replace these assumptions:

- “The repo is only for analysis.” → False. It is now runnable and certifiable.
- “Several hooks are only aspirational.” → Outdated. Budget, review, cache, compression, routing reminder, self-heal, and session SLO checks are wired.
- “The coordinator extraction is incomplete.” → Outdated. Package metadata, tests, scripts, and lead wrappers are present.
- “The regression harness mostly checks `~/.claude`.” → Outdated. It materializes an isolated temporary runtime.
