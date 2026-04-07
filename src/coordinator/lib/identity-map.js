/**
 * Persistent identity map for joining native/coordinator identities.
 * @module identity-map
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const MAP_VERSION = 1;
const DEFAULT_MAX_RECORDS = 2000;

const IDENTITY_FIELDS = [
  "agent_id",
  "agent_name",
  "worker_name",
  "session_id",
  "task_id",
  "pane_id",
  "claude_session_id",
];

function defaultMap() {
  return {
    version: MAP_VERSION,
    updated_at: null,
    records: [],
  };
}

function normalizeString(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function normalizeSessionId(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  return raw.length > 8 ? raw.slice(0, 8) : raw;
}

function normalizeRecord(raw = {}) {
  const normalizedClaudeSessionId = normalizeString(raw.claude_session_id);
  return {
    team_name: normalizeString(raw.team_name),
    agent_id: normalizeString(raw.agent_id),
    agent_name: normalizeString(raw.agent_name),
    worker_name: normalizeString(raw.worker_name),
    session_id: normalizeSessionId(raw.session_id || normalizedClaudeSessionId),
    task_id: normalizeString(raw.task_id),
    pane_id: normalizeString(raw.pane_id),
    claude_session_id: normalizedClaudeSessionId,
    source: normalizeString(raw.source),
    created_at: normalizeString(raw.created_at),
    updated_at: normalizeString(raw.updated_at),
  };
}

function hasIdentity(record) {
  return IDENTITY_FIELDS.some((field) => Boolean(record[field]));
}

function sharesIdentity(a, b) {
  for (const field of IDENTITY_FIELDS) {
    if (a[field] && b[field] && a[field] === b[field]) return true;
  }
  return false;
}

function mergeRecords(records, { source = null, now } = {}) {
  const out = normalizeRecord({});
  for (const rec of records) {
    const normalized = normalizeRecord(rec);
    if (normalized.team_name) out.team_name = normalized.team_name;
    if (normalized.agent_name) out.agent_name = normalized.agent_name;
    if (normalized.worker_name) out.worker_name = normalized.worker_name;
    for (const field of IDENTITY_FIELDS) {
      if (normalized[field]) out[field] = normalized[field];
    }
    if (normalized.source) out.source = normalized.source;
  }
  if (source) out.source = normalizeString(source);
  const createdCandidates = records
    .map((r) => normalizeString(r.created_at))
    .filter(Boolean)
    .sort();
  out.created_at = createdCandidates[0] || now;
  out.updated_at = now;
  return out;
}

function compareByUpdatedDesc(a, b) {
  return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
}

function nativeIdentityStrength(record) {
  let strength = 0;
  if (record?.agent_id) strength += 8;
  if (record?.claude_session_id) strength += 6;
  if (record?.session_id) strength += 4;
  if (record?.worker_name) strength += 2;
  if (record?.task_id) strength += 1;
  return strength;
}

function shouldPreferRecord(candidate, current, candidateScore, currentScore) {
  if (!candidate) return false;
  if (!current) return true;
  if (candidateScore > currentScore) return true;
  if (candidateScore < currentScore) return false;
  if (candidateScore <= 0) return false;
  const candidateStrength = nativeIdentityStrength(candidate);
  const currentStrength = nativeIdentityStrength(current);
  if (candidateStrength > currentStrength) return true;
  if (candidateStrength < currentStrength) return false;
  return (
    String(candidate.updated_at || "").localeCompare(
      String(current.updated_at || ""),
    ) > 0
  );
}

function ensureMapDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function writeMapAtomic(filePath, map) {
  ensureMapDir(filePath);
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, filePath);
}

export function identityMapFilePath() {
  const home = process.env.HOME || homedir();
  return join(home, ".claude", "lead-sidecar", "state", "identity-map.json");
}

export function readIdentityMap({ filePath = identityMapFilePath() } = {}) {
  if (!existsSync(filePath)) return defaultMap();
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    const records = Array.isArray(parsed?.records)
      ? parsed.records.map((r) => normalizeRecord(r)).filter(hasIdentity)
      : [];
    return {
      version: Number(parsed?.version) || MAP_VERSION,
      updated_at: normalizeString(parsed?.updated_at),
      records: records.sort(compareByUpdatedDesc),
    };
  } catch {
    return defaultMap();
  }
}

export function upsertIdentityRecords(
  inputRecords = [],
  {
    filePath = identityMapFilePath(),
    source = null,
    maxRecords = DEFAULT_MAX_RECORDS,
  } = {},
) {
  const incoming = (Array.isArray(inputRecords) ? inputRecords : [inputRecords])
    .map((r) => normalizeRecord(r))
    .filter(hasIdentity);
  if (incoming.length === 0) {
    return { map: readIdentityMap({ filePath }), merged: [] };
  }

  const now = new Date().toISOString();
  const map = readIdentityMap({ filePath });
  let existing = [...map.records];
  const merged = [];

  for (const rec of incoming) {
    let group = [rec];
    let changed = true;
    while (changed) {
      changed = false;
      const remaining = [];
      for (const candidate of existing) {
        if (group.some((g) => sharesIdentity(g, candidate))) {
          group.push(candidate);
          changed = true;
        } else {
          remaining.push(candidate);
        }
      }
      existing = remaining;
    }
    const next = mergeRecords(group, { source, now });
    existing.push(next);
    merged.push(next);
  }

  const deduped = [];
  for (const rec of existing.sort(compareByUpdatedDesc)) {
    if (deduped.some((d) => sharesIdentity(d, rec))) {
      const existingRec = deduped.find((d) => sharesIdentity(d, rec));
      const mergedRec = mergeRecords([existingRec, rec], { now });
      Object.assign(existingRec, mergedRec);
      continue;
    }
    deduped.push(rec);
  }

  const nextMap = {
    version: MAP_VERSION,
    updated_at: now,
    records: deduped.sort(compareByUpdatedDesc).slice(0, maxRecords),
  };
  writeMapAtomic(filePath, nextMap);
  return { map: nextMap, merged };
}

export function upsertIdentityRecord(record, opts = {}) {
  const out = upsertIdentityRecords([record], opts);
  return out.merged[0] || null;
}

function scoreMatch(record, query) {
  let score = 0;
  if (query.team_name) {
    if (record.team_name === query.team_name) score += 2;
    else score -= 1;
  }
  for (const field of IDENTITY_FIELDS) {
    const q = query[field];
    if (!q) continue;
    if (record[field] === q) {
      if (field === "agent_id") score += 10;
      else if (field === "claude_session_id") score += 9;
      else if (field === "agent_name" || field === "worker_name") score += 7;
      else score += 6;
    } else score -= 2;
  }
  return score;
}

export function findIdentityRecord(
  query = {},
  { filePath = identityMapFilePath() } = {},
) {
  const normalizedQuery = normalizeRecord(query);
  if (
    !normalizedQuery.team_name &&
    !IDENTITY_FIELDS.some((f) => normalizedQuery[f])
  )
    return null;

  const map = readIdentityMap({ filePath });
  let best = null;
  let bestScore = 0;
  for (const rec of map.records) {
    const score = scoreMatch(rec, normalizedQuery);
    if (shouldPreferRecord(rec, best, score, bestScore)) {
      best = rec;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

export function findIdentityByToken(
  token,
  { team_name = null, filePath = identityMapFilePath() } = {},
) {
  const raw = normalizeString(token);
  if (!raw) return null;
  const short = normalizeSessionId(raw);
  const map = readIdentityMap({ filePath });
  let best = null;
  let bestScore = 0;

  for (const rec of map.records) {
    let score = 0;
    if (team_name) {
      if (rec.team_name === team_name) score += 2;
      else score -= 1;
    }
    if (rec.agent_id === raw) score += 8;
    if (rec.agent_name === raw) score += 7;
    if (rec.worker_name === raw) score += 7;
    if (rec.task_id === raw) score += 7;
    if (rec.claude_session_id === raw) score += 7;
    if (rec.session_id === short) score += 6;
    if (rec.pane_id === raw) score += 4;
    if (shouldPreferRecord(rec, best, score, bestScore)) {
      best = rec;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

export { IDENTITY_FIELDS };
