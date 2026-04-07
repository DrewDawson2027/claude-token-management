/**
 * Session enrichment repair utilities.
 *
 * Repairs sparse `session-*.json` files from the append-only activity log so `/lead`
 * can avoid transcript parsing even when hooks failed to persist full heartbeat state.
 *
 * @module session-hydration
 */

import { existsSync } from "fs";
import { basename } from "path";
import { cfg } from "./constants.js";
import { readJSONL } from "./helpers.js";
import { writeFileSecure } from "./security.js";

const SESSION_SCHEMA_MIN = 2;
const MAX_FILES_TOUCHED = 30;
const MAX_RECENT_OPS = 10;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneSession(session) {
  return isObject(session) ? JSON.parse(JSON.stringify(session)) : {};
}

function totalToolCount(toolCounts) {
  if (!isObject(toolCounts)) return 0;
  return Object.values(toolCounts).reduce(
    (sum, n) => sum + (Number(n) || 0),
    0,
  );
}

export function hasCanonicalEnrichment(session) {
  return (
    Array.isArray(session?.files_touched) &&
    Array.isArray(session?.recent_ops) &&
    isObject(session?.tool_counts) &&
    Number(session?.schema_version || 0) >= SESSION_SCHEMA_MIN
  );
}

function isPlaceholderOnly(session) {
  return (
    hasCanonicalEnrichment(session) &&
    (session.recent_ops?.length || 0) === 0 &&
    (session.files_touched?.length || 0) === 0 &&
    totalToolCount(session.tool_counts) === 0
  );
}

function ensureBaseline(session) {
  let changed = false;
  const out = cloneSession(session);

  if (!isObject(out.tool_counts)) {
    out.tool_counts = {};
    changed = true;
  }
  if (!Array.isArray(out.files_touched)) {
    out.files_touched = [];
    changed = true;
  }
  if (!Array.isArray(out.recent_ops)) {
    out.recent_ops = [];
    changed = true;
  }
  if (!Number.isInteger(out.turn_count) && typeof out.turn_count !== "number") {
    out.turn_count = 0;
    changed = true;
  }
  if (
    !Number.isInteger(out.schema_version) ||
    out.schema_version < SESSION_SCHEMA_MIN
  ) {
    out.schema_version = SESSION_SCHEMA_MIN;
    changed = true;
  }
  if (typeof out.enrichment_status !== "string" || !out.enrichment_status) {
    out.enrichment_status = "seeded";
    changed = true;
  }

  return { session: out, changed };
}

/**
 * Build replay index from `activity.jsonl`, keyed by short session id.
 * @returns {Map<string, object>}
 */
export function buildActivityReplayIndex() {
  const { ACTIVITY_FILE } = cfg();
  const index = new Map();
  if (!existsSync(ACTIVITY_FILE)) return index;

  for (const entry of readJSONL(ACTIVITY_FILE)) {
    const sid = String(entry?.session || "").slice(0, 8);
    if (!sid) continue;

    const tool = String(entry?.tool || "unknown");
    const path = String(entry?.path || "");
    const file = String(entry?.file || (path ? basename(path) : ""));
    const ts = String(entry?.ts || "");

    if (!index.has(sid)) {
      index.set(sid, {
        tool_counts: {},
        files_touched: [],
        recent_ops: [],
        last_active: null,
      });
    }
    const bucket = index.get(sid);

    bucket.tool_counts[tool] = (Number(bucket.tool_counts[tool]) || 0) + 1;
    if ((tool === "Edit" || tool === "Write") && path && path !== "unknown") {
      bucket.files_touched = [
        ...bucket.files_touched.filter((f) => f !== path),
        path,
      ].slice(-MAX_FILES_TOUCHED);
    }
    bucket.recent_ops = [
      ...bucket.recent_ops,
      { t: ts || new Date(0).toISOString(), tool, file },
    ].slice(-MAX_RECENT_OPS);
    if (ts) bucket.last_active = ts;
  }

  return index;
}

/**
 * Hydrate a single session record in memory and optionally persist the repair.
 * @param {object} session
 * @param {string} filePath
 * @param {Map<string, object>} activityIndex
 * @returns {object}
 */
export function hydrateSessionRecord(
  session,
  filePath,
  activityIndex = new Map(),
) {
  const original = cloneSession(session);
  const { session: out, changed: baselineChanged } = ensureBaseline(original);
  let changed = baselineChanged;

  const sid = String(out.session || "").slice(0, 8);
  const replay = sid ? activityIndex.get(sid) : null;
  const sparse = !hasCanonicalEnrichment(original);
  const placeholder = isPlaceholderOnly(out);

  if (replay && (sparse || placeholder)) {
    out.tool_counts = { ...replay.tool_counts };
    out.files_touched = [...replay.files_touched];
    out.recent_ops = [...replay.recent_ops];
    if (
      replay.last_active &&
      (!out.last_active ||
        new Date(replay.last_active).getTime() >
          new Date(out.last_active).getTime())
    ) {
      out.last_active = replay.last_active;
    }
    out.enrichment_status = "hydrated-from-activity";
    out.enrichment_repaired_at = new Date().toISOString();
    changed = true;
  } else if (baselineChanged && out.enrichment_status === "seeded") {
    out.enrichment_repaired_at = new Date().toISOString();
    changed = true;
  }

  if (changed && filePath) {
    try {
      writeFileSecure(filePath, JSON.stringify(out, null, 2));
    } catch (e) {
      process.stderr.write(
        `coord: session hydration persist failed (${basename(filePath)}): ${e.message}\n`,
      );
    }
  }

  return out;
}
