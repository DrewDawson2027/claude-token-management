# Release Process

## Pre-Release

1. Run schema validation.
2. Run fresh-runtime certification.
3. Run coordinator source-tree tests.
4. Run live hook tests.
5. Run live health-check.
6. Update docs if behavior or certification output changed.

## Versioning

- Python package version lives in `pyproject.toml` and `src/cli/claude_token_guard/__init__.py`.
- Do not release with version drift between those two files.

## Publish Checklist

- Repository is green locally.
- CI workflow is green.
- Docs describe the current, tested state rather than a historical extraction.
- Launch assets in `docs/release/` and `assets/social/` reflect the current certification numbers.
- Git history contains the full hardening change set.
- GitHub repo description and pinned profile entry reflect the current artifact.
