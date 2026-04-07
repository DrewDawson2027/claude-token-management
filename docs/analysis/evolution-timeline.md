# Evolution Timeline

This timeline combines the handoff's historical narrative with what the April 7, 2026 code snapshot actually corroborates.

## February 2026: Agent Sprawl Crisis

Per the handoff brief, February 2026 was dominated by overuse of agents for work that should have been handled with direct tools, smaller scopes, or simpler escalation paths (`/Users/drewdawson/Desktop/token-management-handoff.md:763-774`).

What the current code corroborates:

- The present `token-guard.py` is explicitly designed around that failure mode. Its rules are about necessity, one-per-session types, cooldowns, session caps, and type-switch detection, all of which read like direct responses to earlier over-dispatch (`src/hooks/guards/token-guard.py:14-23`, `src/hooks/guards/token-guard.py:665-1065`).

## March 16, 2026: The Smoking Gun

The handoff identifies March 16, 2026 as the breaking point: a massively wasteful agent-spawn event during a task about optimizing token use itself (`/Users/drewdawson/Desktop/token-management-handoff.md:775-781`).

What the current code corroborates:

- The guard is no longer advisory in spirit. The file docstring and enforcement flow both describe hard blocking via exit code `2`, not a gentle suggestion layer (`src/hooks/guards/token-guard.py:10-22`, `src/hooks/guards/token-guard.py:1155-1224`).
- The read guard mirrors the same philosophy by blocking duplicate reads instead of merely logging them (`src/hooks/guards/read-efficiency-guard.py:11-18`, `src/hooks/guards/read-efficiency-guard.py:147-210`).

## March 27, 2026: Plugin Stack Optimization

The handoff records a separate optimization wave on March 27, 2026: dead MCP removal, archived skill cleanup, and lean-agent work intended to reduce always-on schema tax (`/Users/drewdawson/Desktop/token-management-handoff.md:783-789`).

What the current code corroborates:

- The coordinator server explicitly manages tool visibility by profile and calls out schema-tax concerns in comments. The `core | teams | ops | full` profile split exists to keep always-on tool count down (`src/coordinator/index.js:218-291`).
- `cost-comparison.js` is unusually disciplined about measured evidence, which fits the same optimization-and-proof mindset (`src/coordinator/cost-comparison.js:2-8`, `src/coordinator/cost-comparison.js:97-200`).

## April 2026: Current State

The handoff says that by April 2026 the system had real guards, routing, cost tracking, alerting, historical analytics, and coordinator cost tooling, while also acknowledging broken queue delivery and several incomplete pieces (`/Users/drewdawson/Desktop/token-management-handoff.md:791-815`).

What the code confirms:

- Working center of gravity:
  - `token-guard.py` is substantial and live on `Task` (`src/hooks/guards/token-guard.py:665-1123`, `config/settings-snapshot.json:185-195`).
  - `read-efficiency-guard.py` is live on `Read` (`config/settings-snapshot.json:243-249`).
  - The session telemetry path is live and coherent (`config/settings-snapshot.json:112-139`, `config/settings-snapshot.json:263-325`).
  - `cost_runtime.py` is the real local cost engine (`src/scripts/core/cost_runtime.py:655-761`, `src/scripts/core/cost_runtime.py:917-974`).

- Broken or incomplete pieces:
  - The queue producers exist, but the extracted project has no consumer shell script (`src/hooks/infrastructure/auto-review-dispatch.py:2-10`, `src/hooks/infrastructure/build-chain-dispatcher.py:2-9`, `src/hooks/infrastructure/chain-advance.py:2-9`).
  - Multiple advertised protections are not wired in the copied snapshot (`config/settings-snapshot.json:143-325`).
  - The coordinator layer is incomplete as copied because its dependency tree is missing (`src/coordinator/index.js:20-115`, `src/coordinator/team-dispatch.js:6-11`).

## Evolution Verdict

The timeline shows real learning, not random accretion. The project moved from uncontrolled agent usage toward explicit guardrails, measurement, and local ops views. The problem is that the implementation never fully converged after that learning phase. It still contains live protections, dormant experiments, partial refactors, and extraction gaps side by side.
