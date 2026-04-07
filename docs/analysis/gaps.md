# Gaps

## Missing Entirely

### 1. No Direct Fix For Anthropic Prompt-Cache Bugs

Nothing in the code changes Anthropic's upstream prompt-cache behavior. `read-cache.py` is only a local file-read advisory cache, and `result-compressor.py` is a local context warning tool. Neither touches the platform cache invalidation bugs described in the March 2026 crisis (`src/hooks/infrastructure/read-cache.py:2-16`, `src/hooks/infrastructure/result-compressor.py:2-13`).

### 2. No Mitigation For Peak-Hour Throttling

The system can detect faster burn through cost summaries and anomaly alerts, but it cannot change Anthropic's session-limit policy or reserve capacity during congested hours. At best it can surface the damage faster (`src/scripts/core/cost_runtime.py:1237-1262`, `src/hooks/ops/ops_alerts.py:202-235`).

### 3. No Direct Remedy For File Line-Number Overhead

`read-efficiency-guard.py` reduces repeated reads, but there is no code that changes Claude Code's file-read formatting or strips line-number overhead from the payload once a read occurs (`src/hooks/guards/read-efficiency-guard.py:147-246`).

### 4. No Native Billing Or Usage API Integration

All meaningful cost visibility comes from local files and `ccusage`, not from an authoritative Anthropic API or platform meter. The system therefore estimates and infers a lot, but never reconciles against a first-party billing stream (`src/scripts/core/cost_runtime.py:544-563`, `src/scripts/core/cost_runtime.py:655-761`).

### 5. No Automated Remediation

The ops layer can log and deliver alerts, but it does not automatically tighten routing, downgrade models, disable spawns, or pause risky workflows when thresholds trip (`src/hooks/ops/ops_alerts.py:107-156`, `src/hooks/ops/ops_alerts.py:194-291`).

### 6. No Real Dashboard

The statusline is useful and the ops snapshot is rich, but there is no durable UI surface for live inspection beyond CLI output and generated markdown/json files (`src/scripts/core/cost_runtime.py:917-974`, `src/hooks/ops/ops_aggregator.py:276-320`).

### 7. No Solution For Third-Party Subscription Bans

The project contains coordinator and team-dispatch concepts, but nothing in the extracted code addresses Anthropic's April 4, 2026 third-party subscription restrictions or provides a sanctioned compatibility layer.

## Built But Incomplete

### 1. Budget Guard Exists But Is Not Live In The Snapshot

The code exists and is substantial, but the snapshot does not register it as a hook (`src/hooks/guards/budget-guard.py:3-24`, `config/settings-snapshot.json:185-249`).

### 2. Read Cache Exists But Is Dormant

`read-cache.py` exists as an advisory semantic cache, but the snapshot only wires `read-efficiency-guard.py` for `Read` (`src/hooks/infrastructure/read-cache.py:2-16`, `config/settings-snapshot.json:243-249`).

### 3. Result Compression Exists But Is Both Dormant And Broken

`result-compressor.py` is not wired, and if it were wired it would call helper functions absent from `hook_utils.py` (`src/hooks/infrastructure/result-compressor.py:56-60`, `src/hooks/infrastructure/result-compressor.py:95-108`, `src/hooks/infrastructure/hook_utils.py:40-165`).

### 4. Self-Heal And Session SLO Checks Exist But Are Dormant

Both scripts are substantial enough to matter, but the session-start snapshot does not include them (`src/hooks/infrastructure/self-heal.py:3-13`, `src/hooks/tracking/session-slo-check.py:2-16`, `config/settings-snapshot.json:300-325`).

### 5. Review Dispatch Has Producers Without Full Enforcement

`auto-review-dispatch.py` is live and `review-gate.py` exists, but the gate is not wired and the extracted project lacks the queue consumer script. The chain therefore exists more as an intent than a complete local product path (`src/hooks/infrastructure/auto-review-dispatch.py:2-10`, `src/hooks/guards/review-gate.py:2-13`).

### 6. Coordinator Cost Surface Is Advertised More Than Delivered

`index.js` contains legacy cost-tool deprecation metadata and a schema for `coord_cost_comparison`, but the missing `lib/` tree means the copied coordinator layer is not an executable cost-management package in this repository (`src/coordinator/index.js:117-171`, `src/coordinator/index.js:1047-1054`, `src/coordinator/index.js:1807-1808`).

### 7. Cost Attribution Is Only Partially Consumed

`cost-tagger.py` writes cost tags and the monthly report reads them, but `budget-guard.py` does not consume them despite the tagger's claim (`src/hooks/tracking/cost-tagger.py:6-18`, `src/scripts/reporting/token_mgmt_monthly_report.py:430-454`, `src/hooks/guards/budget-guard.py:61-161`).

### 8. Historical Data Is Present But Sampled

The extracted data copy includes session JSONL and weekly snapshots, but not daily or monthly sample files. That is enough to prove the analytics format, not enough to prove full historical completeness in the copied project (`data/sessions`, `data/weekly`).

## Notable Consequence

The project's main risk is not "nothing exists." A lot exists. The risk is that the implemented live system, the extracted repository, and the architectural narrative are three overlapping but non-identical things.
> Historical note: this document captures gap analysis from the pre-hardening snapshot. Several items here have since been closed by runtime rewiring, helper restoration, coordinator completion, schemas, and certification.
