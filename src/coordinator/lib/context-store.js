/**
 * Shared context store: cross-worker knowledge sharing.
 * File-based storage at ~/.claude/terminals/context/{team_name}.json
 * @module context-store
 */

import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { cfg } from "./constants.js";
import {
  sanitizeName,
  sanitizeShortSessionId,
  writeFileSecure,
  ensureSecureDirectory,
} from "./security.js";
import { readJSON, text } from "./helpers.js";

/**
 * Get the context store directory, ensuring it exists.
 * @returns {string} Context directory path
 */
function contextDir() {
  const dir = join(cfg().TERMINALS_DIR, "context");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try {
      ensureSecureDirectory(dir);
    } catch {}
  }
  return dir;
}

/**
 * Handle coord_write_context tool call.
 * Stores structured context that workers can read on boot.
 * @param {object} args - { team_name, key, value, append }
 * @returns {object} MCP text response
 */
export function handleWriteContext(args) {
  const teamName = sanitizeName(args.team_name || "default", "team_name");
  const key = String(args.key || "").trim();
  const value = String(args.value || "").trim();
  if (!key) return text("Key is required.");
  if (!value) return text("Value is required.");

  const dir = contextDir();
  const file = join(dir, `${teamName}.json`);
  const existing = readJSON(file) || {
    team_name: teamName,
    entries: [],
    created: new Date().toISOString(),
  };

  // Update or add entry
  const idx = existing.entries.findIndex((e) => e.key === key);
  if (idx >= 0) {
    if (args.append) {
      existing.entries[idx].value += "\n" + value;
    } else {
      existing.entries[idx].value = value;
    }
    existing.entries[idx].updated = new Date().toISOString();
  } else {
    existing.entries.push({
      key,
      value,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    });
  }

  existing.updated = new Date().toISOString();

  // Enforce size limit: max 50 entries, max 100KB total
  if (existing.entries.length > 50) {
    existing.entries = existing.entries.slice(-50);
  }
  const totalSize = JSON.stringify(existing).length;
  if (totalSize > 102400) {
    return text(
      `Context store for ${teamName} would exceed 100KB limit. Remove old entries first.`,
    );
  }

  writeFileSecure(file, JSON.stringify(existing, null, 2));
  return text(
    `Context stored: **${key}** in team **${teamName}**\n` +
      `- ${idx >= 0 ? (args.append ? "Appended to" : "Updated") : "Created"} entry\n` +
      `- Total entries: ${existing.entries.length}\n` +
      `- Workers with team_name=${teamName} will receive this context automatically.`,
  );
}

/**
 * Handle coord_export_context tool call.
 * Lead exports conversation context so all workers automatically receive it.
 * @param {object} args - { session_id, summary }
 * @returns {object} MCP text response
 */
export function handleExportContext(args) {
  const sessionId = args.session_id
    ? sanitizeShortSessionId(args.session_id)
    : null;
  const summary = String(args.summary || "").trim();
  if (!summary)
    return text(
      "Summary is required. Describe your current conversation context: decisions made, files analyzed, user requirements, current state.",
    );
  if (!sessionId)
    return text("session_id is required (your 8-char session ID).");

  const dir = contextDir();
  const file = join(dir, `lead-context-${sessionId}.json`);

  const existing = readJSON(file) || {
    session_id: sessionId,
    created: new Date().toISOString(),
  };
  existing.summary = summary;
  existing.updated = new Date().toISOString();

  // Enforce size limit: 50KB max
  if (JSON.stringify(existing).length > 51200) {
    return text("Context summary exceeds 50KB limit. Shorten it.");
  }

  writeFileSecure(file, JSON.stringify(existing, null, 2));
  return text(
    `Lead context exported for session **${sessionId}**\n` +
      `- Summary: ${summary.slice(0, 200)}...\n` +
      `- All workers spawned with notify_session_id=${sessionId} will automatically inherit this context.\n` +
      `- Workers can refresh via: \`coord_read_context include_lead=true\``,
  );
}

/**
 * Handle coord_read_context tool call.
 * Returns all shared context for a team, optionally including lead's exported context.
 * @param {object} args - { team_name, key, include_lead }
 * @returns {object} MCP text response
 */
export function handleReadContext(args) {
  const teamName = sanitizeName(args.team_name || "default", "team_name");
  const dir = contextDir();
  const file = join(dir, `${teamName}.json`);
  const data = readJSON(file);
  const includeLead = Boolean(args.include_lead);

  let output = "";

  // Team context
  if (data?.entries?.length) {
    const filterKey = args.key ? String(args.key).trim() : null;
    const entries = filterKey
      ? data.entries.filter((e) => e.key === filterKey)
      : data.entries;

    if (entries.length > 0) {
      output += `## Shared Context: ${teamName}\n\n`;
      output += `Last updated: ${data.updated}\n\n`;
      for (const e of entries) {
        output += `### ${e.key}\n${e.value}\n\n`;
      }
    }
  }

  // Lead context (from coord_export_context)
  if (includeLead) {
    try {
      const leadFiles = readdirSync(dir).filter(
        (f) => f.startsWith("lead-context-") && f.endsWith(".json"),
      );
      for (const lf of leadFiles) {
        const leadCtx = readJSON(join(dir, lf));
        if (leadCtx?.summary) {
          output += `## Lead's Conversation Context (${leadCtx.session_id || "unknown"})\n\n`;
          output += `Updated: ${leadCtx.updated}\n\n`;
          output += `${leadCtx.summary}\n\n`;
        }
      }
    } catch (e) {
      process.stderr.write(
        `[context-store] lead context build error: ${e?.message ?? e}\n`,
      );
    }
  }

  if (!output) {
    return text(
      `No context found${includeLead ? " (including lead context)" : ""} for team ${teamName}.`,
    );
  }

  return text(output);
}
