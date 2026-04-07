# Data Flow

## 1. Agent Dispatch Guard

1. `check-inbox.sh` and `budget-guard.py` run on every tool call.
2. `token-guard.py` evaluates necessity, session caps, type switching, concurrency, and policy rules on `Task`.
3. `model-router.py` enforces model policy for the proposed worker.
4. The decision is written into audit/session state and returned before the spawn happens.

Output:

- Allow/block response to Claude Code
- Audit decision record
- Session-state updates for allowed and blocked attempts

## 2. Cost and Session Tracking

1. `cost-tagger.py` initializes session cost state on `SessionStart`.
2. `session-tracker.py` keeps a hot per-session record across tool events.
3. `agent-metrics.py` writes usage and lifecycle records on `SubagentStop`.
4. `session-summary.py` finalizes the session into a daily JSONL summary on `Stop`.
5. `cost_runtime.py` aggregates local usage into cache, usage index, and statusline snapshots.

Output:

- Session summary JSONL rows
- Agent metrics JSONL
- Cost cache snapshot
- Usage index
- Statusline cache

## 3. Alerting and Ops Views

1. `ops_alerts.py` evaluates budget, anomaly, burn, and data-quality signals.
2. `ops_trends.py` scans local records into rolling cost windows.
3. `ops_aggregator.py` assembles the current ops snapshot.
4. `observability.py` and the CLI render operator views from those cached outputs.

Output:

- `alerts.jsonl`
- `alert-state.json`
- `ops-snapshot`
- Health and recap reports

## 4. Mandatory-Action and Review Chain

1. `auto-review-dispatch.py` and `build-chain-dispatcher.py` enqueue mandatory actions.
2. `check-inbox.sh` consumes those actions on future tool invocations.
3. The operator completes an action by touching the expected `done/` marker.
4. `chain-advance.py` moves chained work forward and dead-letters expired items.

Output:

- Mandatory-action queue entries
- Inbox prompts
- Done markers
- Chain state progression

## 5. Coordinator and Lead Tools

1. `src/coordinator/` handles worker creation, tasking, messaging, approvals, shutdown, and native bridge behaviors.
2. `src/lead-tools/` wraps the coordinator for shell-driven lead workflows.
3. Source-tree coordinator tests and the fresh-runtime spawn smoke validate the same launch contract.

Output:

- Worker result and metadata files
- Team/task JSON state
- Worker messaging inbox traffic
- Lead-tool shell entrypoints
