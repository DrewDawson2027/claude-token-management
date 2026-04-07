# Claude Token Management Rules

## Repository Role

This repository is the canonical hardened artifact for the token-management system. The live `~/.claude` runtime is the installed target. Changes here must either preserve parity with the live runtime or explicitly evolve both surfaces together.

## Working Rules

1. No feature claims without runnable code, settings registration, and test evidence.
2. New file-backed record formats must ship with a JSON schema under `schemas/v1/` and validation coverage in `tests/validate_schemas.py`.
3. New hooks must declare whether they are healthy, degraded, disabled, or broken. Silent fail-open behavior without observability is not acceptable.
4. Prefer repository-relative source resolution in new code. Do not add fresh hardcoded `~/.claude` dependencies unless the code is explicitly part of the installed runtime layer.
5. Keep the standalone repo and the installed runtime behavior aligned. Drift is a bug.
6. Do not reintroduce “exists in tree but not actually wired” components. Wire it, test it, or remove the claim.

## Certification Commands

```bash
python3 tests/validate_schemas.py
python3 tests/run_token_system_regression.py
PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/npm --prefix src/coordinator test
```

## Documentation Start Points

- `README.md`
- `docs/architecture/system-overview.md`
- `docs/TOKEN_MANAGEMENT_OPERATOR_PLAYBOOK.md`
- `docs/analysis/regression-results.md`
