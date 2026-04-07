/**
 * Measured A/B throughput comparison: Lead System vs native path.
 *
 * This module only reports measured harness evidence from reports/ab-harness
 * and suppresses savings claims unless the claim-safe policy allows them.
 *
 * @module cost-comparison
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { text } from "./helpers.js";

function formatMetric(metric) {
  if (!metric || metric.mean === null || metric.mean === undefined)
    return "n/a";
  return `${metric.mean} [${metric.ci_low}, ${metric.ci_high}]`;
}

function formatCompletion(metric) {
  if (!metric || metric.mean === null || metric.mean === undefined)
    return "n/a";
  return `${metric.mean} [${metric.ci_low}, ${metric.ci_high}] (${metric.successes}/${metric.total})`;
}

function formatStructuralMetric(metric) {
  if (metric === null || metric === undefined) return "n/a";
  if (typeof metric === "number") return String(metric);
  if (metric.mean !== null && metric.mean !== undefined) {
    return `${metric.mean} [${metric.ci_low}, ${metric.ci_high}]`;
  }
  return "n/a";
}

function readJson(pathValue) {
  try {
    return JSON.parse(readFileSync(pathValue, "utf8"));
  } catch {
    return null;
  }
}

function candidateSummaryRoots() {
  const roots = [];

  if (process.env.LEAD_AB_HARNESS_SUMMARY) {
    roots.push(resolve(process.env.LEAD_AB_HARNESS_SUMMARY));
  }
  if (process.env.LEAD_AB_HARNESS_ROOT) {
    roots.push(resolve(process.env.LEAD_AB_HARNESS_ROOT));
  }

  roots.push(resolve(process.cwd(), "reports", "ab-harness"));
  roots.push(resolve(process.cwd(), "bench", "reports", "ab-harness"));

  return [...new Set(roots)];
}

function findLatestSummaryPath() {
  // Direct summary file override has highest precedence.
  if (process.env.LEAD_AB_HARNESS_SUMMARY) {
    const direct = resolve(process.env.LEAD_AB_HARNESS_SUMMARY);
    if (existsSync(direct)) return direct;
  }

  const roots = candidateSummaryRoots();
  let latest = null;

  for (const root of roots) {
    if (!existsSync(root)) continue;

    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summary = join(root, entry.name, "summary.json");
      if (!existsSync(summary)) continue;
      try {
        const st = statSync(summary);
        if (!latest || st.mtimeMs > latest.mtimeMs) {
          latest = { path: summary, mtimeMs: st.mtimeMs };
        }
      } catch {
        // ignore unreadable files
      }
    }
  }

  return latest ? latest.path : null;
}

function renderMeasuredReport(summary, summaryPath) {
  const baseline = summary?.baseline_path || "native";
  const perPath = summary?.summary?.per_path || {};
  const comparisons = summary?.summary?.comparisons_vs_baseline || {};
  const claimSafe = summary?.claim_safe_summary?.statements || [];
  const claimPolicy = summary?.claim_safe_summary?.policy || [];

  let out = "## Measured A/B Comparison (Harness Evidence)\n\n";
  out += `- Source: ${summaryPath}\n`;
  out += `- Run ID: ${summary?.run_id || "unknown"}\n`;
  out += `- Generated: ${summary?.generated_at || "unknown"}\n`;
  out += `- Workload: ${summary?.workload?.id || "unknown"}\n`;
  out += `- Trials: ${summary?.trials || "unknown"}\n`;
  out += `- Baseline path: ${baseline}\n\n`;

  out += "### Path Metrics\n";
  out +=
    "| Path | Completion rate | Latency ms | Tokens | Human interventions | Conflict incidents | Throughput / usage window | Resume success rate |\n";
  out += "| --- | --- | --- | --- | --- | --- | --- | --- |\n";
  for (const [pathId, m] of Object.entries(perPath)) {
    const resume = m?.resume;
    const resumeText = resume
      ? `${resume.success_rate_mean} [${resume.success_rate_ci_low}, ${resume.success_rate_ci_high}] (${resume.successes}/${resume.attempts})`
      : "n/a";
    out += `| ${pathId} | ${formatCompletion(m?.completion_rate)} | ${formatMetric(m?.latency_ms)} | ${formatMetric(m?.tokens_total)} | ${formatMetric(m?.human_interventions)} | ${formatMetric(m?.conflict_incidents)} | ${formatMetric(m?.throughput_per_usage_window)} | ${resumeText} |\n`;
  }
  out += "\n";

  out += "### Structural Overhead Metrics\n";
  out +=
    "| Path | Orchestration messages / completed task | Redundant prompt or summary events | Avoidable fallback loops | Intervention triggers |\n";
  out += "| --- | --- | --- | --- | --- |\n";
  for (const [pathId, m] of Object.entries(perPath)) {
    out += `| ${pathId} | ${formatStructuralMetric(m?.orchestration_messages_per_completed_task)} | ${formatStructuralMetric(m?.redundant_prompt_or_summary_events)} | ${formatStructuralMetric(m?.avoidable_fallback_loops)} | ${formatStructuralMetric(m?.intervention_triggers)} |\n`;
  }
  out += "\n";

  if (Object.keys(comparisons).length > 0) {
    out += `### Comparisons vs ${baseline}\n`;
    out += "| Path | Tokens diff | Latency diff | Throughput diff |\n";
    out += "| --- | --- | --- | --- |\n";
    for (const [pathId, c] of Object.entries(comparisons)) {
      const token = c?.tokens_total_minus_baseline;
      const latency = c?.latency_ms_minus_baseline;
      const throughput = c?.throughput_per_window_minus_baseline;
      const fmt = (v) =>
        v && v.mean_diff !== null
          ? `${v.mean_diff} [${v.ci_low}, ${v.ci_high}]`
          : "n/a";
      out += `| ${pathId} | ${fmt(token)} | ${fmt(latency)} | ${fmt(throughput)} |\n`;
    }
    out += "\n";
  }

  out += "### Claim-safe Summary\n";
  if (claimSafe.length === 0) {
    out += "- No claim-safe summary present in harness artifact.\n";
  } else {
    for (const line of claimSafe) out += `- ${line}\n`;
  }
  out += "\n";

  out += "### Savings Claim Gate\n";
  if (claimPolicy.length === 0) {
    out +=
      "- No policy block found. Savings claims are not allowed without measured policy evidence.\n";
  } else {
    for (const policy of claimPolicy) {
      out += `- ${policy.path_id}: savings_claim_allowed=${policy.savings_claim_allowed ? "true" : "false"} (${policy.reason || "no reason provided"})\n`;
    }
  }
  out += "\n";

  out +=
    "Only measured harness evidence is reported here. If no measured advantage is proven, no cheaper-than-native claim is made.\n";
  return out;
}

/**
 * Handle coord_cost_comparison tool call.
 * Reports measured A/B harness evidence only.
 * @returns {object} MCP text response
 */
export function handleCostComparison() {
  const summaryPath = findLatestSummaryPath();
  if (!summaryPath) {
    const guidance = [
      "No measured A/B harness summary found.",
      "Run: node bench/ab-harness.mjs --config bench/ab-harness.config.example.json",
      "Expected artifact: reports/ab-harness/<run-id>/summary.json",
      "No cheaper-than-native claim is allowed without measured harness evidence.",
    ].join("\n");
    return text(guidance);
  }

  const summary = readJson(summaryPath);
  if (!summary) {
    return text(
      `Measured harness summary exists but is unreadable: ${summaryPath}\n` +
        "No cheaper-than-native claim is allowed without readable measured evidence.",
    );
  }

  return text(renderMeasuredReport(summary, summaryPath));
}
