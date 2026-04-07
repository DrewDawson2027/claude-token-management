import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "coord-agents-"));
  const terminals = join(home, ".claude", "terminals");
  mkdirSync(join(terminals, "inbox"), { recursive: true });
  mkdirSync(join(terminals, "results"), { recursive: true });
  mkdirSync(join(terminals, "tasks"), { recursive: true });
  mkdirSync(join(terminals, "teams"), { recursive: true });
  mkdirSync(join(home, ".claude", "session-cache"), { recursive: true });
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });

  const projectDir = join(home, "project");
  mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
  mkdirSync(join(projectDir, ".claude", "agents.local"), { recursive: true });
  return { home, projectDir };
}

async function loadForTest(home) {
  const prev = {
    HOME: process.env.HOME,
    COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE,
    COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM,
    COORDINATOR_CLAUDE_BIN: process.env.COORDINATOR_CLAUDE_BIN,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "linux";
  process.env.COORDINATOR_CLAUDE_BIN = "echo";
  const mod = await import(`../index.js?agents=${Date.now()}-${Math.random()}`);
  return {
    api: mod.__test__,
    restore: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

function textOf(result) {
  return result?.content?.[0]?.text || "";
}

function jsonOf(result) {
  return JSON.parse(textOf(result));
}

function writeAgent(path, {
  name,
  model = "sonnet",
  description = "agent description",
  tools = [],
  memory,
  skills = [],
  prompt = "You are an agent.",
}) {
  const lines = [
    "---",
    `name: "${name}"`,
    `model: "${model}"`,
    `description: "${description}"`,
  ];
  if (tools.length) {
    lines.push("tools:");
    for (const t of tools) lines.push(`  - "${t}"`);
  }
  if (memory) lines.push(`memory: "${memory}"`);
  if (skills.length) {
    lines.push("skills:");
    for (const s of skills) lines.push(`  - "${s}"`);
  }
  lines.push("---", "", prompt, "");
  writeFileSync(path, lines.join("\n"));
}

test("agents: list validates valid/invalid agent files", async () => {
  const { home, projectDir } = setupHome();
  const userAgents = join(home, ".claude", "agents");
  const projectAgents = join(projectDir, ".claude", "agents");
  writeAgent(join(projectAgents, "valid-agent.md"), {
    name: "valid-agent",
    description: "Valid project agent",
    tools: ["Read", "Edit"],
    memory: "project",
    skills: ["codebase-overview"],
  });
  writeFileSync(
    join(userAgents, "invalid-agent.md"),
    [
      "---",
      'name: "invalid-agent"',
      'model: "sonnet"',
      'description: "bad memory scope"',
      'memory: "planet"',
      "---",
      "",
      "Bad file",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(projectAgents, "duplicate-key.md"),
    [
      "---",
      'name: "duplicate-key"',
      'name: "duplicate-key-again"',
      'model: "sonnet"',
      'description: "bad duplicate key"',
      "---",
      "",
      "Prompt body",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(projectAgents, "empty-prompt.md"),
    [
      "---",
      'name: "empty-prompt"',
      'model: "sonnet"',
      'description: "missing prompt body"',
      "---",
      "",
      "   ",
      "",
    ].join("\n"),
  );

  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const out = jsonOf(
      api.handleToolCall("coord_list_agents", {
        scope: "all",
        project_dir: projectDir,
        include_invalid: true,
      }),
    );
    assert.equal(out.ok, true);
    assert.equal(out.counts.total, 4);
    assert.equal(out.counts.valid, 1);
    assert.equal(out.counts.invalid, 3);
    const invalid = out.agents.find((a) => a.name === "invalid-agent");
    assert.equal(Boolean(invalid), true);
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors.join(" "), /memory must be one of/i);
    const duplicate = out.agents.find((a) => a.id === "duplicate-key");
    assert.equal(duplicate.valid, false);
    assert.match(duplicate.errors.join(" "), /Duplicate frontmatter key/i);
    const emptyPrompt = out.agents.find((a) => a.id === "empty-prompt");
    assert.equal(emptyPrompt.valid, false);
    assert.match(emptyPrompt.errors.join(" "), /prompt body is required/i);
  } finally {
    restore();
  }
});

test("agents: scope resolution prefers local > project > user", async () => {
  const { home, projectDir } = setupHome();
  const userAgents = join(home, ".claude", "agents");
  const projectAgents = join(projectDir, ".claude", "agents");
  const localAgents = join(projectDir, ".claude", "agents.local");
  writeAgent(join(userAgents, "shared-agent.md"), {
    name: "shared-agent",
    description: "from user scope",
  });
  writeAgent(join(projectAgents, "shared-agent.md"), {
    name: "shared-agent",
    description: "from project scope",
  });
  writeAgent(join(localAgents, "shared-agent.md"), {
    name: "shared-agent",
    description: "from local scope",
  });

  const { api, restore } = await loadForTest(home);
  try {
    const getOut = jsonOf(
      api.handleToolCall("coord_get_agent", {
        agent_name: "shared-agent",
        project_dir: projectDir,
      }),
    );
    assert.equal(getOut.ok, true);
    assert.equal(getOut.agent.scope, "local");
    assert.equal(getOut.agent.description, "from local scope");

    const listOut = jsonOf(
      api.handleToolCall("coord_list_agents", {
        scope: "all",
        project_dir: projectDir,
        include_invalid: false,
        include_shadowed: false,
      }),
    );
    const shared = listOut.agents.filter((a) => a.name === "shared-agent");
    assert.equal(shared.length, 1);
    assert.equal(shared[0].scope, "local");
    assert.equal(shared[0].effective, true);
  } finally {
    restore();
  }
});

test("agents: deterministic local alias precedence uses agents.local first", async () => {
  const { home, projectDir } = setupHome();
  const localPreferred = join(projectDir, ".claude", "agents.local");
  const localFallback = join(projectDir, ".claude", "agents-local");
  mkdirSync(localFallback, { recursive: true });

  writeAgent(join(localPreferred, "alias-shadow.md"), {
    name: "alias-shadow",
    description: "preferred local directory",
  });
  writeAgent(join(localFallback, "alias-shadow.md"), {
    name: "alias-shadow",
    description: "fallback local directory",
  });

  const { api, restore } = await loadForTest(home);
  try {
    const out = jsonOf(
      api.handleToolCall("coord_get_agent", {
        agent_name: "alias-shadow",
        scope: "all",
        project_dir: projectDir,
      }),
    );
    assert.equal(out.ok, true);
    assert.equal(out.agent.scope, "local");
    assert.equal(out.agent.description, "preferred local directory");
  } finally {
    restore();
  }
});

test("agents: scope=all get/update/delete targets effective winner only", async () => {
  const { home, projectDir } = setupHome();
  const userAgents = join(home, ".claude", "agents");
  const projectAgents = join(projectDir, ".claude", "agents");
  const localAgents = join(projectDir, ".claude", "agents.local");

  writeAgent(join(userAgents, "all-scope.md"), {
    name: "all-scope",
    description: "user value",
  });
  writeAgent(join(projectAgents, "all-scope.md"), {
    name: "all-scope",
    description: "project value",
  });
  writeAgent(join(localAgents, "all-scope.md"), {
    name: "all-scope",
    description: "local value",
  });

  const { api, restore } = await loadForTest(home);
  try {
    const fetched = jsonOf(
      api.handleToolCall("coord_get_agent", {
        agent_name: "all-scope",
        scope: "all",
        project_dir: projectDir,
      }),
    );
    assert.equal(fetched.ok, true);
    assert.equal(fetched.agent.scope, "local");
    assert.equal(fetched.agent.description, "local value");

    const updated = jsonOf(
      api.handleToolCall("coord_update_agent", {
        agent_name: "all-scope",
        scope: "all",
        description: "local updated",
        project_dir: projectDir,
      }),
    );
    assert.equal(updated.ok, true);
    assert.equal(updated.agent.scope, "local");
    assert.equal(updated.agent.description, "local updated");

    const projectStillSame = jsonOf(
      api.handleToolCall("coord_get_agent", {
        agent_name: "all-scope",
        scope: "project",
        project_dir: projectDir,
      }),
    );
    assert.equal(projectStillSame.ok, true);
    assert.equal(projectStillSame.agent.description, "project value");

    const deleted = jsonOf(
      api.handleToolCall("coord_delete_agent", {
        agent_name: "all-scope",
        scope: "all",
        project_dir: projectDir,
      }),
    );
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted_count, 1);
    assert.equal(deleted.deleted[0].scope, "local");

    const winnerAfterDelete = jsonOf(
      api.handleToolCall("coord_get_agent", {
        agent_name: "all-scope",
        scope: "all",
        project_dir: projectDir,
      }),
    );
    assert.equal(winnerAfterDelete.ok, true);
    assert.equal(winnerAfterDelete.agent.scope, "project");
    assert.equal(winnerAfterDelete.agent.description, "project value");
  } finally {
    restore();
  }
});

test("agents: manifest sync rewrites Agents table", async () => {
  const { home, projectDir } = setupHome();
  const projectAgents = join(projectDir, ".claude", "agents");
  writeAgent(join(projectAgents, "architect.md"), {
    name: "architect",
    description: "Architecture planning",
    memory: "project",
    skills: ["architecture"],
  });
  writeAgent(join(projectAgents, "reviewer.md"), {
    name: "reviewer",
    description: "Review implementation",
    tools: ["Read", "Grep"],
  });

  const manifestPath = join(projectDir, "MANIFEST.md");
  writeFileSync(
    manifestPath,
    [
      "# Test Manifest",
      "",
      "## Agents",
      "",
      "OLD CONTENT",
      "",
      "### Worker Role Presets",
      "",
      "placeholder",
      "",
    ].join("\n"),
  );

  const { api, restore } = await loadForTest(home);
  try {
    const syncOut = jsonOf(
      api.handleToolCall("coord_sync_agent_manifest", {
        project_dir: projectDir,
        manifest_path: manifestPath,
        scope: "all",
      }),
    );
    assert.equal(syncOut.ok, true);
    assert.equal(syncOut.action, "synced_manifest");
    const manifest = readFileSync(manifestPath, "utf-8");
    assert.doesNotMatch(manifest, /OLD CONTENT/);
    assert.match(manifest, /\| Agent \| File \| Model \| Memory \| Skills \| Role \|/);
    assert.match(manifest, /\| architect \|/);
    assert.match(manifest, /\| reviewer \|/);

    const missingManifest = jsonOf(
      api.handleToolCall("coord_sync_agent_manifest", {
        project_dir: projectDir,
        manifest_path: join(projectDir, "MISSING.md"),
      }),
    );
    assert.equal(missingManifest.ok, false);
    assert.equal(missingManifest.error_code, "NOT_FOUND");
  } finally {
    restore();
  }
});

test("agents: create/update/delete round-trip edits", async () => {
  const { home, projectDir } = setupHome();
  const manifestPath = join(projectDir, "MANIFEST.md");
  writeFileSync(
    manifestPath,
    [
      "# Test Manifest",
      "",
      "## Agents",
      "",
      "OLD",
      "",
      "### Worker Role Presets",
      "",
      "placeholder",
      "",
    ].join("\n"),
  );
  const { api, restore } = await loadForTest(home);
  try {
    const created = jsonOf(
      api.handleToolCall("coord_create_agent", {
        project_dir: projectDir,
        scope: "project",
        agent_name: "roundtrip",
        description: "Initial description",
        model: "sonnet",
        tools: ["Read", "Edit"],
        memory: "local",
        skills: ["qa"],
        prompt: "Initial prompt body.",
      }),
    );
    assert.equal(created.ok, true);
    assert.equal(created.agent.name, "roundtrip");
    assert.equal(created.manifest_sync.ok, true);
    const manifestAfterCreate = readFileSync(manifestPath, "utf-8");
    assert.match(manifestAfterCreate, /\| roundtrip \|/);

    const fetched = jsonOf(
      api.handleToolCall("coord_get_agent", {
        project_dir: projectDir,
        agent_name: "roundtrip",
      }),
    );
    assert.equal(fetched.ok, true);
    assert.equal(fetched.agent.model, "sonnet");
    assert.deepEqual(fetched.agent.tools, ["Read", "Edit"]);
    assert.equal(fetched.agent.memory, "local");
    assert.deepEqual(fetched.agent.skills, ["qa"]);
    assert.match(fetched.agent.prompt, /Initial prompt body/);
    assert.equal(typeof fetched.agent.frontmatter, "object");

    const summaryOnly = jsonOf(
      api.handleToolCall("coord_get_agent", {
        project_dir: projectDir,
        agent_name: "roundtrip",
        include_prompt: false,
        include_frontmatter: false,
      }),
    );
    assert.equal(summaryOnly.ok, true);
    assert.equal(summaryOnly.agent.name, "roundtrip");
    assert.equal("prompt" in summaryOnly.agent, false);
    assert.equal("frontmatter" in summaryOnly.agent, false);

    const updated = jsonOf(
      api.handleToolCall("coord_update_agent", {
        project_dir: projectDir,
        agent_name: "roundtrip",
        scope: "project",
        new_name: "roundtrip-v2",
        description: "Updated description",
        model: "opus",
        tools: ["Read", "Write"],
        skills: ["qa", "security-review"],
        prompt: "Updated prompt body.",
      }),
    );
    assert.equal(updated.ok, true);
    assert.equal(updated.agent.name, "roundtrip-v2");
    assert.equal(updated.manifest_sync.ok, true);

    const oldLookup = jsonOf(
      api.handleToolCall("coord_get_agent", {
        project_dir: projectDir,
        agent_name: "roundtrip",
      }),
    );
    assert.equal(oldLookup.ok, false);
    assert.equal(oldLookup.error_code, "NOT_FOUND");

    const newLookup = jsonOf(
      api.handleToolCall("coord_get_agent", {
        project_dir: projectDir,
        agent_name: "roundtrip-v2",
      }),
    );
    assert.equal(newLookup.ok, true);
    assert.equal(newLookup.agent.description, "Updated description");
    assert.equal(newLookup.agent.model, "opus");
    assert.deepEqual(newLookup.agent.tools, ["Read", "Write"]);
    assert.deepEqual(newLookup.agent.skills, ["qa", "security-review"]);
    assert.match(newLookup.agent.prompt, /Updated prompt body/);

    const deleted = jsonOf(
      api.handleToolCall("coord_delete_agent", {
        project_dir: projectDir,
        scope: "project",
        agent_name: "roundtrip-v2",
      }),
    );
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted_count, 1);
    assert.equal(deleted.manifest_sync.ok, true);
    const manifestAfterDelete = readFileSync(manifestPath, "utf-8");
    assert.doesNotMatch(manifestAfterDelete, /\| roundtrip-v2 \|/);

    const invalidCreate = jsonOf(
      api.handleToolCall("coord_create_agent", {
        project_dir: projectDir,
        scope: "project",
        agent_name: "bad-memory",
        description: "Invalid memory test",
        memory: "galaxy",
      }),
    );
    assert.equal(invalidCreate.ok, false);
    assert.equal(invalidCreate.error_code, "VALIDATION_ERROR");

    const invalidPrompt = jsonOf(
      api.handleToolCall("coord_create_agent", {
        project_dir: projectDir,
        scope: "project",
        agent_name: "bad-prompt",
        description: "Invalid prompt test",
        prompt: "   ",
      }),
    );
    assert.equal(invalidPrompt.ok, false);
    assert.equal(invalidPrompt.error_code, "VALIDATION_ERROR");
    assert.match(invalidPrompt.message, /prompt/i);
  } finally {
    restore();
  }
});
