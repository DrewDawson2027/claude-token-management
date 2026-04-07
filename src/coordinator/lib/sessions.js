/**
 * Session management: list, get, status detection.
 * @module sessions
 */

import { readdirSync, existsSync, readFileSync } from "fs";
import { join, basename } from "path";
import { execFileSync } from "child_process";
import { cfg } from "./constants.js";
import { sanitizeShortSessionId } from "./security.js";
import { readJSON, readJSONLLimited, text, timeAgo } from "./helpers.js";
import { colorName } from "./teams.js";

/** Lightweight process-alive check used only in this module. */
function _isAlive(pid) {
  try {
    execFileSync("kill", ["-0", String(pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a lookup map from session_id prefix → {name, color} by reading all
 * team JSON files. Used to annotate coord_list_sessions with member identity.
 * @returns {Record<string, {name: string, color: string}>}
 */
function buildSessionColorMap() {
  const { TERMINALS_DIR } = cfg();
  const teamsDir = join(TERMINALS_DIR, "teams");
  if (!existsSync(teamsDir)) return {};
  const map = {};
  try {
    const files = readdirSync(teamsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const team = readJSON(join(teamsDir, file));
      if (!team?.members) continue;
      for (const m of team.members) {
        if (m.session_id) map[m.session_id] = { name: m.name, color: m.color };
      }
    }
  } catch {
    /* best-effort — teams dir may not exist */
  }
  return map;
}

/**
 * Get all sessions from disk.
 * @returns {object[]} Session objects
 */
export function getAllSessions() {
  const { TERMINALS_DIR } = cfg();
  try {
    return readdirSync(TERMINALS_DIR)
      .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
      .map((f) => readJSON(join(TERMINALS_DIR, f)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Determine the effective status of a session.
 * @param {object} session - Session data
 * @returns {string} "active" | "idle" | "stale" | "closed" | "unknown"
 */
export function getSessionStatus(session) {
  const { SESSION_ACTIVE_SECONDS, SESSION_IDLE_SECONDS } = cfg();
  if (session.status === "closed") return "closed";
  if (session.status === "stale") return "stale";
  if (!session.last_active) return "unknown";
  const age = (Date.now() - new Date(session.last_active).getTime()) / 1000;
  if (age < SESSION_ACTIVE_SECONDS) return "active";
  if (age < SESSION_IDLE_SECONDS) return "idle";
  return "stale";
}

/**
 * Handle coord_list_sessions tool call.
 * @param {object} args - Tool arguments
 * @returns {object} MCP text response
 */
export function handleListSessions(args = {}) {
  const sessions = getAllSessions();
  const includeClosed = args?.include_closed ?? false;
  const projectFilter = args?.project;

  let filtered = sessions;
  if (!includeClosed) filtered = filtered.filter((s) => s.status !== "closed");
  if (projectFilter) {
    const lowered = String(projectFilter).toLowerCase();
    filtered = filtered.filter((s) =>
      String(s.project || "")
        .toLowerCase()
        .includes(lowered),
    );
  }

  if (filtered.length === 0) return text("No active sessions found.");

  const sessionColorMap = buildSessionColorMap();
  const rows = filtered.map((s) => {
    const status = getSessionStatus(s);
    const lastActive = timeAgo(s.last_active);
    const tc = s.tool_counts || {};
    const tools = `${tc.Write || 0}/${tc.Edit || 0}/${tc.Bash || 0}/${tc.Read || 0}`;
    const recentFiles =
      (s.files_touched || [])
        .slice(-3)
        .map((f) => basename(f))
        .join(", ") || "\u2014";
    const lastOp = s.recent_ops?.length
      ? `${s.recent_ops[s.recent_ops.length - 1].tool} ${basename(s.recent_ops[s.recent_ops.length - 1].file || "")}`
      : "\u2014";
    const memberInfo = sessionColorMap[s.session];
    const memberCol = memberInfo
      ? colorName(memberInfo.name, memberInfo.color)
      : "\u2014";
    return `| ${memberCol} | ${s.session} | ${s.tty || "?"} | ${s.project || "?"} | ${status} | ${lastActive} | ${tools} | ${recentFiles} | ${lastOp} |`;
  });

  const table =
    `| Member | Session | TTY | Project | Status | Last Active | W/E/B/R | Recent Files | Last Op |\n|--------|---------|-----|---------|--------|-------------|---------|--------------|---------|` +
    "\n" +
    rows.join("\n");
  return text(
    `## Sessions (${filtered.length}) \u2014 Platform: ${cfg().PLATFORM}\n\n${table}`,
  );
}

/**
 * Handle coord_get_session tool call.
 * @param {object} args - Tool arguments
 * @returns {object} MCP text response
 */
export function handleGetSession(args) {
  const sid = sanitizeShortSessionId(args.session_id);
  const { TERMINALS_DIR, INBOX_DIR } = cfg();
  const session = readJSON(join(TERMINALS_DIR, `session-${sid}.json`));
  if (!session) return text(`Session ${sid} not found.`);

  let output = `## Session ${sid}\n\n`;
  output += `- **Project:** ${session.project}\n`;
  output += `- **Branch:** ${session.branch}\n- **CWD:** ${session.cwd}\n`;
  output += `- **Status:** ${getSessionStatus(session)}\n`;
  output += `- **TTY:** ${session.tty || "unknown"}\n`;
  output += `- **Started:** ${session.started}\n- **Last Active:** ${timeAgo(session.last_active)}\n`;
  output += `- **Task:** ${session.current_task || "not declared"}\n`;

  if (session.tool_counts) {
    const tc = session.tool_counts;
    output += `\n### Tool Usage\nWrite: ${tc.Write || 0} | Edit: ${tc.Edit || 0} | Bash: ${tc.Bash || 0} | Read: ${tc.Read || 0}\n`;
  }
  if (session.files_touched?.length) {
    output += `\n### Files Touched (${session.files_touched.length})\n`;
    session.files_touched.forEach((f) => {
      output += `- ${f}\n`;
    });
  }
  if (session.recent_ops?.length) {
    output += `\n### Recent Operations\n`;
    session.recent_ops.forEach((op) => {
      output += `- ${op.t} ${op.tool} ${op.file || ""}\n`;
    });
  }

  if (session.plan_file && existsSync(session.plan_file)) {
    try {
      const first20 = readFileSync(session.plan_file, "utf-8")
        .split("\n")
        .slice(0, 20)
        .join("\n");
      output += `\n### Active Plan\n\`\`\`\n${first20}\n\`\`\`\n`;
    } catch (e) {
      process.stderr.write(`coord: plan read failed: ${e.message}\n`);
    }
  }

  const inboxView = readJSONLLimited(join(INBOX_DIR, `${sid}.jsonl`));
  output += `\n### Inbox: ${inboxView.items.length} pending message(s)\n`;
  if (inboxView.truncated) output += `_Inbox count limited by safety caps._\n`;

  return text(output);
}

/**
 * Handle coord_discover_peers — returns list of teammates for a team.
 * Matches native Agent Teams' peer discovery. (Gap 3)
 * @param {object} args - { team_name }
 * @returns {object} MCP text response
 */
export function handleDiscoverPeers(args) {
  const { RESULTS_DIR } = cfg();
  const teamName = args.team_name ? String(args.team_name).trim() : null;
  if (!teamName) return text("team_name is required.");

  const sessions = getAllSessions();
  const peers = [];

  // Scan meta files for workers in this team
  try {
    const files = readdirSync(RESULTS_DIR).filter(
      (f) => f.endsWith(".meta.json") && !f.includes(".done"),
    );
    for (const f of files) {
      const meta = readJSON(join(RESULTS_DIR, f));
      if (!meta || meta.team_name !== teamName) continue;
      // Find matching session for this worker
      const workerSession = sessions.find(
        (s) => s.current_task === meta.task_id,
      );
      const status = workerSession
        ? getSessionStatus(workerSession)
        : "unknown";
      peers.push({
        name: meta.worker_name || meta.task_id,
        task_id: meta.task_id,
        session_id: workerSession?.session || null,
        tmux_pane_id: meta.tmux_pane_id || null,
        role: meta.role || "custom",
        model: meta.model,
        status,
        permission_mode: meta.permission_mode,
      });
    }
  } catch {}

  if (peers.length === 0) {
    return text(`No peers found in team "${teamName}".`);
  }

  let output = `## Team: ${teamName} — ${peers.length} peer(s)\n\n`;
  output += `| Name | Task ID | Session | Pane | Role | Status |\n`;
  output += `|------|---------|---------|------|------|--------|\n`;
  for (const p of peers) {
    output += `| ${p.name} | ${p.task_id} | ${p.session_id || "—"} | ${p.tmux_pane_id || "—"} | ${p.role} | ${p.status} |\n`;
  }
  return text(output);
}

/**
 * Handle coord_boot_snapshot — pre-formatted dashboard replacing raw JSON boot loop.
 * Returns: session table, conflict report, per-project git summary, recommendations.
 * @param {object} args - { include_git?: boolean }
 * @returns {object} MCP text response
 */
export function handleBootSnapshot(args = {}) {
  const sessions = getAllSessions().filter((s) => s.status !== "closed");
  if (sessions.length === 0)
    return text(
      "# Lead — Online\n\nNo active sessions. Open additional Claude terminals to coordinate.",
    );

  // Build session table
  const rows = sessions
    .sort((a, b) => {
      const order = { active: 0, idle: 1, stale: 2, unknown: 3 };
      return (
        (order[getSessionStatus(a)] ?? 9) - (order[getSessionStatus(b)] ?? 9)
      );
    })
    .map((s) => {
      const status = getSessionStatus(s);
      const tc = s.tool_counts || {};
      const tools = `${tc.Write || 0}/${tc.Edit || 0}/${tc.Bash || 0}/${tc.Read || 0}`;
      const recentFiles =
        (s.files_touched || [])
          .slice(-3)
          .map((f) => basename(f))
          .join(", ") || "\u2014";
      const lastOp = s.recent_ops?.length
        ? `${s.recent_ops[s.recent_ops.length - 1].tool} ${basename(s.recent_ops[s.recent_ops.length - 1].file || "")}`
        : "\u2014";
      return `| ${s.session} | ${s.tty || "?"} | ${s.project || "?"} | ${status} | ${tools} | ${recentFiles} | ${lastOp} |`;
    });

  let out = `# Lead — Online\n\n`;
  out += `## Sessions (${sessions.length})\n`;
  out += `| Session | TTY | Project | Status | W/E/B/R | Recent Files | Last Op |\n`;
  out +=
    `|---------|-----|---------|--------|---------|--------------|---------|` +
    "\n";
  out += rows.join("\n") + "\n";

  // What each terminal is doing
  out += `\n## What Each Terminal Is Doing\n`;
  for (const s of sessions) {
    const status = getSessionStatus(s);
    if (status === "stale") continue;
    const tc = s.tool_counts || {};
    const topFiles = (s.files_touched || [])
      .slice(-5)
      .map((f) => basename(f))
      .join(", ");
    const activity = [];
    if (tc.Write) activity.push(`${tc.Write} Writes`);
    if (tc.Edit) activity.push(`${tc.Edit} Edits`);
    if (tc.Bash) activity.push(`${tc.Bash} Bash`);
    out += `- **${s.session}** (${s.tty || "?"}): ${topFiles || "no files yet"} — ${activity.join(", ") || "idle"}\n`;
  }

  // Conflict detection
  const fileMap = new Map();
  for (const s of sessions) {
    for (const f of s.files_touched || []) {
      if (!fileMap.has(f)) fileMap.set(f, []);
      fileMap.get(f).push(s.session);
    }
  }
  const conflicts = [...fileMap.entries()].filter(
    ([, sids]) => sids.length > 1,
  );
  out += `\n## Conflicts\n`;
  if (conflicts.length === 0) {
    out += `None detected.\n`;
  } else {
    for (const [file, sids] of conflicts) {
      out += `- **${basename(file)}**: ${sids.join(", ")}\n`;
    }
  }

  // Git status per unique project (optional, adds latency)
  if (args?.include_git) {
    const projects = new Map();
    for (const s of sessions) {
      if (s.cwd && !projects.has(s.cwd))
        projects.set(s.cwd, s.project || s.cwd);
    }
    if (projects.size > 0) {
      out += `\n## Git Status\n`;
      for (const [cwd, name] of projects) {
        try {
          const branch = execFileSync(
            "git",
            ["-C", cwd, "branch", "--show-current"],
            { timeout: 3000 },
          )
            .toString()
            .trim();
          const dirty = execFileSync("git", ["-C", cwd, "status", "-s"], {
            timeout: 3000,
          })
            .toString()
            .trim()
            .split("\n")
            .filter(Boolean).length;
          out += `- **${name}**: \`${branch}\` (${dirty} dirty files)\n`;
        } catch {
          out += `- **${name}**: git unavailable\n`;
        }
      }
    }
  }

  // Recommendations
  const staleCount = sessions.filter(
    (s) => getSessionStatus(s) === "stale",
  ).length;
  const idleCount = sessions.filter(
    (s) => getSessionStatus(s) === "idle",
  ).length;
  out += `\n## Recommended\n`;
  if (conflicts.length > 0)
    out += `- **URGENT:** Resolve ${conflicts.length} file conflict(s) — message affected sessions\n`;
  if (staleCount > 0) out += `- Clean up ${staleCount} stale session(s)\n`;
  if (idleCount > 0) out += `- Wake or reassign ${idleCount} idle session(s)\n`;
  if (conflicts.length === 0 && staleCount === 0 && idleCount === 0)
    out += `- All sessions healthy. Standing by.\n`;

  // Active worker output tails (Gap 5 — no explicit coord_watch_output needed on boot)
  try {
    const { RESULTS_DIR } = cfg();
    const workerTails = [];
    const metas = readdirSync(RESULTS_DIR).filter((f) =>
      f.endsWith(".meta.json"),
    );
    for (const mf of metas) {
      const meta = readJSON(join(RESULTS_DIR, mf));
      if (!meta) continue;
      const tid = mf.replace(".meta.json", "");
      const metaFullPath = join(RESULTS_DIR, mf);
      if (existsSync(`${metaFullPath}.done`)) continue;
      const pidFile = join(RESULTS_DIR, `${tid}.pid`);
      if (!existsSync(pidFile)) continue;
      const pid = readFileSync(pidFile, "utf-8").trim();
      if (!_isAlive(pid)) continue;
      const resultFile = join(RESULTS_DIR, `${tid}.txt`);
      let lastLine = "(no output yet)";
      if (existsSync(resultFile)) {
        const content = readFileSync(resultFile, "utf-8").trimEnd();
        const allLines = content.split("\n");
        lastLine = allLines[allLines.length - 1] || "(empty)";
        if (lastLine.length > 120) lastLine = lastLine.slice(0, 117) + "...";
      }
      workerTails.push({ name: meta.worker_name || tid, lastLine });
    }
    if (workerTails.length > 0) {
      out += `\n## Active Workers\n`;
      for (const w of workerTails) {
        out += `**[running] ${w.name}:** ${w.lastLine}\n`;
      }
    }
  } catch {
    /* no results dir or empty — skip */
  }

  return text(out);
}
