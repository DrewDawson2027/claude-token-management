/**
 * Conflict detection across sessions.
 * @module conflicts
 */

import { join } from "path";
import { cfg } from "./constants.js";
import {
  sanitizeShortSessionId,
  normalizeFilePath,
  appendJSONLineSecure,
} from "./security.js";
import { readJSONL, text } from "./helpers.js";
import { getAllSessions, getSessionStatus } from "./sessions.js";

/**
 * Handle coord_detect_conflicts tool call.
 * Checks files_touched, current_files, and recent activity for overlaps.
 * @param {object} args - { session_id, files }
 * @returns {object} MCP text response
 */
export function handleDetectConflicts(args) {
  const { ACTIVITY_FILE } = cfg();
  const session_id = sanitizeShortSessionId(args.session_id);
  const files = (args.files || []).map((f) => String(f).trim()).filter(Boolean);
  if (!files?.length) return text("No files specified.");
  const allSessions = getAllSessions();
  const sessionById = new Map(allSessions.map((s) => [s.session, s]));
  const detectorSession = sessionById.get(session_id);
  if (!detectorSession) return text(`Session ${session_id} not found.`);
  const detectorCwd = detectorSession?.cwd || "";
  const normalizedByInput = new Map(
    files.map((f) => [f, normalizeFilePath(f, detectorCwd)]),
  );
  const normalizedFiles = new Set(
    [...normalizedByInput.values()].filter(Boolean),
  );

  const sessions = allSessions.filter(
    (s) => s.session !== session_id && getSessionStatus(s) !== "closed",
  );
  const recentActivity = readJSONL(ACTIVITY_FILE).slice(-100);
  const liveWindowMs = 15000;
  const liveCutoff = Date.now() - liveWindowMs;
  const liveFilesBySession = new Map();
  for (const entry of recentActivity) {
    if (!["Read", "Edit", "Write"].includes(entry.tool)) continue;
    if (new Date(entry.ts).getTime() <= liveCutoff) continue;
    const normalized = normalizeFilePath(
      entry.path || "",
      sessionById.get(entry.session)?.cwd || detectorCwd,
    );
    if (!normalized) continue;
    if (!liveFilesBySession.has(entry.session))
      liveFilesBySession.set(entry.session, new Set());
    liveFilesBySession.get(entry.session).add(normalized);
  }
  const conflicts = [];

  for (const s of sessions) {
    const liveFiles = [...(liveFilesBySession.get(s.session) || new Set())];
    const activeFiles = Array.isArray(s.current_files) ? s.current_files : [];
    const historicalFiles = Array.isArray(s.files_touched)
      ? s.files_touched
      : [];
    const theirFiles =
      liveFiles.length > 0
        ? liveFiles
        : activeFiles.length > 0
          ? activeFiles
          : historicalFiles;
    if (!theirFiles.length) continue;
    const theirNormalized = new Set(
      theirFiles
        .map((sf) => normalizeFilePath(sf, s.cwd || ""))
        .filter(Boolean),
    );
    const overlap = files.filter((f) => {
      const normalized = normalizedByInput.get(f);
      return normalized && theirNormalized.has(normalized);
    });
    if (overlap.length > 0) {
      conflicts.push({
        session: s.session,
        project: s.project,
        task: s.current_task || "unknown",
        overlapping_files: overlap,
      });
    }
  }

  const recentEditCutoff = liveCutoff;
  const recentEdits = recentActivity.filter(
    (a) =>
      a.session !== session_id &&
      new Date(a.ts).getTime() > recentEditCutoff &&
      (a.tool === "Edit" || a.tool === "Write") &&
      normalizedFiles.has(
        normalizeFilePath(
          a.path || "",
          sessionById.get(a.session)?.cwd || detectorCwd,
        ),
      ),
  );
  const recentEditSessions = new Set(recentEdits.map((a) => a.session));

  if (conflicts.length === 0 && recentEditSessions.size < 2)
    return text("No conflicts detected. Safe to proceed.");

  let output = "## CONFLICTS DETECTED\n\n";
  if (conflicts.length > 0) {
    output += "### Session Overlaps\n";
    conflicts.forEach((c) => {
      output += `- **${c.session}** (${c.project}): ${c.overlapping_files.join(", ")} \u2014 \"${c.task}\"\n`;
    });
  }
  if (recentEditSessions.size >= 2) {
    output += `\n### Recent Edits (last ${Math.floor(liveWindowMs / 1000)}s)\n`;
    recentEdits.forEach((e) => {
      output += `- ${e.ts} ${e.session}: ${e.tool} ${e.file}\n`;
    });
  }
  output += "\n**Recommendation:** Coordinate before editing these files.";

  appendJSONLineSecure(join(cfg().TERMINALS_DIR, "conflicts.jsonl"), {
    ts: new Date().toISOString(),
    detector: session_id,
    files,
    conflicts: conflicts.map((c) => c.session),
  });
  return text(output);
}
