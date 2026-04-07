/**
 * Agent registry management for custom Claude agents.
 * Supports user/project/local scopes, YAML frontmatter validation,
 * CRUD operations, and MANIFEST.md synchronization.
 * @module agents
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { dirname, join, resolve, relative, basename } from "path";
import { cfg } from "./constants.js";
import { text } from "./helpers.js";
import { ensureSecureDirectory, writeFileSecure } from "./security.js";

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SCOPE_ORDER = ["local", "project", "user"];
const VALID_MEMORY_SCOPES = new Set(["user", "project", "local"]);
const VALID_SCOPES = new Set(["user", "project", "local", "all"]);
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_LIST_ITEMS = 128;
const FRONTMATTER_ALLOWED_KEYS = new Set([
  "name",
  "description",
  "model",
  "tools",
  "allowed-tools",
  "memory",
  "skills",
]);

function json(data) {
  return text(JSON.stringify(data, null, 2));
}

function fail(error_code, message, extra = {}) {
  return json({ ok: false, error_code, message, ...extra });
}

function parseBooleanLike(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return defaultValue;
}

function normalizeScope(scopeRaw, allowAll = false) {
  const raw = String(scopeRaw || (allowAll ? "all" : "project"))
    .trim()
    .toLowerCase();
  if (!VALID_SCOPES.has(raw))
    throw new Error("scope must be one of: local, project, user, all");
  if (!allowAll && raw === "all")
    throw new Error("scope must be one of: local, project, user");
  return raw;
}

function sanitizeAgentId(input, label = "agent_name") {
  const value = String(input || "").trim();
  if (!SAFE_AGENT_ID_RE.test(value))
    throw new Error(`Invalid ${label}. Use letters, numbers, ., _, - only.`);
  return value;
}

function findProjectRoot(startDirRaw) {
  const startDir = resolve(String(startDirRaw || process.cwd()));
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".claude")) || existsSync(join(dir, ".git")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

function scopePaths(projectDirRaw) {
  const projectRoot = findProjectRoot(projectDirRaw);
  const userDir = join(cfg().CLAUDE_DIR, "agents");
  const projectDir = join(projectRoot, ".claude", "agents");
  const localDirs = [
    join(projectRoot, ".claude", "agents.local"),
    join(projectRoot, ".claude", "agents-local"),
    join(projectRoot, ".claude", "agents", "local"),
  ];
  return {
    projectRoot,
    byScope: {
      local: localDirs,
      project: [projectDir],
      user: [userDir],
    },
  };
}

function stripWrappingQuotes(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineArray(value) {
  const raw = String(value || "").trim();
  if (!(raw.startsWith("[") && raw.endsWith("]")))
    return [stripWrappingQuotes(raw)];
  const body = raw.slice(1, -1).trim();
  if (!body) return [];
  const out = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if ((ch === '"' || ch === "'") && body[i - 1] !== "\\") {
      if (!quote) quote = ch;
      else if (quote === ch) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "," && !quote) {
      out.push(stripWrappingQuotes(current));
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(stripWrappingQuotes(current));
  return out.map((v) => String(v).trim()).filter(Boolean);
}

function parseYamlFrontmatter(frontmatterRaw) {
  const lines = String(frontmatterRaw || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = {};
  const seenKeys = new Set();
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    if (!line || /^\s*$/.test(line) || /^\s*#/.test(line)) {
      idx += 1;
      continue;
    }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent !== 0)
      throw new Error(
        `Unsupported indentation in frontmatter (line ${idx + 1}).`,
      );

    const keyMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!keyMatch)
      throw new Error(`Invalid frontmatter syntax (line ${idx + 1}).`);

    const key = keyMatch[1];
    if (seenKeys.has(key))
      throw new Error(`Duplicate frontmatter key: ${key} (line ${idx + 1}).`);
    seenKeys.add(key);
    const rawValue = keyMatch[2] ?? "";
    const trimmedValue = String(rawValue).trim();

    if (!trimmedValue) {
      const list = [];
      let j = idx + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next || /^\s*$/.test(next) || /^\s*#/.test(next)) {
          j += 1;
          continue;
        }
        const nextIndent = next.match(/^(\s*)/)[1].length;
        if (nextIndent === 0) break;
        const itemMatch = next.match(/^\s*-\s+(.*)$/);
        if (!itemMatch)
          throw new Error(`Invalid list item in frontmatter (line ${j + 1}).`);
        const itemText = String(itemMatch[1] || "").trim();
        if (!itemText)
          throw new Error(`Empty list item in frontmatter (line ${j + 1}).`);
        list.push(stripWrappingQuotes(itemText));
        j += 1;
      }
      if (list.length > 0) {
        out[key] = list;
        idx = j;
        continue;
      }
      out[key] = "";
      idx += 1;
      continue;
    }

    if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
      out[key] = parseInlineArray(trimmedValue);
    } else {
      out[key] = stripWrappingQuotes(trimmedValue);
    }
    idx += 1;
  }

  return out;
}

function extractFrontmatter(rawFile) {
  const raw = String(rawFile || "").replace(/\r\n?/g, "\n");
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) throw new Error("Agent file must start with YAML frontmatter.");
  return {
    frontmatterRaw: match[1],
    body: raw.slice(match[0].length),
  };
}

function normalizeStringList(value, fieldName, errors) {
  if (value === undefined) return undefined;
  let arr;
  if (Array.isArray(value)) arr = value;
  else if (typeof value === "string") arr = parseInlineArray(value);
  else {
    errors.push(`${fieldName} must be a list of strings.`);
    return [];
  }
  const normalized = arr
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (normalized.length > MAX_LIST_ITEMS) {
    errors.push(`${fieldName} must contain <= ${MAX_LIST_ITEMS} entries.`);
  }
  const deduped = [];
  const seen = new Set();
  for (const item of normalized) {
    if (item.length > 256)
      errors.push(`${fieldName} entries must be <= 256 chars.`);
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function validateFrontmatter(frontmatter, fallbackName) {
  const errors = [];
  const warnings = [];
  const fm = frontmatter || {};
  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_ALLOWED_KEYS.has(key)) {
      warnings.push(`Unknown frontmatter key ignored: ${key}`);
    }
  }

  const declaredNameRaw = fm.name !== undefined ? String(fm.name).trim() : "";
  const declaredName = declaredNameRaw || fallbackName;
  if (!declaredName) errors.push("name is required in frontmatter.");
  if (declaredName && !SAFE_AGENT_ID_RE.test(declaredName))
    errors.push("name must match [A-Za-z0-9._-]{1,64}.");

  const description =
    fm.description !== undefined ? String(fm.description).trim() : "";
  if (!description) errors.push("description is required in frontmatter.");
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description must be <= ${MAX_DESCRIPTION_LENGTH} chars.`);
  }

  const modelRaw = fm.model !== undefined ? String(fm.model).trim() : "sonnet";
  if (!modelRaw) errors.push("model cannot be empty.");
  if (modelRaw && !SAFE_MODEL_RE.test(modelRaw))
    errors.push("model contains unsupported characters.");

  const tools =
    normalizeStringList(
      fm.tools !== undefined ? fm.tools : fm["allowed-tools"],
      "tools",
      errors,
    ) || [];
  const skills = normalizeStringList(fm.skills, "skills", errors) || [];

  let memory = null;
  if (
    fm.memory !== undefined &&
    fm.memory !== null &&
    String(fm.memory).trim() !== ""
  ) {
    memory = String(fm.memory).trim().toLowerCase();
    if (!VALID_MEMORY_SCOPES.has(memory))
      errors.push("memory must be one of: user, project, local.");
  }

  if (fm.tools === undefined && fm["allowed-tools"] !== undefined) {
    warnings.push("Using allowed-tools alias; tools is preferred.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalized: {
      name: declaredName,
      description,
      model: modelRaw,
      tools,
      memory,
      skills,
    },
  };
}

function validatePromptBody(promptRaw, errors) {
  const prompt = String(promptRaw || "").replace(/\r\n?/g, "\n");
  if (!prompt.trim()) errors.push("prompt body is required.");
  if (prompt.length > MAX_PROMPT_LENGTH) {
    errors.push(`prompt body must be <= ${MAX_PROMPT_LENGTH} chars.`);
  }
  return prompt;
}

function agentPathToDisplay(agentPath, projectRoot) {
  const userAgentsRoot = join(cfg().CLAUDE_DIR, "agents");
  const normalizedAgentPath = resolve(agentPath);
  if (normalizedAgentPath.startsWith(resolve(userAgentsRoot))) {
    return `~/.claude/agents/${basename(normalizedAgentPath)}`;
  }
  const rel = relative(projectRoot, normalizedAgentPath);
  if (rel && !rel.startsWith("..")) return rel;
  return normalizedAgentPath;
}

function scopeRank(scope) {
  const idx = SCOPE_ORDER.indexOf(scope);
  return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
}

function sortByEffectiveOrder(a, b) {
  const keyA = String(a.name || a.id).toLowerCase();
  const keyB = String(b.name || b.id).toLowerCase();
  if (keyA !== keyB) return keyA.localeCompare(keyB);
  const scopeDelta = scopeRank(a.scope) - scopeRank(b.scope);
  if (scopeDelta !== 0) return scopeDelta;
  const sourceDelta = (a.source_rank || 0) - (b.source_rank || 0);
  if (sourceDelta !== 0) return sourceDelta;
  return a.path.localeCompare(b.path);
}

function readAgentFile(agentPath, scope, projectRoot, sourceRank = 0) {
  const id = basename(agentPath).replace(/\.md$/i, "");
  try {
    const stats = statSync(agentPath);
    const raw = readFileSync(agentPath, "utf-8");
    const { frontmatterRaw, body } = extractFrontmatter(raw);
    const frontmatter = parseYamlFrontmatter(frontmatterRaw);
    const validation = validateFrontmatter(frontmatter, id);
    const errors = [...validation.errors];
    const prompt = validatePromptBody(body, errors);
    return {
      id,
      scope,
      source_rank: sourceRank,
      path: agentPath,
      display_path: agentPathToDisplay(agentPath, projectRoot),
      valid: errors.length === 0,
      errors,
      warnings: validation.warnings,
      name: validation.normalized.name,
      description: validation.normalized.description,
      model: validation.normalized.model,
      tools: validation.normalized.tools,
      memory: validation.normalized.memory,
      skills: validation.normalized.skills,
      prompt,
      frontmatter,
      mtime_ms: Number(stats.mtimeMs || 0),
    };
  } catch (err) {
    return {
      id,
      scope,
      source_rank: sourceRank,
      path: agentPath,
      display_path: agentPathToDisplay(agentPath, projectRoot),
      valid: false,
      errors: [String(err.message || err)],
      warnings: [],
      name: id,
      description: "",
      model: "",
      tools: [],
      memory: null,
      skills: [],
      prompt: "",
      frontmatter: {},
      mtime_ms: 0,
    };
  }
}

function collectAgents({
  scope = "all",
  includeInvalid = true,
  includeShadowed = true,
  projectDir,
} = {}) {
  const normalizedScope = normalizeScope(scope, true);
  const { projectRoot, byScope } = scopePaths(projectDir);
  const scopes =
    normalizedScope === "all"
      ? ["local", "project", "user"]
      : [normalizedScope];
  const entries = [];
  const visited = new Set();

  for (const scoped of scopes) {
    const dirs = byScope[scoped] || [];
    for (let dirIndex = 0; dirIndex < dirs.length; dirIndex += 1) {
      const dir = dirs[dirIndex];
      if (!existsSync(dir)) continue;
      let files = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const file of files) {
        const fullPath = join(dir, file);
        if (visited.has(fullPath)) continue;
        visited.add(fullPath);
        entries.push(readAgentFile(fullPath, scoped, projectRoot, dirIndex));
      }
    }
  }

  const sorted = entries.sort(sortByEffectiveOrder);

  const winners = new Map();
  for (const entry of sorted) {
    if (!entry.valid) continue;
    const key = String(entry.name || entry.id).toLowerCase();
    if (!winners.has(key)) winners.set(key, entry.path);
  }

  const filtered = sorted.filter((entry) => {
    if (!includeInvalid && !entry.valid) return false;
    if (!includeShadowed && entry.valid) {
      const key = String(entry.name || entry.id).toLowerCase();
      return winners.get(key) === entry.path;
    }
    return true;
  });

  const counts = {
    total: sorted.length,
    valid: sorted.filter((e) => e.valid).length,
    invalid: sorted.filter((e) => !e.valid).length,
    local: sorted.filter((e) => e.scope === "local").length,
    project: sorted.filter((e) => e.scope === "project").length,
    user: sorted.filter((e) => e.scope === "user").length,
  };

  return {
    projectRoot,
    scope: normalizedScope,
    counts,
    entries: filtered.map((entry) => ({
      ...entry,
      effective:
        entry.valid &&
        winners.get(String(entry.name || entry.id).toLowerCase()) ===
          entry.path,
    })),
  };
}

function findAgentEntriesByName(entries, requestedName) {
  const token = String(requestedName || "")
    .trim()
    .toLowerCase();
  return entries.filter((entry) => {
    const id = String(entry.id || "").toLowerCase();
    const name = String(entry.name || "").toLowerCase();
    return id === token || name === token;
  });
}

function selectEffectiveAgent(entries) {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a, b) => {
    const validDelta = Number(b.valid) - Number(a.valid);
    if (validDelta !== 0) return validDelta;
    const scopeDelta = scopeRank(a.scope) - scopeRank(b.scope);
    if (scopeDelta !== 0) return scopeDelta;
    const sourceDelta = (a.source_rank || 0) - (b.source_rank || 0);
    if (sourceDelta !== 0) return sourceDelta;
    return a.path.localeCompare(b.path);
  });
  return sorted[0] || null;
}

function normalizeMemoryValue(memoryRaw) {
  if (memoryRaw === undefined) return undefined;
  if (memoryRaw === null) return null;
  const trimmed = String(memoryRaw).trim().toLowerCase();
  if (!trimmed) return null;
  if (!VALID_MEMORY_SCOPES.has(trimmed))
    throw new Error("memory must be one of: user, project, local");
  return trimmed;
}

function normalizeModelValue(modelRaw) {
  if (modelRaw === undefined) return undefined;
  const trimmed = String(modelRaw).trim();
  if (!trimmed) throw new Error("model cannot be empty");
  if (!SAFE_MODEL_RE.test(trimmed))
    throw new Error("model contains unsupported characters");
  return trimmed;
}

function normalizeDescriptionValue(descriptionRaw) {
  if (descriptionRaw === undefined) return undefined;
  const trimmed = String(descriptionRaw).trim();
  if (!trimmed) throw new Error("description cannot be empty");
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description must be <= ${MAX_DESCRIPTION_LENGTH} chars`);
  }
  return trimmed;
}

function normalizePromptValue(promptRaw) {
  if (promptRaw === undefined) return undefined;
  const prompt = String(promptRaw).replace(/\r\n?/g, "\n");
  if (!prompt.trim()) throw new Error("prompt cannot be empty");
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt must be <= ${MAX_PROMPT_LENGTH} chars`);
  }
  return prompt;
}

function normalizeListValue(raw, fieldName) {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  let values;
  if (Array.isArray(raw)) values = raw;
  else if (typeof raw === "string") {
    const trimmed = raw.trim();
    values =
      trimmed.startsWith("[") && trimmed.endsWith("]")
        ? parseInlineArray(trimmed)
        : trimmed
          ? trimmed.split(",")
          : [];
  } else {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  const normalized = values
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (normalized.length > MAX_LIST_ITEMS) {
    throw new Error(`${fieldName} must contain <= ${MAX_LIST_ITEMS} entries`);
  }
  for (const value of normalized) {
    if (value.length > 256)
      throw new Error(`${fieldName} entries must be <= 256 chars`);
  }
  const deduped = [];
  const seen = new Set();
  for (const value of normalized) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ""));
}

function serializeAgentMarkdown({
  name,
  description,
  model,
  tools,
  memory,
  skills,
  prompt,
}) {
  const lines = [
    "---",
    `name: ${yamlQuote(name)}`,
    `model: ${yamlQuote(model || "sonnet")}`,
    `description: ${yamlQuote(description)}`,
  ];

  if (Array.isArray(tools) && tools.length > 0) {
    lines.push("tools:");
    for (const tool of tools) lines.push(`  - ${yamlQuote(tool)}`);
  }
  if (memory) lines.push(`memory: ${yamlQuote(memory)}`);
  if (Array.isArray(skills) && skills.length > 0) {
    lines.push("skills:");
    for (const skill of skills) lines.push(`  - ${yamlQuote(skill)}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(
    String(prompt || "")
      .replace(/\r\n?/g, "\n")
      .trimStart(),
  );
  lines.push("");
  return lines.join("\n");
}

function getWriteDirectory(scope, projectDirRaw) {
  const { projectRoot, byScope } = scopePaths(projectDirRaw);
  if (scope === "local") {
    const dir = byScope.local[0];
    ensureSecureDirectory(dirname(dir));
    ensureSecureDirectory(dir);
    return { projectRoot, dir };
  }
  const dir = byScope[scope][0];
  ensureSecureDirectory(dirname(dir));
  ensureSecureDirectory(dir);
  return { projectRoot, dir };
}

function validateDraftAgent({
  name,
  description,
  model,
  tools,
  memory,
  skills,
  prompt,
}) {
  const validation = validateFrontmatter(
    {
      name,
      description,
      model,
      tools,
      memory,
      skills,
    },
    name,
  );
  const errors = [...validation.errors];
  const normalizedPrompt = validatePromptBody(prompt, errors);
  if (errors.length > 0) throw new Error(errors.join(" "));
  return {
    name: validation.normalized.name,
    description: validation.normalized.description,
    model: validation.normalized.model,
    tools: validation.normalized.tools,
    memory: validation.normalized.memory,
    skills: validation.normalized.skills,
    prompt: normalizedPrompt,
  };
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function buildManifestTableRows(entries) {
  const header = [
    "| Agent | File | Model | Memory | Skills | Role |",
    "| ----- | ---- | ----- | ------ | ------ | ---- |",
  ];
  const rows = entries.map((entry) => {
    const skillsText =
      Array.isArray(entry.skills) && entry.skills.length > 0
        ? entry.skills.map((item) => escapeMarkdownCell(item)).join(", ")
        : "—";
    const memoryText = entry.memory || "—";
    const roleText = entry.description || "—";
    return `| ${escapeMarkdownCell(entry.name)} | \`${escapeMarkdownCell(entry.display_path)}\` | ${escapeMarkdownCell(entry.model || "sonnet")} | \`${escapeMarkdownCell(memoryText)}\` | ${skillsText} | ${escapeMarkdownCell(roleText)} |`;
  });
  return [...header, ...rows].join("\n");
}

function replaceManifestAgentsSection(manifestRaw, table) {
  const replacement = `## Agents\n\n${table}\n\n`;
  const pattern = /## Agents[\s\S]*?(?=\n### Worker Role Presets)/m;
  if (!pattern.test(manifestRaw)) {
    throw new Error(
      "Could not locate '## Agents' section before '### Worker Role Presets'.",
    );
  }
  return manifestRaw.replace(pattern, replacement);
}

function syncManifestFromAgents({
  projectDir,
  manifestPathRaw,
  scope = "all",
  includeInvalid = false,
  includeShadowed = false,
  requireManifest = false,
}) {
  const catalog = collectAgents({
    scope,
    includeInvalid,
    includeShadowed,
    projectDir,
  });
  const manifestPath = resolve(
    String(manifestPathRaw || join(catalog.projectRoot, "MANIFEST.md")),
  );
  if (!existsSync(manifestPath)) {
    if (requireManifest) {
      return {
        ok: false,
        error_code: "NOT_FOUND",
        message: `Manifest file not found: ${manifestPath}`,
        manifest_path: manifestPath,
      };
    }
    return {
      ok: true,
      skipped: true,
      reason: "manifest_not_found",
      manifest_path: manifestPath,
      scope: normalizeScope(scope, true),
      include_invalid: includeInvalid,
      include_shadowed: includeShadowed,
      agent_count: 0,
      changed: false,
      project_root: catalog.projectRoot,
    };
  }

  const agents = catalog.entries
    .filter((entry) => includeInvalid || entry.valid)
    .sort(sortByEffectiveOrder);
  const table = buildManifestTableRows(agents);
  const current = readFileSync(manifestPath, "utf-8");
  const updated = replaceManifestAgentsSection(current, table);
  const changed = updated !== current;
  if (changed) writeFileSecure(manifestPath, updated);

  return {
    ok: true,
    action: "synced_manifest",
    manifest_path: manifestPath,
    agent_count: agents.length,
    scope: normalizeScope(scope, true),
    include_invalid: includeInvalid,
    include_shadowed: includeShadowed,
    changed,
    project_root: catalog.projectRoot,
  };
}

function syncManifestBestEffort(projectDir) {
  try {
    return syncManifestFromAgents({
      projectDir,
      scope: "all",
      includeInvalid: false,
      includeShadowed: false,
      requireManifest: false,
    });
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
    };
  }
}

export function handleListAgents(args = {}) {
  try {
    const includeInvalid = parseBooleanLike(args.include_invalid, true);
    const includeShadowed = parseBooleanLike(args.include_shadowed, true);
    const result = collectAgents({
      scope: args.scope || "all",
      includeInvalid,
      includeShadowed,
      projectDir: args.project_dir,
    });
    return json({
      ok: true,
      scope: result.scope,
      project_root: result.projectRoot,
      counts: result.counts,
      agents: result.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        scope: entry.scope,
        path: entry.display_path,
        valid: entry.valid,
        errors: entry.errors,
        warnings: entry.warnings,
        effective: entry.effective,
        model: entry.model,
        description: entry.description,
        tools: entry.tools,
        memory: entry.memory,
        skills: entry.skills,
      })),
    });
  } catch (err) {
    return fail("VALIDATION_ERROR", String(err.message || err));
  }
}

export function handleGetAgent(args = {}) {
  try {
    const requested = sanitizeAgentId(args.agent_name, "agent_name");
    const scope = args.scope ? normalizeScope(args.scope, true) : "all";
    const includePrompt = parseBooleanLike(args.include_prompt, true);
    const includeFrontmatter = parseBooleanLike(args.include_frontmatter, true);
    const result = collectAgents({
      scope,
      includeInvalid: true,
      includeShadowed: true,
      projectDir: args.project_dir,
    });
    const matches = findAgentEntriesByName(result.entries, requested);
    if (matches.length === 0) {
      return fail("NOT_FOUND", `Agent not found: ${requested}`, {
        agent_name: requested,
      });
    }
    const selected =
      scope === "all" ? selectEffectiveAgent(matches) : matches[0];
    const agent = {
      id: selected.id,
      name: selected.name,
      scope: selected.scope,
      path: selected.display_path,
      valid: selected.valid,
      errors: selected.errors,
      warnings: selected.warnings,
      effective: selected.effective,
      model: selected.model,
      description: selected.description,
      tools: selected.tools,
      memory: selected.memory,
      skills: selected.skills,
    };
    if (includePrompt) agent.prompt = selected.prompt;
    if (includeFrontmatter) agent.frontmatter = selected.frontmatter;
    return json({
      ok: true,
      project_root: result.projectRoot,
      agent,
      matches: matches.map((item) => ({
        id: item.id,
        name: item.name,
        scope: item.scope,
        path: item.display_path,
        valid: item.valid,
        effective: item.effective,
      })),
    });
  } catch (err) {
    return fail("VALIDATION_ERROR", String(err.message || err));
  }
}

export function handleCreateAgent(args = {}) {
  try {
    const agentName = sanitizeAgentId(args.agent_name, "agent_name");
    const scope = normalizeScope(args.scope || "project", false);
    const description = normalizeDescriptionValue(args.description);
    if (description === undefined) throw new Error("description is required");
    const model = normalizeModelValue(args.model) || "sonnet";
    const tools = normalizeListValue(args.tools, "tools") || [];
    const skills = normalizeListValue(args.skills, "skills") || [];
    const memory = normalizeMemoryValue(args.memory);
    const prompt =
      normalizePromptValue(args.prompt) ||
      `You are ${agentName}. Follow the role described above.`;
    const overwrite = parseBooleanLike(args.overwrite, false);
    const draft = validateDraftAgent({
      name: agentName,
      description,
      model,
      tools,
      memory,
      skills,
      prompt,
    });

    const { projectRoot, dir } = getWriteDirectory(scope, args.project_dir);
    const filePath = join(dir, `${agentName}.md`);
    if (existsSync(filePath) && !overwrite) {
      return fail(
        "ALREADY_EXISTS",
        `Agent already exists at scope ${scope}: ${agentName}`,
        { scope, path: agentPathToDisplay(filePath, projectRoot) },
      );
    }

    const markdown = serializeAgentMarkdown({
      name: draft.name,
      description: draft.description,
      model: draft.model,
      tools: draft.tools,
      memory: draft.memory,
      skills: draft.skills,
      prompt: draft.prompt,
    });
    writeFileSecure(filePath, markdown);
    const manifestSync = syncManifestBestEffort(projectRoot);
    return json({
      ok: true,
      action: "created",
      agent: {
        id: draft.name,
        name: draft.name,
        scope,
        path: agentPathToDisplay(filePath, projectRoot),
        model: draft.model,
        description: draft.description,
        tools: draft.tools,
        memory: draft.memory,
        skills: draft.skills,
      },
      manifest_sync: manifestSync,
    });
  } catch (err) {
    return fail("VALIDATION_ERROR", String(err.message || err));
  }
}

export function handleUpdateAgent(args = {}) {
  try {
    const requested = sanitizeAgentId(args.agent_name, "agent_name");
    const scope = args.scope ? normalizeScope(args.scope, true) : "all";
    const overwrite = parseBooleanLike(args.overwrite, false);
    const catalog = collectAgents({
      scope,
      includeInvalid: true,
      includeShadowed: true,
      projectDir: args.project_dir,
    });
    const matches = findAgentEntriesByName(catalog.entries, requested);
    if (matches.length === 0)
      return fail("NOT_FOUND", `Agent not found: ${requested}`, {
        agent_name: requested,
      });
    const current =
      scope === "all" ? selectEffectiveAgent(matches) : matches[0];
    if (!current.valid) {
      return fail(
        "INVALID_AGENT_FILE",
        `Agent file is invalid and cannot be updated safely: ${current.display_path}`,
        { errors: current.errors },
      );
    }

    const nextName = args.new_name
      ? sanitizeAgentId(args.new_name, "new_name")
      : current.name;
    const nextDescription =
      normalizeDescriptionValue(args.description) ?? current.description;
    const nextModel = normalizeModelValue(args.model) ?? current.model;
    const nextTools = normalizeListValue(args.tools, "tools") ?? current.tools;
    const nextSkills =
      normalizeListValue(args.skills, "skills") ?? current.skills;
    const memoryUpdate = normalizeMemoryValue(args.memory);
    const nextMemory =
      memoryUpdate !== undefined ? memoryUpdate : current.memory;
    const nextPrompt = normalizePromptValue(args.prompt) ?? current.prompt;
    const draft = validateDraftAgent({
      name: nextName,
      description: nextDescription,
      model: nextModel,
      tools: nextTools,
      memory: nextMemory,
      skills: nextSkills,
      prompt: nextPrompt,
    });

    const { projectRoot, dir } = getWriteDirectory(
      current.scope,
      args.project_dir,
    );
    const targetPath = join(dir, `${draft.name}.md`);
    if (targetPath !== current.path && existsSync(targetPath) && !overwrite) {
      return fail(
        "ALREADY_EXISTS",
        `Target agent already exists: ${draft.name}`,
        { path: agentPathToDisplay(targetPath, projectRoot) },
      );
    }

    const markdown = serializeAgentMarkdown({
      name: draft.name,
      description: draft.description,
      model: draft.model,
      tools: draft.tools,
      memory: draft.memory,
      skills: draft.skills,
      prompt: draft.prompt,
    });
    writeFileSecure(targetPath, markdown);
    if (targetPath !== current.path && existsSync(current.path)) {
      unlinkSync(current.path);
    }
    const manifestSync = syncManifestBestEffort(projectRoot);

    return json({
      ok: true,
      action: "updated",
      previous: {
        id: current.id,
        name: current.name,
        scope: current.scope,
        path: current.display_path,
      },
      agent: {
        id: draft.name,
        name: draft.name,
        scope: current.scope,
        path: agentPathToDisplay(targetPath, projectRoot),
        model: draft.model,
        description: draft.description,
        tools: draft.tools,
        memory: draft.memory,
        skills: draft.skills,
      },
      manifest_sync: manifestSync,
    });
  } catch (err) {
    return fail("VALIDATION_ERROR", String(err.message || err));
  }
}

export function handleDeleteAgent(args = {}) {
  try {
    const requested = sanitizeAgentId(args.agent_name, "agent_name");
    const allScopes = parseBooleanLike(args.all_scopes, false);
    const scope = allScopes
      ? "all"
      : args.scope
        ? normalizeScope(args.scope, true)
        : "all";

    const catalog = collectAgents({
      scope,
      includeInvalid: true,
      includeShadowed: true,
      projectDir: args.project_dir,
    });
    const matches = findAgentEntriesByName(catalog.entries, requested);
    if (matches.length === 0)
      return fail("NOT_FOUND", `Agent not found: ${requested}`, {
        agent_name: requested,
      });

    let targets;
    if (allScopes) targets = matches;
    else if (scope === "all") targets = [selectEffectiveAgent(matches)];
    else targets = [matches[0]];

    const deleted = [];
    for (const target of targets) {
      if (!target || !existsSync(target.path)) continue;
      unlinkSync(target.path);
      deleted.push({
        id: target.id,
        name: target.name,
        scope: target.scope,
        path: target.display_path,
      });
    }
    const manifestSync = syncManifestBestEffort(catalog.projectRoot);

    return json({
      ok: true,
      action: "deleted",
      requested_agent: requested,
      deleted_count: deleted.length,
      deleted,
      manifest_sync: manifestSync,
    });
  } catch (err) {
    return fail("VALIDATION_ERROR", String(err.message || err));
  }
}

export function handleSyncAgentManifest(args = {}) {
  try {
    const includeInvalid = parseBooleanLike(args.include_invalid, false);
    const includeShadowed = parseBooleanLike(args.include_shadowed, false);
    const synced = syncManifestFromAgents({
      projectDir: args.project_dir,
      manifestPathRaw: args.manifest_path,
      scope: args.scope || "all",
      includeInvalid,
      includeShadowed,
      requireManifest: true,
    });
    if (!synced.ok) {
      if (synced.error_code === "NOT_FOUND") {
        return fail("NOT_FOUND", synced.message, {
          manifest_path: synced.manifest_path,
        });
      }
      return fail("VALIDATION_ERROR", synced.message || "Manifest sync failed");
    }
    return json(synced);
  } catch (err) {
    return fail("VALIDATION_ERROR", String(err.message || err));
  }
}
