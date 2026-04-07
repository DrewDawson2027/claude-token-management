import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function loadForTest(home) {
  const prev = {
    HOME: process.env.HOME,
    COORDINATOR_TEST_MODE: process.env.COORDINATOR_TEST_MODE,
    COORDINATOR_PLATFORM: process.env.COORDINATOR_PLATFORM,
    COORDINATOR_CLAUDE_BIN: process.env.COORDINATOR_CLAUDE_BIN,
    LEAD_AB_HARNESS_SUMMARY: process.env.LEAD_AB_HARNESS_SUMMARY,
    LEAD_AB_HARNESS_ROOT: process.env.LEAD_AB_HARNESS_ROOT,
  };
  process.env.HOME = home;
  process.env.COORDINATOR_TEST_MODE = "1";
  process.env.COORDINATOR_PLATFORM = "linux";
  process.env.COORDINATOR_CLAUDE_BIN = "echo";
  const mod = await import(`../index.js?cost=${Date.now()}-${Math.random()}`);
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
  const home = mkdtempSync(join(tmpdir(), "coord-cost-"));
  const terminals = join(home, ".claude", "terminals");
  const results = join(terminals, "results");
  const inbox = join(terminals, "inbox");
  const sessionCache = join(home, ".claude", "session-cache");
  mkdirSync(results, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  mkdirSync(sessionCache, { recursive: true });
  return { home, terminals, results };
}

/**
 * Create a temp summary.json and return its path.
 * LEAD_AB_HARNESS_SUMMARY is set to this path in each test.
 */
function makeSummaryFile(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "coord-ab-"));
  const runDir = join(dir, "run-001");
  mkdirSync(runDir, { recursive: true });
  const summaryPath = join(runDir, "summary.json");
  const summary = {
    run_id: "test-run-001",
    generated_at: "2026-03-12T00:00:00Z",
    workload: { id: "test-workload" },
    trials: 10,
    baseline_path: "native",
    summary: {
      per_path: {},
      comparisons_vs_baseline: {},
    },
    claim_safe_summary: {
      statements: [],
      policy: [],
    },
    ...overrides,
  };
  writeFileSync(summaryPath, JSON.stringify(summary));
  return summaryPath;
}

test("handleCostComparison returns no-harness message when no summary found", async () => {
  const { home } = setupHome();
  const { api, restore } = await loadForTest(home);
  // Route harness root to an empty dir so cwd-relative paths are not found
  const emptyRoot = mkdtempSync(join(tmpdir(), "coord-ab-empty-"));
  try {
    api.ensureDirsOnce();
    process.env.LEAD_AB_HARNESS_ROOT = emptyRoot;
    delete process.env.LEAD_AB_HARNESS_SUMMARY;
    const result = api.handleToolCall("coord_cost_comparison", {});
    const txt = result?.content?.[0]?.text || "";
    assert.match(txt, /No measured A\/B harness summary found/);
    assert.match(txt, /No cheaper-than-native claim is allowed/);
  } finally {
    restore();
  }
});

test("handleCostComparison renders measured report header with valid summary", async () => {
  const { home } = setupHome();
  const summaryPath = makeSummaryFile();
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    process.env.LEAD_AB_HARNESS_SUMMARY = summaryPath;
    const result = api.handleToolCall("coord_cost_comparison", {});
    const txt = result?.content?.[0]?.text || "";
    assert.match(txt, /Measured A\/B Comparison/);
    assert.match(txt, /Harness Evidence/);
    assert.match(txt, /test-run-001/);
  } finally {
    restore();
  }
});

test("handleCostComparison renders path metrics when per_path data present", async () => {
  const { home } = setupHome();
  const summaryPath = makeSummaryFile({
    summary: {
      per_path: {
        lead: {
          completion_rate: {
            mean: 0.9,
            ci_low: 0.8,
            ci_high: 1.0,
            successes: 9,
            total: 10,
          },
          latency_ms: { mean: 1200, ci_low: 1100, ci_high: 1300 },
          tokens_total: { mean: 50000, ci_low: 45000, ci_high: 55000 },
        },
      },
      comparisons_vs_baseline: {},
    },
  });
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    process.env.LEAD_AB_HARNESS_SUMMARY = summaryPath;
    const result = api.handleToolCall("coord_cost_comparison", {});
    const txt = result?.content?.[0]?.text || "";
    assert.match(txt, /Path Metrics/);
    assert.match(txt, /lead/);
    assert.match(txt, /1200/);
  } finally {
    restore();
  }
});

test("handleCostComparison renders claim-safe statements when present", async () => {
  const { home } = setupHome();
  const summaryPath = makeSummaryFile({
    claim_safe_summary: {
      statements: [
        "Filesystem coordination overhead: verified zero API-token cost on coordination path.",
      ],
      policy: [],
    },
  });
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    process.env.LEAD_AB_HARNESS_SUMMARY = summaryPath;
    const result = api.handleToolCall("coord_cost_comparison", {});
    const txt = result?.content?.[0]?.text || "";
    assert.match(txt, /Claim-safe Summary/);
    assert.match(txt, /Filesystem coordination overhead/);
  } finally {
    restore();
  }
});

test("handleCostComparison renders savings claim gate with policy block", async () => {
  const { home } = setupHome();
  const summaryPath = makeSummaryFile({
    claim_safe_summary: {
      statements: [],
      policy: [
        {
          path_id: "lead",
          savings_claim_allowed: false,
          reason: "insufficient trials",
        },
      ],
    },
  });
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    process.env.LEAD_AB_HARNESS_SUMMARY = summaryPath;
    const result = api.handleToolCall("coord_cost_comparison", {});
    const txt = result?.content?.[0]?.text || "";
    assert.match(txt, /Savings Claim Gate/);
    assert.match(txt, /savings_claim_allowed=false/);
    assert.match(txt, /insufficient trials/);
  } finally {
    restore();
  }
});

test("handleCostComparison shows no-policy message when policy block is empty", async () => {
  const { home } = setupHome();
  const summaryPath = makeSummaryFile({
    claim_safe_summary: { statements: [], policy: [] },
  });
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    process.env.LEAD_AB_HARNESS_SUMMARY = summaryPath;
    const result = api.handleToolCall("coord_cost_comparison", {});
    const txt = result?.content?.[0]?.text || "";
    assert.match(txt, /No policy block found/);
    assert.match(txt, /Savings claims are not allowed/);
  } finally {
    restore();
  }
});

test("handleCostComparison reports error for unreadable summary file", async () => {
  const { home } = setupHome();
  const dir = mkdtempSync(join(tmpdir(), "coord-ab-bad-"));
  const badPath = join(dir, "summary.json");
  writeFileSync(badPath, "not valid json {{{");
  const { api, restore } = await loadForTest(home);
  try {
    api.ensureDirsOnce();
    process.env.LEAD_AB_HARNESS_SUMMARY = badPath;
    const result = api.handleToolCall("coord_cost_comparison", {});
    const txt = result?.content?.[0]?.text || "";
    assert.match(txt, /unreadable/);
    assert.match(txt, /No cheaper-than-native claim is allowed/);
  } finally {
    restore();
  }
});
