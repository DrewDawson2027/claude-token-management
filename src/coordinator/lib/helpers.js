/**
 * Shared utility functions used across coordinator modules.
 * @module helpers
 */

import { readFileSync, existsSync } from "fs";
import { basename } from "path";
import { cfg } from "./constants.js";

/**
 * Read and parse a JSON file, returning null on failure.
 * @param {string} path - File path
 * @returns {object|null} Parsed JSON or null
 */
export function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Shell-quote a string (single-quote with escaping).
 * @param {string} value - Value to quote
 * @returns {string} Shell-safe quoted string
 */
export function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a string for safe use in Windows .bat scripts.
 * Escapes cmd.exe metacharacters: & | > < ^ % !
 * @param {string} value - Value to quote
 * @returns {string} Bat-safe quoted string
 */
export function batQuote(value) {
  const s = String(value ?? "");
  // Escape ^ first (it's the escape char itself), then other metacharacters
  return `"${s.replace(/\^/g, "^^").replace(/&/g, "^&").replace(/\|/g, "^|").replace(/>/g, "^>").replace(/</g, "^<").replace(/%/g, "%%").replace(/!/g, "^^!")}"`;
}

/**
 * Read a JSONL file, returning parsed items with line/byte limiting.
 * @param {string} pathValue - File path
 * @param {number} maxLines - Maximum lines to read
 * @param {number} maxBytes - Maximum bytes to read
 * @returns {{ items: object[], truncated: boolean, totalLines: number }}
 */
export function readJSONLLimited(pathValue, maxLines, maxBytes) {
  const c = cfg();
  if (maxLines === undefined) maxLines = c.MAX_INBOX_LINES;
  if (maxBytes === undefined) maxBytes = c.MAX_INBOX_BYTES;
  try {
    if (!existsSync(pathValue))
      return { items: [], truncated: false, totalLines: 0 };
    let raw = readFileSync(pathValue, "utf-8");
    let truncated = false;
    if (Buffer.byteLength(raw, "utf-8") > maxBytes) {
      raw = raw.slice(0, maxBytes);
      truncated = true;
    }
    const allLines = raw.split("\n").filter(Boolean);
    const lines = allLines.slice(0, maxLines);
    if (allLines.length > maxLines) truncated = true;
    const items = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { items, truncated, totalLines: allLines.length };
  } catch {
    return { items: [], truncated: false, totalLines: 0 };
  }
}

/**
 * Read a JSONL file, returning all parsed items.
 * @param {string} path - File path
 * @returns {object[]} Parsed items
 */
export function readJSONL(path) {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Format an MCP text response.
 * @param {string} content - Response text
 * @returns {{ content: Array<{ type: string, text: string }> }}
 */
export function text(content) {
  return { content: [{ type: "text", text: content }] };
}

/**
 * Human-readable time ago string from an ISO timestamp.
 * @param {string} ts - ISO timestamp
 * @returns {string} e.g., "5m ago", "2h ago"
 */
export function timeAgo(ts) {
  if (!ts) return "unknown";
  const seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
