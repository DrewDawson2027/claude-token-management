#!/usr/bin/env python3
"""
Token Management Monthly Report — Executive Summary & Letter Grade
Assesses the entire token management system performance against world-class standards.

Metrics tracked:
1. Read efficiency guard effectiveness
2. Agent spawn control effectiveness
3. Budget adherence
4. Token savings realized
5. System adoption & compliance

Grading rubric (inspired by AWS Well-Architected, Google SRE, and FinOps best practices):
A+: >95% efficiency, <80% budget used, zero critical overruns, proactive optimization
A:  90-95% efficiency, 80-90% budget used, excellent guard adoption
B:  80-90% efficiency, 90-100% budget used, good guard adoption
C:  70-80% efficiency, 100-110% budget used, moderate guard adoption
D:  60-70% efficiency, 110-120% budget used, poor guard adoption
F:  <60% efficiency, >120% budget used, guards bypassed

Usage:
  python3 token_mgmt_monthly_report.py [--month YYYY-MM] [--format text|json|markdown]
"""

import json
import glob
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import argparse

# ============================================================================
# CONFIGURATION
# ============================================================================

STATE_DIR = Path.home() / ".claude" / "hooks" / "session-state"
COST_DIR = Path.home() / ".claude" / "cost"
REPORTS_DIR = Path.home() / ".claude" / "reports"
TOKEN_GUARD_CONFIG = Path.home() / ".claude" / "hooks" / "token-guard-config.json"

# Grading thresholds (world-class standards)
GRADE_THRESHOLDS = {
    "A+": {
        "efficiency": 95,
        "budget_pct": 80,
        "guard_adoption": 90,
        "savings_rate": 30,
    },
    "A": {"efficiency": 90, "budget_pct": 90, "guard_adoption": 85, "savings_rate": 25},
    "B": {
        "efficiency": 80,
        "budget_pct": 100,
        "guard_adoption": 75,
        "savings_rate": 20,
    },
    "C": {
        "efficiency": 70,
        "budget_pct": 110,
        "guard_adoption": 60,
        "savings_rate": 15,
    },
    "D": {
        "efficiency": 60,
        "budget_pct": 120,
        "guard_adoption": 50,
        "savings_rate": 10,
    },
}

# Token economics (per sequential read prevented)
AVG_CONTEXT_GROWTH_PER_READ = 700  # tokens (context accumulation)
AVG_READS_PREVENTED_PER_BLOCK = 5  # conservative estimate
SONNET_INPUT_PRICE_PER_1M = 3.0  # USD

# ============================================================================
# DATA COLLECTION
# ============================================================================


def collect_read_guard_metrics(start_date: datetime, end_date: datetime) -> Dict:
    """Collect read-efficiency-guard metrics.

    Primary source: *-reads.json session state files (per-session attempt logs).
    Fallback source: audit.jsonl block events with pattern='read_file' (blocks only).
    """
    metrics = {
        "total_read_attempts": 0,
        "total_blocks": 0,
        "duplicate_blocks": 0,
        "sequential_blocks": 0,
        "sessions_affected": 0,
        "heaviest_session": {"session": None, "blocks": 0},
    }

    for state_file in STATE_DIR.glob("*-reads.json"):
        try:
            mtime = datetime.fromtimestamp(state_file.stat().st_mtime)
            if not (start_date <= mtime <= end_date):
                continue

            with open(state_file) as f:
                data = json.load(f)

            reads = data.get("reads", [])
            if not reads:
                continue

            blocks = [r for r in reads if r.get("blocked")]
            if blocks:
                metrics["sessions_affected"] += 1

            metrics["total_read_attempts"] += len(reads)
            metrics["total_blocks"] += len(blocks)

            if len(blocks) > metrics["heaviest_session"]["blocks"]:
                metrics["heaviest_session"] = {
                    "session": data.get("session_key", "unknown")[:12],
                    "blocks": len(blocks),
                }
        except (json.JSONDecodeError, OSError):
            continue

    # Fallback: pull read-guard blocks from audit.jsonl when no *-reads.json files exist
    # audit.jsonl logs blocks (not allows), so only update total_blocks here.
    if metrics["total_read_attempts"] == 0:
        audit_file = STATE_DIR / "audit.jsonl"
        if audit_file.exists():
            session_blocks: Dict[str, int] = {}
            try:
                for line in audit_file.read_text(
                    encoding="utf-8", errors="replace"
                ).splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("event") != "block":
                        continue
                    if (
                        entry.get("pattern") != "read_file"
                        and entry.get("reason_code") != "necessity_check"
                    ):
                        continue
                    ts_str = entry.get("ts", "")
                    try:
                        ts = datetime.fromisoformat(
                            ts_str.replace("Z", "+00:00")
                        ).replace(tzinfo=None)
                        if not (start_date <= ts <= end_date):
                            continue
                    except Exception:
                        pass  # include if timestamp unparseable
                    metrics["total_blocks"] += 1
                    sk = entry.get("session_key", entry.get("session", "unknown"))
                    session_blocks[sk] = session_blocks.get(sk, 0) + 1
            except OSError:
                pass

            if session_blocks:
                metrics["sessions_affected"] = len(session_blocks)
                heaviest_sk = max(session_blocks, key=session_blocks.get)
                metrics["heaviest_session"] = {
                    "session": heaviest_sk[:12],
                    "blocks": session_blocks[heaviest_sk],
                }

    # Estimate tokens saved
    reads_prevented = metrics["total_blocks"] * AVG_READS_PREVENTED_PER_BLOCK
    tokens_per_prevented = AVG_CONTEXT_GROWTH_PER_READ
    metrics["estimated_tokens_saved"] = reads_prevented * tokens_per_prevented
    metrics["estimated_cost_saved"] = (
        metrics["estimated_tokens_saved"] / 1_000_000 * SONNET_INPUT_PRICE_PER_1M
    )

    return metrics


def collect_agent_guard_metrics(start_date: datetime, end_date: datetime) -> Dict:
    """Collect token-guard agent spawning metrics from audit.jsonl and agent-metrics.jsonl.

    Reads the same sources as token-analytics.py cmd_agents:
      - audit.jsonl   → block events (allows + blocks for total attempts)
      - agent-metrics.jsonl → completed agent events (additional attempt count)
    """
    metrics = {
        "total_agent_attempts": 0,
        "total_blocks": 0,
        "parallel_violations": 0,
        "duplicate_type_violations": 0,
        "budget_blocks": 0,
    }

    # Count completed agents from agent-metrics.jsonl
    metrics_file = STATE_DIR / "agent-metrics.jsonl"
    if metrics_file.exists():
        try:
            with open(metrics_file) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("event") != "agent_completed":
                        continue
                    ts_str = entry.get("ts", "")
                    try:
                        ts = datetime.fromisoformat(
                            ts_str.replace("Z", "+00:00")
                        ).replace(tzinfo=None)
                        if start_date <= ts <= end_date:
                            metrics["total_agent_attempts"] += 1
                    except (ValueError, AttributeError):
                        continue
        except (OSError, PermissionError):
            pass

    # Count block events from audit.jsonl (each block is also an attempt)
    audit_file = STATE_DIR / "audit.jsonl"
    if audit_file.exists():
        try:
            with open(audit_file) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("event") != "block":
                        continue
                    ts_str = entry.get("ts", "")
                    try:
                        ts = datetime.fromisoformat(
                            ts_str.replace("Z", "+00:00")
                        ).replace(tzinfo=None)
                        if not (start_date <= ts <= end_date):
                            continue
                    except (ValueError, AttributeError):
                        continue
                    metrics["total_blocks"] += 1
                    metrics["total_agent_attempts"] += 1  # blocks are also attempts
                    reason = (
                        entry.get("reason_code") or entry.get("reason") or ""
                    ).lower()
                    if "parallel" in reason:
                        metrics["parallel_violations"] += 1
                    elif "duplicate" in reason or "max_per_type" in reason:
                        metrics["duplicate_type_violations"] += 1
                    elif "budget" in reason or "session_cap" in reason:
                        metrics["budget_blocks"] += 1
        except (OSError, PermissionError):
            pass

    return metrics


def collect_agent_budget_adherence(start_date: datetime, end_date: datetime) -> Dict:
    """Collect per-agent-type budget adherence from agent-metrics.jsonl."""
    metrics = {
        "total_agents_tracked": 0,
        "agents_within_budget": 0,
        "agents_hit_cap": 0,
        "adherence_pct": 100.0,
        "by_type": {},
    }

    metrics_file = STATE_DIR / "agent-metrics.jsonl"
    if not metrics_file.exists():
        return metrics

    try:
        with open(metrics_file) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if entry.get("event") != "agent_completed":
                    continue

                ts_str = entry.get("ts", "")
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).replace(
                        tzinfo=None
                    )
                    if not (start_date <= ts <= end_date):
                        continue
                except (ValueError, AttributeError):
                    continue

                budget = entry.get("budget", {})
                if not budget:
                    continue

                agent_type = entry.get("agent_type", "unknown")
                metrics["total_agents_tracked"] += 1

                if budget.get("hit_cap"):
                    metrics["agents_hit_cap"] += 1
                else:
                    metrics["agents_within_budget"] += 1

                # Track by type
                if agent_type not in metrics["by_type"]:
                    metrics["by_type"][agent_type] = {
                        "total": 0,
                        "hit_cap": 0,
                        "avg_utilization": 0,
                        "utilizations": [],
                    }
                metrics["by_type"][agent_type]["total"] += 1
                if budget.get("hit_cap"):
                    metrics["by_type"][agent_type]["hit_cap"] += 1
                util = budget.get("budget_utilization_pct", 0)
                metrics["by_type"][agent_type]["utilizations"].append(util)

    except (OSError, PermissionError):
        pass

    if metrics["total_agents_tracked"] > 0:
        metrics["adherence_pct"] = round(
            (metrics["agents_within_budget"] / metrics["total_agents_tracked"]) * 100, 1
        )

    # Calculate averages
    for type_data in metrics["by_type"].values():
        utils = type_data.pop("utilizations", [])
        type_data["avg_utilization"] = round(sum(utils) / len(utils), 1) if utils else 0

    return metrics


def collect_model_distribution(start_date: datetime, end_date: datetime) -> Dict:
    """Collect model usage distribution from agent-metrics.jsonl."""
    dist: Dict[str, int] = {"haiku": 0, "sonnet": 0, "opus": 0, "unknown": 0}
    total = 0

    metrics_file = STATE_DIR / "agent-metrics.jsonl"
    if not metrics_file.exists():
        return {"total": 0, "distribution": dist, "pct": {}}

    try:
        with open(metrics_file) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("event") != "agent_completed":
                    continue
                ts_str = entry.get("ts", "")
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).replace(
                        tzinfo=None
                    )
                    if not (start_date <= ts <= end_date):
                        continue
                except (ValueError, AttributeError):
                    continue

                model = entry.get("model_used", "sonnet").lower()
                if "haiku" in model:
                    dist["haiku"] += 1
                elif "opus" in model:
                    dist["opus"] += 1
                elif "sonnet" in model:
                    dist["sonnet"] += 1
                else:
                    dist["unknown"] += 1
                total += 1
    except (OSError, PermissionError):
        pass

    pct = {}
    for k, v in dist.items():
        pct[k] = round((v / total) * 100, 1) if total > 0 else 0.0

    return {"total": total, "distribution": dist, "pct": pct}


def collect_context_growth_metrics() -> Dict:
    """Collect context growth data from session-state context tracking files."""
    state_dir = Path(os.path.expanduser("~/.claude/hooks/session-state"))
    metrics = {
        "sessions_tracked": 0,
        "total_large_results": 0,
        "avg_context_chars": 0,
        "max_context_chars": 0,
    }
    if not state_dir.exists():
        return metrics

    context_files = list(state_dir.glob("*-context.json"))
    total_chars = 0
    for cf in context_files:
        try:
            with open(cf) as f:
                state = json.load(f)
            metrics["sessions_tracked"] += 1
            chars = state.get("total_chars", 0)
            total_chars += chars
            metrics["total_large_results"] += state.get("large_results", 0)
            if chars > metrics["max_context_chars"]:
                metrics["max_context_chars"] = chars
        except (json.JSONDecodeError, OSError):
            continue

    if metrics["sessions_tracked"] > 0:
        metrics["avg_context_chars"] = round(total_chars / metrics["sessions_tracked"])

    return metrics


def collect_cost_attribution() -> Dict:
    """Collect cost attribution data from session cost-tag files."""
    state_dir = Path(os.path.expanduser("~/.claude/hooks/session-state"))
    tags: Dict[str, int] = {}
    total_sessions = 0

    if not state_dir.exists():
        return {"total_sessions": 0, "by_tag": {}, "pct": {}}

    for tag_file in state_dir.glob("*-cost-tag.json"):
        try:
            with open(tag_file) as f:
                state = json.load(f)
            tag = state.get("cost_tag", "unknown")
            tags[tag] = tags.get(tag, 0) + 1
            total_sessions += 1
        except (json.JSONDecodeError, OSError):
            continue

    pct = {}
    for k, v in tags.items():
        pct[k] = round((v / total_sessions) * 100, 1) if total_sessions > 0 else 0.0

    return {"total_sessions": total_sessions, "by_tag": tags, "pct": pct}


def collect_prompt_caching_metrics() -> Dict:
    """Collect prompt caching metadata from config."""
    config_path = os.path.expanduser("~/.claude/hooks/token-guard-config.json")
    try:
        with open(config_path) as f:
            config = json.load(f)
        pc = config.get("prompt_caching", {})
        total = pc.get("claude_md_total_lines", 0)
        static = pc.get("claude_md_static_lines", 0)
        cacheability = round((static / total) * 100, 1) if total > 0 else 0
        return {
            "total_lines": total,
            "static_lines": static,
            "cacheability_pct": cacheability,
        }
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"total_lines": 0, "static_lines": 0, "cacheability_pct": 0}


def collect_budget_metrics(start_date: datetime, end_date: datetime) -> Dict:
    """Collect cost and budget adherence metrics."""
    metrics = {
        "monthly_budget_usd": 200.0,
        "actual_spend_usd": 0.0,
        "budget_pct_used": 0.0,
        "over_budget": False,
    }

    # Load budget config
    try:
        with open(TOKEN_GUARD_CONFIG) as f:
            config = json.load(f)
            metrics["monthly_budget_usd"] = config.get("budget_guard", {}).get(
                "monthly_usd", 200.0
            )
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # Load usage index (approximation - real spend tracking would use claude API billing)
    usage_file = COST_DIR / "usage-index.json"
    if usage_file.exists():
        try:
            with open(usage_file) as f:
                usage = json.load(f)

            # Filter to date range and sum costs
            for session_data in usage.get("sessions", {}).values():
                session_date = datetime.fromisoformat(session_data.get("date", ""))
                if start_date <= session_date <= end_date:
                    metrics["actual_spend_usd"] += session_data.get("cost_usd", 0.0)
        except (json.JSONDecodeError, OSError, ValueError):
            pass

    if metrics["monthly_budget_usd"] > 0:
        metrics["budget_pct_used"] = (
            metrics["actual_spend_usd"] / metrics["monthly_budget_usd"]
        ) * 100
        metrics["over_budget"] = metrics["budget_pct_used"] > 100

    return metrics


# ============================================================================
# GRADING & ASSESSMENT
# ============================================================================


def calculate_efficiency_score(read_metrics: Dict, agent_metrics: Dict) -> float:
    """Calculate overall efficiency score (0-100)."""
    # Component 1: Read guard effectiveness (40%)
    read_effectiveness = 0
    if read_metrics["total_read_attempts"] > read_metrics["total_blocks"]:
        # Full attempt data available — compute real block rate
        block_rate = read_metrics["total_blocks"] / read_metrics["total_read_attempts"]
        # Optimal block rate is 10-20% (catching real waste without false positives)
        if 0.10 <= block_rate <= 0.20:
            read_effectiveness = 100
        elif block_rate < 0.10:
            read_effectiveness = block_rate * 1000  # Scale up low rates
        else:
            read_effectiveness = max(
                0, 100 - (block_rate - 0.20) * 200
            )  # Penalize too many blocks
    elif read_metrics["total_blocks"] > 0:
        # Blocks logged (from audit.jsonl) but allow-tracking not available.
        # Guard is firing and catching unnecessary reads — score as neutral-good.
        read_effectiveness = 75  # B: guard active, exact rate unknown

    # Component 2: Agent guard effectiveness (40%)
    agent_effectiveness = 100  # Start at 100, penalize violations
    if agent_metrics["total_agent_attempts"] > 0:
        violation_rate = (
            agent_metrics["total_blocks"] / agent_metrics["total_agent_attempts"]
        )
        # Low violation rate is good (guards working, users complying)
        if violation_rate > 0.15:
            agent_effectiveness = max(0, 100 - (violation_rate * 300))

    # Component 3: Token savings rate (20%)
    savings_score = 0
    if read_metrics["estimated_tokens_saved"] > 100000:  # At least 100k saved
        savings_score = min(
            100, (read_metrics["estimated_tokens_saved"] / 1_000_000) * 50
        )

    return (
        (read_effectiveness * 0.4) + (agent_effectiveness * 0.4) + (savings_score * 0.2)
    )


def calculate_guard_adoption(read_metrics: Dict, agent_metrics: Dict) -> float:
    """Calculate guard adoption/compliance rate (0-100)."""
    total_attempts = (
        read_metrics["total_read_attempts"] + agent_metrics["total_agent_attempts"]
    )
    total_blocks = read_metrics["total_blocks"] + agent_metrics["total_blocks"]

    if total_attempts == 0:
        return 100  # No attempts = perfect compliance (or no usage)

    # Inverse of block rate = adoption rate (fewer blocks = better adoption)
    block_rate = total_blocks / total_attempts
    return max(0, 100 - (block_rate * 500))  # Scale block rate to 0-100


def calculate_savings_rate(read_metrics: Dict, budget_metrics: Dict) -> float:
    """Calculate token savings as % of budget."""
    if budget_metrics["actual_spend_usd"] == 0:
        return 0

    savings_usd = read_metrics["estimated_cost_saved"]
    # Savings rate = (saved / (saved + spent)) * 100
    return (savings_usd / (savings_usd + budget_metrics["actual_spend_usd"])) * 100


def assign_letter_grade(
    efficiency: float, budget_pct: float, adoption: float, savings_rate: float
) -> Tuple[str, str]:
    """Assign letter grade and detailed explanation."""
    # Check A+ first (highest bar)
    if (
        efficiency >= GRADE_THRESHOLDS["A+"]["efficiency"]
        and budget_pct <= GRADE_THRESHOLDS["A+"]["budget_pct"]
        and adoption >= GRADE_THRESHOLDS["A+"]["guard_adoption"]
        and savings_rate >= GRADE_THRESHOLDS["A+"]["savings_rate"]
    ):
        return "A+", "World-class token management. Top 1% performance."

    # Check A
    if (
        efficiency >= GRADE_THRESHOLDS["A"]["efficiency"]
        and budget_pct <= GRADE_THRESHOLDS["A"]["budget_pct"]
        and adoption >= GRADE_THRESHOLDS["A"]["guard_adoption"]
    ):
        return "A", "Excellent token management. Strong optimization culture."

    # Check B
    if (
        efficiency >= GRADE_THRESHOLDS["B"]["efficiency"]
        and budget_pct <= GRADE_THRESHOLDS["B"]["budget_pct"]
    ):
        return "B", "Good token management. Room for improvement in optimization."

    # Check C
    if (
        efficiency >= GRADE_THRESHOLDS["C"]["efficiency"]
        and budget_pct <= GRADE_THRESHOLDS["C"]["budget_pct"]
    ):
        return "C", "Adequate token management. Significant optimization opportunities."

    # Check D
    if (
        efficiency >= GRADE_THRESHOLDS["D"]["efficiency"]
        and budget_pct <= GRADE_THRESHOLDS["D"]["budget_pct"]
    ):
        return "D", "Poor token management. Urgent action needed."

    return "F", "Failing token management. System overhaul required."


# ============================================================================
# STRATEGIC RECOMMENDATIONS (2026 AI Landscape)
# ============================================================================


def generate_recommendations(
    grade: str,
    read_metrics: Dict,
    agent_metrics: Dict,
    budget_metrics: Dict,
    efficiency: float,
    adoption: float,
) -> List[str]:
    """Generate strategic recommendations based on 2026 AI landscape and current performance."""
    recommendations = []

    # === CREATIVE IDEAS: 2026 AI LANDSCAPE ===

    # 1. Prompt Caching (Feb 2026 - now standard)
    if efficiency < 90:
        recommendations.append(
            "💡 PROMPT CACHING: Anthropic's prompt caching (May 2024+) can reduce costs by 90% "
            "for repeated context. Enable for: CLAUDE.md, project READMEs, tool schemas. "
            "Integration: Add cache_control breakpoints to system prompts."
        )

    # 2. Model routing intelligence (2026 trend)
    if budget_metrics["budget_pct_used"] > 85:
        recommendations.append(
            "🎯 MODEL ROUTING: Route simple tasks to Haiku (20x cheaper than Sonnet). "
            "2026 best practice: Intelligent task classification → model selection. "
            "Integration: Add task complexity scorer in token-guard.py pre-hook."
        )

    # 3. Batch API (Anthropic Feb 2026)
    if read_metrics["total_blocks"] > 5:
        recommendations.append(
            "📦 BATCH API: Anthropic Batch API (50% cost reduction for async work). "
            "Use for: non-interactive research, bulk file processing, overnight reports. "
            "Integration: Create batch queue in mcp-coordinator for low-priority tasks."
        )

    # 4. Extended Thinking (Dec 2024+)
    if efficiency < 85:
        recommendations.append(
            "🧠 EXTENDED THINKING: Enable extended thinking for complex tasks (1-60s reasoning). "
            "Reduces retry loops by 40%. Trade-off: Higher latency, lower total cost. "
            "Integration: Auto-enable for debugging, architecture decisions, security reviews."
        )

    # 5. Tool use optimization (2026 patterns)
    if agent_metrics["total_blocks"] > 3:
        recommendations.append(
            "🔧 TOOL USE OPTIMIZATION: Reduce tool call overhead with: "
            "(a) Tool result streaming (reduces context per turn by 30%), "
            "(b) Composite tools (combine related ops), "
            "(c) Tool result summarization (compress large outputs). "
            "Integration: Add result compression in mcp-coordinator."
        )

    # 6. Agentic loop budgets (2026 safety pattern)
    if agent_metrics["total_agent_attempts"] > 20:
        recommendations.append(
            "🎛️ AGENTIC LOOP BUDGETS: Set per-agent token budgets (Google Vertex AI pattern). "
            "Prevent runaway loops. Example: Research agents max 50k, code agents max 100k. "
            "Integration: Add agent_budget field to token-guard-config.json."
        )

    # 7. Semantic caching (2026 innovation)
    if read_metrics["total_read_attempts"] > 50:
        recommendations.append(
            "🧬 SEMANTIC CACHING: Cache similar (not just identical) requests using embeddings. "
            "Tools: Redis + vector store, or Anthropic's upcoming semantic cache (rumored Q1 2026). "
            "Integration: Add embedding layer in mcp-coordinator for read results."
        )

    # 8. Cost attribution & chargeback (FinOps 2026)
    if budget_metrics["actual_spend_usd"] > 100:
        recommendations.append(
            "💰 COST ATTRIBUTION: Tag sessions with cost centers (personal, work, research). "
            "2026 FinOps best practice: Per-project cost tracking + monthly chargeback. "
            "Integration: Add --tag flag to claude CLI, surface in monthly reports."
        )

    # === PERFORMANCE-SPECIFIC RECOMMENDATIONS ===

    # High block rate (too aggressive)
    if (
        read_metrics["total_blocks"] / max(read_metrics["total_read_attempts"], 1)
        > 0.30
    ):
        recommendations.append(
            "⚠️ GUARD TOO AGGRESSIVE: 30%+ read block rate suggests false positives. "
            "Consider: Raise ESCALATION_THRESHOLD from 15 to 20 in read-efficiency-guard.py. "
            "2026 approach: Adaptive thresholds based on task complexity (use LLM to classify)."
        )

    # Low savings despite guards
    savings_rate = calculate_savings_rate(read_metrics, budget_metrics)
    if savings_rate < 15 and read_metrics["total_blocks"] > 5:
        recommendations.append(
            "📉 LOW SAVINGS REALIZATION: Guards blocking but savings not materializing. "
            "Root cause: Users retrying instead of batching. Solution: Better UX feedback. "
            "Integration: Add --suggest-batch flag to claude CLI that shows parallelizable reads."
        )

    # Budget overrun risk
    if 95 <= budget_metrics["budget_pct_used"] < 100:
        recommendations.append(
            "🚨 BUDGET RISK: At 95%+ of monthly budget. Enable emergency measures: "
            "(1) Auto-switch to Haiku for non-critical tasks, "
            "(2) Defer batch jobs to off-peak, "
            "(3) Enable aggressive prompt caching. "
            "2026 pattern: Auto-scaling cost controls (AWS-style reserved capacity)."
        )

    # Grade-specific guidance
    if grade in ["D", "F"]:
        recommendations.insert(
            0,
            "🔴 URGENT: System intervention required. Schedule token management audit. "
            "Immediate actions: (1) Review top 5 spend sessions, (2) Enable all guards, "
            "(3) Set daily budget caps, (4) Migrate simple tasks to Haiku.",
        )
    elif grade == "A+":
        recommendations.insert(
            0,
            "🏆 WORLD-CLASS PERFORMANCE! Consider: Publishing your config as open source, "
            "or offering token management consulting. 2026 opportunity: AI cost optimization SaaS.",
        )

    return recommendations


# ============================================================================
# REPORT GENERATION
# ============================================================================


def format_report_text(
    report_month: str,
    read_metrics: Dict,
    agent_metrics: Dict,
    budget_metrics: Dict,
    grade: str,
    grade_reason: str,
    scores: Dict,
    recommendations: List[str],
    agent_budget_metrics: Optional[Dict] = None,
    model_distribution: Optional[Dict] = None,
    context_growth: Optional[Dict] = None,
    cost_attribution: Optional[Dict] = None,
    prompt_caching: Optional[Dict] = None,
) -> str:
    """Format report as human-readable text."""
    lines = [
        "=" * 80,
        f"TOKEN MANAGEMENT MONTHLY REPORT — {report_month}".center(80),
        "=" * 80,
        "",
        f"📊 OVERALL GRADE: {grade} — {grade_reason}",
        "",
        "─" * 80,
        "PERFORMANCE METRICS",
        "─" * 80,
        "",
        "Read Efficiency Guard:",
        f"  • Total read attempts: {read_metrics['total_read_attempts']:,}",
        f"  • Blocks: {read_metrics['total_blocks']}"
        + (
            f" ({read_metrics['total_blocks']/read_metrics['total_read_attempts']*100:.1f}% block rate)"
            if read_metrics["total_read_attempts"] > read_metrics["total_blocks"]
            else " (audit.jsonl blocks only — allow-rate not tracked)"
        ),
        f"  • Sessions affected: {read_metrics['sessions_affected']}",
        f"  • Heaviest session: {read_metrics['heaviest_session']['session']} ({read_metrics['heaviest_session']['blocks']} blocks)",
        f"  • Estimated tokens saved: {read_metrics['estimated_tokens_saved']:,}",
        f"  • Estimated cost saved: ${read_metrics['estimated_cost_saved']:.2f}",
        "",
        "Agent Spawn Guard:",
        f"  • Total agent attempts: {agent_metrics['total_agent_attempts']}",
        f"  • Blocks: {agent_metrics['total_blocks']}",
        f"  • Parallel violations: {agent_metrics['parallel_violations']}",
        f"  • Duplicate type violations: {agent_metrics['duplicate_type_violations']}",
        "",
    ]

    # Agent budget adherence section
    abm = agent_budget_metrics or {}
    if abm.get("total_agents_tracked", 0) > 0:
        lines.extend(
            [
                "Agent Budget Adherence:",
                f"  • Agents tracked: {abm['total_agents_tracked']}",
                f"  • Within budget: {abm['agents_within_budget']} ({abm['adherence_pct']:.1f}%)",
                f"  • Hit turn cap: {abm['agents_hit_cap']}",
            ]
        )
        for atype, adata in abm.get("by_type", {}).items():
            lines.append(
                f"  • {atype}: {adata['total']} runs, avg {adata['avg_utilization']:.0f}% utilization, {adata['hit_cap']} capped"
            )
        lines.append("")
    else:
        lines.extend(
            [
                "Agent Budget Adherence:",
                "  • No budget data yet (data collection started)",
                "",
            ]
        )

    # Model distribution section
    md = model_distribution or {}
    if md.get("total", 0) > 0:
        pct = md.get("pct", {})
        dist = md.get("distribution", {})
        lines.extend(
            [
                "Model Distribution:",
                f"  • Total agent spawns: {md['total']}",
                f"  • Haiku:  {dist.get('haiku', 0)} ({pct.get('haiku', 0):.1f}%)",
                f"  • Sonnet: {dist.get('sonnet', 0)} ({pct.get('sonnet', 0):.1f}%)",
                f"  • Opus:   {dist.get('opus', 0)} ({pct.get('opus', 0):.1f}%)",
                "",
            ]
        )
    else:
        lines.extend(
            [
                "Model Distribution:",
                "  • No model data yet (tracking started)",
                "",
            ]
        )

    # Context growth section
    cg = context_growth or {}
    if cg.get("sessions_tracked", 0) > 0:
        avg_tokens = cg.get("avg_context_chars", 0) // 4
        max_tokens = cg.get("max_context_chars", 0) // 4
        lines.extend(
            [
                "Context Growth:",
                f"  • Sessions tracked: {cg['sessions_tracked']}",
                f"  • Large results (>5k chars): {cg.get('total_large_results', 0)}",
                f"  • Avg context per session: ~{avg_tokens:,} tokens",
                f"  • Max context in session: ~{max_tokens:,} tokens",
                "",
            ]
        )
    else:
        lines.extend(
            [
                "Context Growth:",
                "  • No context data yet (tracking started)",
                "",
            ]
        )

    # Cost attribution section
    ca = cost_attribution or {}
    if ca.get("total_sessions", 0) > 0:
        lines.append("Cost Attribution:")
        lines.append(f"  • Sessions tagged: {ca['total_sessions']}")
        by_tag = ca.get("by_tag", {})
        pct = ca.get("pct", {})
        for tag in sorted(by_tag.keys(), key=lambda t: by_tag[t], reverse=True):
            lines.append(f"  • {tag}: {by_tag[tag]} sessions ({pct.get(tag, 0):.1f}%)")
        lines.append("")
    else:
        lines.extend(
            [
                "Cost Attribution:",
                "  • No attribution data yet (tracking started)",
                "",
            ]
        )

    # Prompt caching section
    pc = prompt_caching or {}
    if pc.get("total_lines", 0) > 0:
        lines.extend(
            [
                "Prompt Caching:",
                f"  • CLAUDE.md: {pc['total_lines']} lines ({pc['static_lines']} static, {pc['total_lines'] - pc['static_lines']} dynamic)",
                f"  • Cacheability: {pc.get('cacheability_pct', 0):.1f}% (target: 80%+)",
                "",
            ]
        )
    else:
        lines.extend(
            [
                "Prompt Caching:",
                "  • No caching data available",
                "",
            ]
        )

    lines.extend(
        [
            "Budget & Spend:",
            f"  • Monthly budget: ${budget_metrics['monthly_budget_usd']:.2f}",
            f"  • Actual spend: ${budget_metrics['actual_spend_usd']:.2f}",
            f"  • Budget utilization: {budget_metrics['budget_pct_used']:.1f}%",
            f"  • Status: {'🔴 OVER BUDGET' if budget_metrics['over_budget'] else '🟢 On track'}",
            "",
            "─" * 80,
            "LETTER GRADE BREAKDOWN",
            "─" * 80,
            "",
            f"  Efficiency Score:   {scores['efficiency']:.1f}/100",
            f"  Budget Adherence:   {100 - budget_metrics['budget_pct_used']:.1f}/100",
            f"  Guard Adoption:     {scores['adoption']:.1f}/100",
            f"  Savings Rate:       {scores['savings_rate']:.1f}%",
            "",
            "─" * 80,
            "STRATEGIC RECOMMENDATIONS (2026 AI Landscape)",
            "─" * 80,
            "",
        ]
    )

    for i, rec in enumerate(recommendations, 1):
        lines.append(f"{i}. {rec}")
        lines.append("")

    lines.extend(
        [
            "─" * 80,
            f"Report generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"System: Claude Code Token Management v2.0",
            "=" * 80,
        ]
    )

    return "\n".join(lines)


def format_report_json(
    report_month: str,
    read_metrics: Dict,
    agent_metrics: Dict,
    budget_metrics: Dict,
    grade: str,
    grade_reason: str,
    scores: Dict,
    recommendations: List[str],
    agent_budget_metrics: Optional[Dict] = None,
    model_distribution: Optional[Dict] = None,
    context_growth: Optional[Dict] = None,
    cost_attribution: Optional[Dict] = None,
    prompt_caching: Optional[Dict] = None,
) -> str:
    """Format report as JSON."""
    report = {
        "report_month": report_month,
        "generated_at": datetime.now().isoformat(),
        "grade": {
            "letter": grade,
            "reason": grade_reason,
            "scores": scores,
        },
        "metrics": {
            "read_guard": read_metrics,
            "agent_guard": agent_metrics,
            "agent_budgets": agent_budget_metrics or {},
            "model_distribution": model_distribution or {},
            "context_growth": context_growth or {},
            "cost_attribution": cost_attribution or {},
            "prompt_caching": prompt_caching or {},
            "budget": budget_metrics,
        },
        "recommendations": recommendations,
    }
    return json.dumps(report, indent=2)


def format_report_markdown(
    report_month: str,
    read_metrics: Dict,
    agent_metrics: Dict,
    budget_metrics: Dict,
    grade: str,
    grade_reason: str,
    scores: Dict,
    recommendations: List[str],
    agent_budget_metrics: Optional[Dict] = None,
    model_distribution: Optional[Dict] = None,
    context_growth: Optional[Dict] = None,
    cost_attribution: Optional[Dict] = None,
    prompt_caching: Optional[Dict] = None,
) -> str:
    """Format report as Markdown."""
    lines = [
        f"# Token Management Monthly Report — {report_month}",
        "",
        f"## 📊 Overall Grade: **{grade}**",
        "",
        f"**{grade_reason}**",
        "",
        "---",
        "",
        "## Performance Metrics",
        "",
        "### Read Efficiency Guard",
        "",
        f"- **Total read attempts:** {read_metrics['total_read_attempts']:,}",
        f"- **Blocks:** {read_metrics['total_blocks']} ({read_metrics['total_blocks']/max(read_metrics['total_read_attempts'],1)*100:.1f}% block rate)",
        f"- **Sessions affected:** {read_metrics['sessions_affected']}",
        f"- **Heaviest session:** `{read_metrics['heaviest_session']['session']}` ({read_metrics['heaviest_session']['blocks']} blocks)",
        f"- **Estimated tokens saved:** {read_metrics['estimated_tokens_saved']:,}",
        f"- **Estimated cost saved:** ${read_metrics['estimated_cost_saved']:.2f}",
        "",
        "### Agent Spawn Guard",
        "",
        f"- **Total agent attempts:** {agent_metrics['total_agent_attempts']}",
        f"- **Blocks:** {agent_metrics['total_blocks']}",
        f"- **Parallel violations:** {agent_metrics['parallel_violations']}",
        f"- **Duplicate type violations:** {agent_metrics['duplicate_type_violations']}",
        "",
        "### Budget & Spend",
        "",
        f"- **Monthly budget:** ${budget_metrics['monthly_budget_usd']:.2f}",
        f"- **Actual spend:** ${budget_metrics['actual_spend_usd']:.2f}",
        f"- **Budget utilization:** {budget_metrics['budget_pct_used']:.1f}%",
        f"- **Status:** {'🔴 OVER BUDGET' if budget_metrics['over_budget'] else '🟢 On track'}",
        "",
        "---",
        "",
        "## Letter Grade Breakdown",
        "",
        f"| Metric | Score |",
        f"|--------|-------|",
        f"| Efficiency Score | {scores['efficiency']:.1f}/100 |",
        f"| Budget Adherence | {100 - budget_metrics['budget_pct_used']:.1f}/100 |",
        f"| Guard Adoption | {scores['adoption']:.1f}/100 |",
        f"| Savings Rate | {scores['savings_rate']:.1f}% |",
        "",
        "---",
        "",
        "## Strategic Recommendations (2026 AI Landscape)",
        "",
    ]

    for i, rec in enumerate(recommendations, 1):
        lines.append(f"{i}. {rec}")
        lines.append("")

    lines.extend(
        [
            "---",
            "",
            f"*Report generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*",
            "",
            f"*System: Claude Code Token Management v2.0*",
        ]
    )

    return "\n".join(lines)


# ============================================================================
# MAIN
# ============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Generate token management monthly report"
    )
    parser.add_argument(
        "--month",
        help="Report month (YYYY-MM, default: current month)",
        default=datetime.now().strftime("%Y-%m"),
    )
    parser.add_argument(
        "--format",
        choices=["text", "json", "markdown"],
        default="text",
        help="Output format",
    )
    parser.add_argument(
        "--output",
        help="Output file (default: stdout)",
    )

    args = parser.parse_args()

    # Parse month
    try:
        report_date = datetime.strptime(args.month, "%Y-%m")
        start_date = report_date.replace(day=1)
        # Last day of month
        if report_date.month == 12:
            end_date = report_date.replace(
                year=report_date.year + 1, month=1, day=1
            ) - timedelta(days=1)
        else:
            end_date = report_date.replace(
                month=report_date.month + 1, day=1
            ) - timedelta(days=1)
        end_date = end_date.replace(hour=23, minute=59, second=59)
    except ValueError:
        print(
            f"Error: Invalid month format '{args.month}'. Use YYYY-MM.", file=sys.stderr
        )
        sys.exit(1)

    # Collect data
    read_metrics = collect_read_guard_metrics(start_date, end_date)
    agent_metrics = collect_agent_guard_metrics(start_date, end_date)
    budget_metrics = collect_budget_metrics(start_date, end_date)
    agent_budget_metrics = collect_agent_budget_adherence(start_date, end_date)
    model_dist = collect_model_distribution(start_date, end_date)
    context_growth = collect_context_growth_metrics()
    cost_attribution = collect_cost_attribution()
    prompt_caching = collect_prompt_caching_metrics()

    # Calculate scores
    efficiency = calculate_efficiency_score(read_metrics, agent_metrics)
    adoption = calculate_guard_adoption(read_metrics, agent_metrics)
    savings_rate = calculate_savings_rate(read_metrics, budget_metrics)

    scores = {
        "efficiency": efficiency,
        "adoption": adoption,
        "savings_rate": savings_rate,
    }

    # Assign grade
    grade, grade_reason = assign_letter_grade(
        efficiency,
        budget_metrics["budget_pct_used"],
        adoption,
        savings_rate,
    )

    # Generate recommendations
    recommendations = generate_recommendations(
        grade,
        read_metrics,
        agent_metrics,
        budget_metrics,
        efficiency,
        adoption,
    )

    # Format report
    fmt_kwargs = dict(
        report_month=args.month,
        read_metrics=read_metrics,
        agent_metrics=agent_metrics,
        budget_metrics=budget_metrics,
        grade=grade,
        grade_reason=grade_reason,
        scores=scores,
        recommendations=recommendations,
        agent_budget_metrics=agent_budget_metrics,
        model_distribution=model_dist,
        context_growth=context_growth,
        cost_attribution=cost_attribution,
        prompt_caching=prompt_caching,
    )
    if args.format == "json":
        report = format_report_json(**fmt_kwargs)
    elif args.format == "markdown":
        report = format_report_markdown(**fmt_kwargs)
    else:
        report = format_report_text(**fmt_kwargs)

    # Output
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            f.write(report)
        print(f"Report written to: {output_path}", file=sys.stderr)
    else:
        print(report)

    # Save to reports dir
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report_filename = f"token-mgmt-{args.month}.{args.format}"
    report_path = REPORTS_DIR / report_filename
    with open(report_path, "w") as f:
        f.write(report)
    print(f"\n[Archived to: {report_path}]", file=sys.stderr)


if __name__ == "__main__":
    main()
