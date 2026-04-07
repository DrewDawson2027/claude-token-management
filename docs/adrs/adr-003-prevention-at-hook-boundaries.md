# ADR 003: Put Waste Prevention At Hook Boundaries

## Status

Accepted and validated by the strongest live code paths.

## Context

The project's most effective interventions are not reports or dashboards. They are hook-time blockers placed before costly actions occur: `token-guard.py` on `Task` and `read-efficiency-guard.py` on `Read` (`src/hooks/guards/token-guard.py:10-22`, `src/hooks/guards/read-efficiency-guard.py:10-18`).

## Decision

Use `PreToolUse` as the primary control point for waste prevention, and use post-hoc analytics mainly for visibility and trend detection.

## Why This Made Sense

- Blocking before spend is cheaper than explaining spend after the fact.
- The known crisis modes were often immediate: unnecessary agent dispatch, redundant reads, and avoidable model misuse.
- Claude Code already exposes hook events that make this practical.

## Consequences

### Positive

- The strongest live value in the system comes from these hook-time decisions.
- Guardrails can stop a failure before it multiplies through a session.

### Negative

- Hook correctness becomes critical.
- If the live hook graph drifts from the intended graph, the system looks more protected than it is.
- Dormant or unwired hooks create a false sense of coverage.

## Assessment

This is the right architectural instinct in the repository. The remaining work would be to make the hook graph truthful, complete, and authoritative.
