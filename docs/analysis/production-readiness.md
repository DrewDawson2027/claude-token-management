# Production Readiness

## Ship Verdict

Anthropic should not ship this system as-is.

The code contains multiple genuinely strong ideas: decision-time enforcement before spend, transcript-derived attribution, local cost caches, and a practical read-waste guard. But those ideas are embedded in a personal, file-backed, partially wired toolchain rather than a production system. The gaps are structural, not cosmetic (`src/hooks/guards/token-guard.py:10-22`, `src/hooks/tracking/agent-metrics.py:138-205`, `src/scripts/core/cost_runtime.py:655-761`, `config/settings-snapshot.json:143-325`).

## What Is Production-Candidate

### 1. Task-Spawn Guarding

The core principle in `token-guard.py` is sound: expensive agent spawns should be evaluated before they happen. Necessity checks, per-type caps, session caps, and cooldowns are all sensible product patterns (`src/hooks/guards/token-guard.py:665-1065`).

### 2. Redundant-Read Prevention

`read-efficiency-guard.py` is grounded in a real waste mode and enforces directly against it. The logic is legible, thresholded, and scoped to a concrete problem (`src/hooks/guards/read-efficiency-guard.py:147-246`).

### 3. Transcript-Derived Attribution

`agent-metrics.py` demonstrates a strong measurement approach: if the platform already has durable transcripts with usage metadata, derive cost attribution from that source of truth (`src/hooks/tracking/agent-metrics.py:138-205`).

### 4. Cached Local Cost Summaries

The cache/statusline/index pattern in `cost_runtime.py` is good product thinking: warm summaries for interaction, deeper historical stores for retrospectives (`src/scripts/core/cost_runtime.py:64-67`, `src/scripts/core/cost_runtime.py:655-761`, `src/scripts/core/cost_runtime.py:917-974`).

## What Blocks Shipping

### 1. Wiring Drift

A production system cannot have a directory of protections where many are dormant in the actual live graph. The snapshot shows clear divergence between what exists and what runs (`config/settings-snapshot.json:143-325`).

### 2. File-Backed State As The Primary Data Plane

JSON and JSONL files with local locks are pragmatic for a personal setup, but they are not a production data plane. Multi-process contention, schema drift, partial writes, disk pressure, and cross-device coordination become real problems at product scale (`src/hooks/infrastructure/hook_utils.py:17-128`, `src/scripts/core/cost_runtime.py:64-67`).

### 3. Incomplete Packaging

The extracted coordinator is missing its dependency tree, and most scripts are still rooted in `~/.claude`. Anthropic cannot ship a feature whose implementation boundary is "whatever happens to be in the operator's home directory" (`src/coordinator/index.js:20-115`, `src/hooks/ops/ops_sources.py:14-24`, `tests/run_token_system_regression.py:10-23`).

### 4. Broken Dormant Paths

Several dormant hooks would break if activated because shared helpers are missing. Production systems cannot depend on dead code staying dead (`src/hooks/infrastructure/result-compressor.py:56-60`, `src/hooks/infrastructure/result-compressor.py:95-108`, `src/hooks/infrastructure/hook_utils.py:40-165`).

### 5. Non-Authoritative Billing Inputs

The system mostly estimates cost from local transcripts and `ccusage`, which is useful but insufficient for production controls that would affect billing, throttling, or customer trust (`src/scripts/core/cost_runtime.py:544-761`).

## What Anthropic Would Need To Change

### 1. Replace The File Mesh With A Real Data Model

Anthropic would need an internal service or durable event stream for usage, policy decisions, alert state, and attribution. File locks and local JSON are not enough.

### 2. Make The Live Hook Graph The Single Source Of Truth

Product features need one authoritative registration model. If a protection exists in the repo, its activation state must be explicit and queryable, not inferred from scattered config and snapshot drift.

### 3. Use Platform Metering As The Authority

Budget enforcement, alerts, and reports would need to bind to authoritative platform usage data and rate-limit state, not only local reconstructions.

### 4. Collapse Duplicate Or Partial Implementations

`cost_runtime.py` vs `cost_data.py`, live vs dormant guards, and overlapping reporting surfaces all need consolidation before shipping (`src/scripts/core/cost_data.py:1-13`, `src/scripts/core/cost_runtime.py:173-343`).

### 5. Build True Contract Tests

A shippable version needs deterministic fixtures, hook contract tests, end-to-end lifecycle tests, and scale/chaos testing against malformed inputs and partial failure. The current regression harness is a useful smoke test, not a product-grade test suite (`tests/run_token_system_regression.py:48-152`).

### 6. Solve Privacy And Security Explicitly

Session transcripts, project paths, cost tags, and alert logs all encode sensitive metadata. Productionization would need retention policies, redaction, access control, and clear tenancy boundaries.

## Scale Concerns Missing Today

- Multi-user coordination beyond one personal `.claude` home directory.
- Concurrent writes from many active sessions and workers.
- Schema migration between versions of logs and cache documents.
- Cross-device syncing and recovery.
- Hard guarantees around once-only processing for queue-based workflows.

## Security Concerns Missing Today

- No obvious encryption or access control around cost and session logs.
- Queue files and cost tags live in predictable local paths.
- Home-directory path assumptions make sandboxing and tenancy isolation weak.

## Final Assessment

This is a strong local power-user system and a weak product candidate. Anthropic could absolutely mine it for ideas. Anthropic should not adopt its implementation shape.
