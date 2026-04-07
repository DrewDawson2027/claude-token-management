/**
 * Session health checks for `/lead` boot reliability.
 * Reports sparse-session ratio and enrichment coverage without transcript reads.
 * @module session-health
 */

import { readdirSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { cfg } from "./constants.js";
import { readJSON, text } from "./helpers.js";
import { getAllSessions, getSessionStatus } from "./sessions.js";
import {
  buildActivityReplayIndex,
  hasCanonicalEnrichment,
} from "./session-hydration.js";

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function countBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function listRawSessions() {
  const { TERMINALS_DIR } = cfg();
  const files = [];
  try {
    for (const f of readdirSync(TERMINALS_DIR)) {
      if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
      const fp = join(TERMINALS_DIR, f);
      const parsed = readJSON(fp);
      files.push({ file: f, path: fp, session: parsed });
    }
  } catch {}
  return files;
}

function flattenHookCommands(settings) {
  const out = [];
  const hooks = settings?.hooks || {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = group?.matcher || "*";
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (hook?.type !== "command") continue;
        out.push({
          event: eventName,
          matcher,
          command: String(hook.command || ""),
        });
      }
    }
  }
  return out;
}

function fileFingerprint(pathValue) {
  try {
    if (!existsSync(pathValue)) return { exists: false };
    const st = statSync(pathValue);
    const buf = readFileSync(pathValue);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return {
      exists: true,
      size_bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      sha256_12: sha256.slice(0, 12),
    };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

function inspectHookWiring() {
  const c = cfg();
  const settingsPath = c.SETTINGS_FILE;
  const settings = readJSON(settingsPath);
  const commands = settings ? flattenHookCommands(settings) : [];
  const has = (event, needle) =>
    commands.some((h) => h.event === event && h.command.includes(needle));
  const hooksDir = join(c.CLAUDE_DIR, "hooks");
  const files = {
    session_register: join(hooksDir, "session-register.sh"),
    terminal_heartbeat: join(hooksDir, "terminal-heartbeat.sh"),
    check_inbox: join(hooksDir, "check-inbox.sh"),
  };

  const checks = {
    settings_file_present: existsSync(settingsPath),
    settings_file_parseable: Boolean(settings),
    session_start_register_configured: settings
      ? has("SessionStart", "session-register.sh")
      : null,
    post_tool_heartbeat_configured: settings
      ? has("PostToolUse", "terminal-heartbeat.sh")
      : null,
    pre_tool_check_inbox_configured: settings
      ? has("PreToolUse", "check-inbox.sh")
      : null,
    files_present: {
      session_register: fileFingerprint(files.session_register),
      terminal_heartbeat: fileFingerprint(files.terminal_heartbeat),
      check_inbox: fileFingerprint(files.check_inbox),
    },
  };
  return checks;
}

function computeAlertLevel(metrics, args = {}) {
  const warnSparseRatio = Number(args.warn_sparse_ratio ?? 0.1);
  const failSparseRatio = Number(args.fail_sparse_ratio ?? 0.25);
  const requireActiveCoverage = args.require_active_coverage ?? true;

  if (metrics.raw.parse_errors > 0) return "warning";
  const hooks = metrics.hooks || {};
  if (hooks.settings_file_present && hooks.settings_file_parseable) {
    if (hooks.session_start_register_configured === false) return "critical";
    if (hooks.post_tool_heartbeat_configured === false) return "critical";
    if (hooks.pre_tool_check_inbox_configured === false) return "warning";
  }
  const fp = hooks.files_present || {};
  if (fp.session_register?.exists === false) return "critical";
  if (fp.terminal_heartbeat?.exists === false) return "critical";
  if (fp.check_inbox?.exists === false) return "warning";
  if (metrics.raw.sparse_ratio > failSparseRatio) return "critical";
  if (metrics.raw.sparse_ratio > warnSparseRatio) return "warning";
  if (requireActiveCoverage && metrics.post.active_canonical_ratio < 100)
    return "critical";
  return "ok";
}

function buildHealthPayload(args = {}) {
  const includeClosed = Boolean(args.include_closed);
  const rawEntries = listRawSessions();

  const rawParsed = rawEntries.filter((r) => r.session);
  const rawFiltered = includeClosed
    ? rawParsed
    : rawParsed.filter((r) => r.session?.status !== "closed");
  const rawSparse = rawFiltered.filter(
    (r) => !hasCanonicalEnrichment(r.session),
  );
  const rawCanonical = rawFiltered.filter((r) =>
    hasCanonicalEnrichment(r.session),
  );
  const activityIndex = buildActivityReplayIndex();

  // getAllSessions performs hydration/persist repair for sparse sessions.
  const postAll = getAllSessions();
  const postFiltered = includeClosed
    ? postAll
    : postAll.filter((s) => s.status !== "closed");
  const postCanonical = postFiltered.filter(hasCanonicalEnrichment);
  const postActive = postFiltered.filter(
    (s) => getSessionStatus(s) === "active",
  );
  const postActiveCanonical = postActive.filter(hasCanonicalEnrichment);
  const enrichmentStates = countBy(
    postFiltered,
    (s) => s.enrichment_status || "unknown",
  );
  const statuses = countBy(postFiltered, (s) => getSessionStatus(s));
  const activityCoveredSessions = postFiltered.filter((s) =>
    activityIndex.has(String(s.session || "").slice(0, 8)),
  ).length;

  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    policy: {
      transcript_reads_on_boot: "forbidden",
      boot_sources: ["session-*.json", "activity.jsonl", "git status"],
    },
    raw: {
      total_sessions: rawFiltered.length,
      parse_errors: rawEntries.length - rawParsed.length,
      canonical: rawCanonical.length,
      sparse: rawSparse.length,
      sparse_ratio: pct(rawSparse.length, rawFiltered.length),
    },
    hooks: inspectHookWiring(),
    post: {
      total_sessions: postFiltered.length,
      canonical: postCanonical.length,
      canonical_ratio: pct(postCanonical.length, postFiltered.length),
      active_sessions: postActive.length,
      active_canonical: postActiveCanonical.length,
      active_canonical_ratio: pct(
        postActiveCanonical.length,
        postActive.length,
      ),
      statuses,
      enrichment_status: enrichmentStates,
      activity_coverage_sessions: activityCoveredSessions,
      activity_coverage_ratio: pct(
        activityCoveredSessions,
        postFiltered.length,
      ),
    },
  };

  payload.level = computeAlertLevel(payload, args);
  payload.summary = {
    sparse_sessions_repaired_or_seeded:
      (payload.post.enrichment_status["hydrated-from-activity"] || 0) +
      (payload.post.enrichment_status.seeded || 0),
    ok_for_cheap_lead_boot: payload.post.active_canonical_ratio === 100,
    hook_enrichment_health_ok: payload.level === "ok",
  };

  return payload;
}

function renderText(payload) {
  const lines = [];
  lines.push(`## Session Health — ${payload.level.toUpperCase()}`);
  lines.push("");
  lines.push(
    `- Boot policy: no transcript reads (${payload.policy.boot_sources.join(", ")})`,
  );
  lines.push(
    `- Raw sparse ratio: ${payload.raw.sparse}/${payload.raw.total_sessions} (${payload.raw.sparse_ratio}%)`,
  );
  lines.push(
    `- Hooks: SessionStart(register)=${String(payload.hooks.session_start_register_configured)} PostToolUse(heartbeat)=${String(payload.hooks.post_tool_heartbeat_configured)} PreToolUse(check-inbox)=${String(payload.hooks.pre_tool_check_inbox_configured)}`,
  );
  lines.push(
    `- Post canonical ratio: ${payload.post.canonical}/${payload.post.total_sessions} (${payload.post.canonical_ratio}%)`,
  );
  lines.push(
    `- Active canonical ratio: ${payload.post.active_canonical}/${payload.post.active_sessions} (${payload.post.active_canonical_ratio}%)`,
  );
  lines.push(
    `- Enrichment states: ${
      Object.entries(payload.post.enrichment_status)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    }`,
  );
  lines.push(
    `- Statuses: ${
      Object.entries(payload.post.statuses)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    }`,
  );
  lines.push(
    `- Cheap /lead boot safe: ${payload.summary.ok_for_cheap_lead_boot ? "yes" : "no"}`,
  );
  lines.push(
    `- Hook enrichment health: ${payload.summary.hook_enrichment_health_ok ? "ok" : "degraded"}`,
  );
  if (payload.level !== "ok") {
    lines.push("");
    lines.push("### Action");
    lines.push(
      "- Show `/lead` dashboard in DEGRADED mode if active canonical ratio < 100%",
    );
    lines.push(
      "- Do not parse transcripts on boot; inspect transcript only on explicit request",
    );
    lines.push(
      "- Verify SessionStart/PostToolUse hooks are installed and current",
    );
  }
  return lines.join("\n");
}

export function handleSessionHealth(args = {}) {
  const payload = buildHealthPayload(args);
  if (String(args.format || "").toLowerCase() === "json") {
    return text(JSON.stringify(payload, null, 2));
  }
  return text(renderText(payload));
}

export const __sessionHealthTest = { buildHealthPayload };
