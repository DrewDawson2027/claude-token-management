# ADR 002: Fail Open By Default

## Status

Accepted locally; high-risk for production.

## Context

The main configuration sets `failure_mode` to `fail_open`, and several session lifecycle scripts explicitly promise to exit successfully rather than block work when something goes wrong (`config/token-guard-config.json:9-18`, `src/hooks/tracking/session-summary.py:9-10`, `src/hooks/tracking/session-slo-check.py:10-16`, `src/hooks/infrastructure/self-heal.py:12-13`).

## Decision

Prefer availability over strict enforcement. If state is malformed, helpers are missing, or subprocesses fail, the system should usually allow the user's session to continue.

## Why This Made Sense

- A broken hook should not brick a real work session.
- The personal environment values continuity of work highly.
- Local scripts and file state are inherently more failure-prone than a centralized service.

## Consequences

### Positive

- The system is resilient to partial local breakage.
- Users are less likely to be blocked by a bad deploy or stale state file.

### Negative

- Protection can silently degrade.
- Missing helpers in dormant scripts may never be noticed until the script is finally activated.
- Trust in the enforcement story is lower because "configured" is not the same as "actually protected."

## Assessment

Fail-open is reasonable for local experimentation and dangerous for product claims. Anthropic would need more explicit degradation reporting, circuit breaking, and authoritative health surfacing before accepting this tradeoff.
