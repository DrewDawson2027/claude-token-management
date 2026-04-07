/**
 * GAP #3 — Agent Color / TUI Identity System
 * Tests: color auto-assignment, cycling, colorName helper, list_sessions Member column.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── helpers ─────────────────────────────────────────────────────────────────

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
  const mod = await import(
    `../index.js?color=${Date.now()}-${Math.random()}`
  );
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

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "coord-color-"));
  const terminals = join(home, ".claude", "terminals");
  mkdirSync(join(terminals, "inbox"), { recursive: true });
  mkdirSync(join(terminals, "results"), { recursive: true });
  mkdirSync(join(terminals, "tasks"), { recursive: true });
  mkdirSync(join(terminals, "teams"), { recursive: true });
  mkdirSync(join(home, ".claude", "session-cache"), { recursive: true });
  return { home, terminals };
}

function textOf(result) {
  return result?.content?.[0]?.text ?? "";
}

// ─── tests ───────────────────────────────────────────────────────────────────

test("new member is auto-assigned a color from the palette", async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleToolCall("coord_create_team", {
      team_name: "color_test",
      members: [{ name: "alice" }],
    });

    const teamFile = join(terminals, "teams", "color_test.json");
    const team = JSON.parse(
      await import("node:fs").then(({ readFileSync }) =>
        readFileSync(teamFile, "utf8"),
      ),
    );
    const alice = team.members.find((m) => m.name === "alice");
    assert.ok(alice, "alice member should exist");
    assert.ok(alice.color, "alice should have a color assigned");
    // palette starts with purple
    assert.strictEqual(alice.color, "purple");
  } finally {
    restore();
  }
});

test("colors cycle through palette for multiple members", async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const palette = [
      "purple",
      "blue",
      "green",
      "red",
      "yellow",
      "cyan",
      "white",
    ];
    api.handleToolCall("coord_create_team", {
      team_name: "multi_color",
      members: palette.map((_, i) => ({ name: `worker${i}` })),
    });

    const teamFile = join(terminals, "teams", "multi_color.json");
    const team = JSON.parse(
      await import("node:fs").then(({ readFileSync }) =>
        readFileSync(teamFile, "utf8"),
      ),
    );
    for (let i = 0; i < palette.length; i++) {
      assert.strictEqual(
        team.members[i].color,
        palette[i],
        `member ${i} should be ${palette[i]}`,
      );
    }
  } finally {
    restore();
  }
});

test("explicit member color is stored in the team roster", async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleToolCall("coord_create_team", {
      team_name: "explicit_color",
      members: [{ name: "violet", color: "purple" }],
    });

    const teamFile = join(terminals, "teams", "explicit_color.json");
    const team = JSON.parse(
      await import("node:fs").then(({ readFileSync }) =>
        readFileSync(teamFile, "utf8"),
      ),
    );
    assert.strictEqual(team.members[0].color, "purple");
  } finally {
    restore();
  }
});

test("8th member wraps back to first palette color", async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    const eightMembers = Array.from({ length: 8 }, (_, i) => ({
      name: `w${i}`,
    }));
    api.handleToolCall("coord_create_team", {
      team_name: "wrap_test",
      members: eightMembers,
    });

    const teamFile = join(terminals, "teams", "wrap_test.json");
    const team = JSON.parse(
      await import("node:fs").then(({ readFileSync }) =>
        readFileSync(teamFile, "utf8"),
      ),
    );
    // index 7 (8th member) should wrap to palette[0] = "purple"
    assert.strictEqual(team.members[7].color, "purple");
  } finally {
    restore();
  }
});

test("coord_get_team output contains ANSI color code for member name", async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    api.handleToolCall("coord_create_team", {
      team_name: "ansi_test",
      members: [{ name: "bob" }],
    });

    const result = api.handleToolCall("coord_get_team", {
      team_name: "ansi_test",
    });
    const txt = textOf(result);
    // purple ANSI code: \x1b[35m
    assert.ok(
      txt.includes("\x1b[35m"),
      "output should contain ANSI color escape for first member (purple)",
    );
    assert.ok(
      txt.includes("bob"),
      "output should contain the member name",
    );
    assert.ok(
      txt.includes("\x1b[0m"),
      "output should contain ANSI reset code",
    );
  } finally {
    restore();
  }
});

test("member with no color field renders without crash (plain name fallback)", async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    // Write a team JSON directly with a member that has no color field
    const teamFile = join(terminals, "teams", "legacy_team.json");
    writeFileSync(
      teamFile,
      JSON.stringify({
        name: "legacy_team",
        project: "test",
        execution_path: "coordinator",
        low_overhead_mode: "advanced",
        members: [
          {
            name: "charlie",
            role: "worker",
            session_id: null,
            task_id: null,
            agentId: null,
            joined: new Date().toISOString(),
            updated: new Date().toISOString(),
            // no color field — legacy member
          },
        ],
        policy: {},
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      }),
    );

    const result = api.handleToolCall("coord_get_team", {
      team_name: "legacy_team",
    });
    const txt = textOf(result);
    assert.ok(txt.includes("charlie"), "charlie name should appear in output");
    // Should not crash — no assertion about ANSI codes
  } finally {
    restore();
  }
});

test("coord_list_sessions Member column shows colored name for team worker", async () => {
  const { home, terminals } = setupHome();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();

    const sessionId = "ab12cd34";
    api.handleToolCall("coord_create_team", {
      team_name: "session_color_team",
      project: "test",
      members: [
        {
          name: "alice",
          role: "worker",
          session_id: sessionId,
          color: "blue",
        },
      ],
    });

    const teamFile = join(terminals, "teams", "session_color_team.json");
    const team = JSON.parse(
      await import("node:fs").then(({ readFileSync }) =>
        readFileSync(teamFile, "utf8"),
      ),
    );
    assert.strictEqual(team.members[0].color, "blue");

    writeFileSync(
      join(terminals, `session-${sessionId}.json`),
      JSON.stringify({
        session: sessionId,
        tty: "/dev/pts/1",
        project: "test",
        status: "active",
        last_active: new Date().toISOString(),
        tool_counts: {},
        files_touched: [],
        recent_ops: [],
      }),
    );

    const result = api.handleToolCall("coord_list_sessions", {});
    const txt = textOf(result);
    assert.ok(txt.includes("Member"), "table header should include Member column");
    // blue ANSI code: \x1b[34m
    assert.ok(
      txt.includes("\x1b[34m"),
      "alice's blue color code should appear in session list",
    );
    assert.ok(txt.includes("alice"), "alice name should appear in session list");
  } finally {
    restore();
  }
});
