import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findIdentityByToken,
  findIdentityRecord,
  identityMapFilePath,
  upsertIdentityRecord,
} from "../lib/identity-map.js";

function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "coord-identity-map-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  process.env.HOME = home;
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    });
}

test("identity-map upserts and merges records across task/session identity", async () =>
  withTempHome(async () => {
    upsertIdentityRecord({
      team_name: "alpha",
      task_id: "W123",
      worker_name: "worker-alpha",
      claude_session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    upsertIdentityRecord({
      team_name: "alpha",
      task_id: "W123",
      agent_id: "agent-xyz",
      agent_name: "agent-alpha",
      pane_id: "%7",
    });
    const found = findIdentityRecord({ task_id: "W123", team_name: "alpha" });
    assert.equal(found?.agent_id, "agent-xyz");
    assert.equal(found?.agent_name, "agent-alpha");
    assert.equal(found?.worker_name, "worker-alpha");
    assert.equal(found?.session_id, "aaaaaaaa");
    assert.equal(found?.pane_id, "%7");
    assert.equal(found?.claude_session_id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    const file = identityMapFilePath();
    assert.equal(existsSync(file), true);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    assert.equal(Array.isArray(parsed.records), true);
    assert.equal(parsed.records.length, 1);
  }));

test("identity-map token lookup resolves by agent_id and session_id", async () =>
  withTempHome(async () => {
    upsertIdentityRecord({
      team_name: "beta",
      agent_id: "agent-123",
      agent_name: "reviewer-bot",
      worker_name: "worker-beta",
      session_id: "feedbeef",
      task_id: "W456",
    });
    const byAgent = findIdentityByToken("agent-123", { team_name: "beta" });
    assert.equal(byAgent?.session_id, "feedbeef");
    const bySession = findIdentityByToken("feedbeef", { team_name: "beta" });
    assert.equal(bySession?.agent_id, "agent-123");
    const byAgentName = findIdentityByToken("reviewer-bot", {
      team_name: "beta",
    });
    assert.equal(byAgentName?.session_id, "feedbeef");
    const byWorkerName = findIdentityByToken("worker-beta", {
      team_name: "beta",
    });
    assert.equal(byWorkerName?.agent_id, "agent-123");
  }));

test("identity-map prefers native identity over legacy token matches", async () =>
  withTempHome(async () => {
    upsertIdentityRecord({
      team_name: "alpha",
      worker_name: "reviewer",
      session_id: "legacy111",
      task_id: "W-legacy",
    });
    upsertIdentityRecord({
      team_name: "alpha",
      agent_id: "agent-native-9",
      agent_name: "reviewer",
      worker_name: "native-reviewer",
      session_id: "native999",
      task_id: "W-native",
    });
    const resolved = findIdentityByToken("reviewer", { team_name: "alpha" });
    assert.equal(resolved?.agent_id, "agent-native-9");
    assert.equal(resolved?.session_id, "native99");
  }));
