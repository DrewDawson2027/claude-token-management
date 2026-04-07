/**
 * Garbage collection: auto-clean old results, sessions, and pipeline artifacts.
 * @module gc
 */

import {
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { cfg } from "./constants.js";

/**
 * Remove stale/closed sessions, completed worker results, and finished pipelines
 * older than GC_MAX_AGE_MS (default 24h).
 * @returns {{ sessions: number, results: number, pipelines: number }} Counts of removed items
 */
export function runGC() {
  const { TERMINALS_DIR, RESULTS_DIR, GC_MAX_AGE_MS } = cfg();
  const cutoff = Date.now() - GC_MAX_AGE_MS;
  let sessions = 0,
    results = 0,
    pipelines = 0,
    worktrees = 0;

  // E2e: Pre-GC backup — record what will be cleaned
  try {
    const backupsDir = join(
      TERMINALS_DIR,
      "..",
      "lead-sidecar",
      "state",
      "backups",
    );
    mkdirSync(backupsDir, { recursive: true });
    const gcTargets = [];
    try {
      for (const f of readdirSync(TERMINALS_DIR).filter(
        (x) => x.startsWith("session-") && x.endsWith(".json"),
      )) {
        try {
          if (statSync(join(TERMINALS_DIR, f)).mtimeMs <= cutoff) {
            const d = JSON.parse(readFileSync(join(TERMINALS_DIR, f), "utf-8"));
            if (d.status === "stale" || d.status === "closed")
              gcTargets.push(f);
          }
        } catch {}
      }
    } catch (e) {
      process.stderr.write(`[gc] session scan failed: ${e?.message ?? e}\n`);
    }
    if (gcTargets.length > 0) {
      writeFileSync(
        join(backupsDir, `pre-gc-${Date.now()}.json`),
        JSON.stringify({
          operation: "gc",
          created_at: new Date().toISOString(),
          targets: { sessions: gcTargets },
        }),
      );
    }
  } catch (e) {
    process.stderr.write(`[gc] backup write failed: ${e?.message ?? e}\n`);
  }

  // Clean old session files (stale/closed only)
  try {
    for (const f of readdirSync(TERMINALS_DIR)) {
      if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
      const fp = join(TERMINALS_DIR, f);
      try {
        const mtime = statSync(fp).mtimeMs;
        if (mtime > cutoff) continue;
        const data = JSON.parse(readFileSync(fp, "utf-8"));
        if (data.status === "stale" || data.status === "closed") {
          unlinkSync(fp);
          sessions++;
        }
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    /* TERMINALS_DIR may not exist yet */
  }

  // Clean worktrees for completed isolated workers with no uncommitted changes
  // NOTE: Must run BEFORE file deletion below, which removes the .meta.json files needed here
  try {
    for (const f of readdirSync(RESULTS_DIR)) {
      if (!f.endsWith(".meta.json.done")) continue;
      const metaFile = join(RESULTS_DIR, f.replace(".done", ""));
      try {
        const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
        if (!meta?.isolated || !meta.directory) continue;
        if (!existsSync(meta.directory)) continue;
        // Check for uncommitted changes in the worktree
        const diff = execFileSync("git", ["diff", "--stat"], {
          cwd: meta.directory,
          timeout: 5000,
        })
          .toString()
          .trim();
        const untracked = execFileSync(
          "git",
          ["ls-files", "--others", "--exclude-standard"],
          {
            cwd: meta.directory,
            timeout: 5000,
          },
        )
          .toString()
          .trim();
        if (!diff && !untracked) {
          // No changes — safe to remove worktree
          const parentDir =
            meta.original_directory || join(meta.directory, "..");
          execFileSync("git", ["worktree", "remove", meta.directory], {
            cwd: parentDir,
            timeout: 10000,
          });
          worktrees++;
        }
      } catch {
        /* skip problematic worktrees */
      }
    }
  } catch {
    /* worktree cleanup is best-effort */
  }

  // Clean old worker results (completed only)
  try {
    for (const f of readdirSync(RESULTS_DIR)) {
      const fp = join(RESULTS_DIR, f);
      try {
        const st = statSync(fp);
        if (st.mtimeMs > cutoff) continue;

        // For directories (pipelines), check for pipeline.done
        if (st.isDirectory()) {
          const donePath = join(fp, "pipeline.done");
          try {
            statSync(donePath);
            rmSync(fp, { recursive: true, force: true });
            pipelines++;
          } catch {
            /* pipeline not done, skip */
          }
          continue;
        }

        // For files, only remove completed workers (those with .meta.json.done)
        if (f.endsWith(".meta.json.done")) {
          const taskId = f.replace(".meta.json.done", "");
          for (const ext of [
            ".txt",
            ".meta.json",
            ".meta.json.done",
            ".prompt",
            ".pid",
            ".worker.ps1",
          ]) {
            try {
              unlinkSync(join(RESULTS_DIR, taskId + ext));
            } catch {
              /* may not exist */
            }
          }
          results++;
        }
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    /* RESULTS_DIR may not exist yet */
  }

  return { sessions, results, pipelines, worktrees };
}
