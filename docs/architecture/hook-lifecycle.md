# Hook Lifecycle

This map distinguishes between hooks that are actually wired in the copied settings snapshot and hooks that only claim a lifecycle in their own docstrings.

## Wired In The April 7 Snapshot

| Event | Matcher | Live commands | Notes |
| --- | --- | --- | --- |
| `Stop` | none | `session-summary.py` plus unrelated stop helpers | Token-management contribution is the final session analytics writer (`config/settings-snapshot.json:112-139`, `src/hooks/tracking/session-summary.py:2-10`). |
| `PostToolUse` | `Bash` | `auto-review-dispatch.py` | Review-chain producer is live; `result-compressor.py` is not (`config/settings-snapshot.json:154-160`, `src/hooks/infrastructure/auto-review-dispatch.py:2-10`). |
| `PreToolUse` | `Task` | `token-guard.py`, `model-router.py` | This is the real dispatch-control surface (`config/settings-snapshot.json:185-195`, `src/hooks/guards/token-guard.py:2-39`, `src/hooks/routing/model-router.py:44-83`). |
| `PreToolUse` | `Write|Edit|MultiEdit|Bash` | `credential-guard.py` | Cost-adjacent security enforcement (`config/settings-snapshot.json:226-233`, `src/hooks/guards/credential-guard.py:3-9`). |
| `PreToolUse` | `Bash` | `risky-command-guard.py` | Safety guard around destructive shell use (`config/settings-snapshot.json:235-241`, `src/hooks/guards/risky-command-guard.py:2-12`). |
| `PreToolUse` | `Read` | `read-efficiency-guard.py` | One of the few live anti-waste mechanisms (`config/settings-snapshot.json:243-249`, `src/hooks/guards/read-efficiency-guard.py:10-23`). |
| `SubagentStop` | none | `agent-metrics.py`, `build-chain-dispatcher.py`, `session-tracker.py` | Telemetry plus build-chain producer (`config/settings-snapshot.json:263-287`, `src/hooks/tracking/agent-metrics.py:2-8`, `src/hooks/infrastructure/build-chain-dispatcher.py:2-9`, `src/hooks/tracking/session-tracker.py:2-9`). |
| `SessionStart` | `*` | `cost-tagger.py` | Cost attribution is live; SLO/self-heal are not (`config/settings-snapshot.json:300-325`, `src/hooks/tracking/cost-tagger.py:2-18`). |

## Present But Not Wired In The Snapshot

| File | Claimed lifecycle | Why it matters |
| --- | --- | --- |
| `src/hooks/guards/budget-guard.py` | `PreToolUse` for every tool call | The handoff treats it as hot-path budget enforcement, but it is absent from the live snapshot (`src/hooks/guards/budget-guard.py:3-24`, `config/settings-snapshot.json:185-249`). |
| `src/hooks/guards/review-gate.py` | `PreToolUse` for write/edit tools | The mechanical enforcement companion to auto-review dispatch exists, but the snapshot does not register it (`src/hooks/guards/review-gate.py:2-13`, `config/settings-snapshot.json:185-249`). |
| `src/hooks/infrastructure/read-cache.py` | `PreToolUse` for `Read` | Advisory semantic cache is present, but the snapshot only wires `read-efficiency-guard.py` for `Read` (`src/hooks/infrastructure/read-cache.py:6-16`, `config/settings-snapshot.json:243-249`). |
| `src/hooks/infrastructure/result-compressor.py` | `PostToolUse` for `Bash`, `Read`, `Grep` | Context-bloat mitigation exists only as a dormant script (`src/hooks/infrastructure/result-compressor.py:2-13`, `config/settings-snapshot.json:143-183`). |
| `src/hooks/infrastructure/self-heal.py` | `SessionStart` | A substantial self-repair flow exists, but it is not part of the live `SessionStart` list (`src/hooks/infrastructure/self-heal.py:3-13`, `config/settings-snapshot.json:300-325`). |
| `src/hooks/tracking/session-slo-check.py` | `SessionStart` | SLO warnings are implemented but not live (`src/hooks/tracking/session-slo-check.py:2-16`, `config/settings-snapshot.json:300-325`). |
| `src/hooks/routing/routing-reminder.py` | `UserPromptSubmit` | No `UserPromptSubmit` hook section exists in the copied snapshot (`src/hooks/routing/routing-reminder.py:2-14`, `config/settings-snapshot.json:1-325`). |
| `src/hooks/ops/*.py` | CLI/manual ops workflows | The code is substantial, but none of the ops scripts are wired into the copied hook graph (`config/settings-snapshot.json:143-325`). |

## Lifecycle Notes By Subsystem

### Guards

- Decision-time enforcement is concentrated in `PreToolUse`, which is the right place to prevent waste before it is spent (`src/hooks/guards/token-guard.py:10-22`, `src/hooks/guards/read-efficiency-guard.py:10-18`).
- The live guard stack is narrower than the directory suggests. The active snapshot only enforces agent-spawn, model allowlisting, read repetition, credentials, and risky shell operations (`config/settings-snapshot.json:185-249`).

### Tracking

- Tracking has the cleanest lifecycle design in the project: start-time tagging, stop-time agent/session recording, and terminal session summarization (`src/hooks/tracking/cost-tagger.py:6-18`, `src/hooks/tracking/agent-metrics.py:2-8`, `src/hooks/tracking/session-summary.py:2-10`).
- `token-analytics.py` is not a hook at all; it is a CLI/reporting surface over the accumulated data (`src/hooks/tracking/token-analytics.py:2-24`).

### Infrastructure and Queueing

- `auto-review-dispatch.py` and `build-chain-dispatcher.py` are live producers, but `review-gate.py` is not live, so the review-chain story is only partially enforced (`src/hooks/infrastructure/auto-review-dispatch.py:4-12`, `src/hooks/infrastructure/build-chain-dispatcher.py:4-16`, `src/hooks/guards/review-gate.py:4-13`).
- `pre-compact-context.py` is a helper invoked by shell infrastructure rather than directly by the settings snapshot (`src/hooks/infrastructure/pre-compact-context.py:3-10`, `config/settings-snapshot.json:289-297`).

## Lifecycle Verdict

The live hook model is strongest where it intercepts expensive behavior before execution and where it captures telemetry after durable lifecycle boundaries. The system loses coherence wherever the snapshot, the file inventory, and the docstrings disagree. That disagreement is not cosmetic; it changes which protections actually exist during a real session.
