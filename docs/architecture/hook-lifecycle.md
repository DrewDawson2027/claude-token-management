# Hook Lifecycle

This is the current active lifecycle represented by `config/settings.json`.

| Event | Matcher | Active handlers | Purpose |
|---|---|---|---|
| `SessionStart` | `*` | `self-heal.py`, `cost-tagger.py`, `session-slo-check.py`, `session-register.sh` | Runtime validation, cost/session tagging, startup SLO checks |
| `PreToolUse` | `*` | `check-inbox.sh`, `budget-guard.py` | Mandatory-action consumption and budget enforcement before tool use |
| `PreToolUse` | `Task` | `token-guard.py`, `model-router.py` | Dispatch gating and model policy enforcement |
| `PreToolUse` | `Write|Edit|MultiEdit` | `review-gate.py`, `credential-guard.py` | Review-chain enforcement and credential blocking |
| `PreToolUse` | `Bash` | `credential-guard.py`, `risky-command-guard.py` | Secret and destructive-shell controls |
| `PreToolUse` | `Read` | `read-efficiency-guard.py`, `read-cache.py` | Duplicate-read blocking and semantic read cache hints |
| `PostToolUse` | `Bash` | `auto-review-dispatch.py`, `session-tracker.py`, `result-compressor.py` | Review production, lifecycle tracking, context-bloat control |
| `PostToolUse` | `Read|Grep` | `session-tracker.py`, `result-compressor.py` | Read-result tracking and context-bloat control |
| `PostToolUse` | `Edit|Write|Glob|Task` | `session-tracker.py` | Tool-level session tracking |
| `SubagentStop` | none | `agent-metrics.py`, `build-chain-dispatcher.py`, `session-tracker.py` | Usage accounting, chain dispatch, hot-session updates |
| `Stop` | none | `session-summary.py` | Daily session summary writeout |
| `SessionEnd` | none | `session-end.sh` | End-of-session cleanup and runtime bookkeeping |
| `UserPromptSubmit` | none | `routing-reminder.py` | Prompt-time routing guidance refresh |

## Mandatory-Action Chain

The mandatory-action pipeline is live end to end.

- Producers: `auto-review-dispatch.py`, `build-chain-dispatcher.py`
- Consumer: `check-inbox.sh`
- Chain progression: `chain-advance.py`
- Completion marker: `done/<action-id>`
- Dead-letter and expiry handling are built into the consumer path

## Health Expectations

Each live-critical path is expected to resolve to one of four states:

- `healthy`
- `degraded`
- `disabled`
- `broken`

That distinction is enforced operationally through health-checks, self-heal, hook counters, and certification rather than left implicit.
