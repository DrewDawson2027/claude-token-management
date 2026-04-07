#!/usr/bin/env node

import { __test__ } from "../index.js";

const claimOnly = process.argv.includes("--claim-only");

const raw = process.env.CLAUDE_AUTOCLAIM_ARGS_B64 || "";
if (!raw) process.exit(0);

let args = null;
try {
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  args = JSON.parse(decoded);
} catch {
  process.exit(0);
}

try {
  __test__.ensureDirsOnce();
  if (claimOnly) {
    // Return JSON task data for the in-place worker loop to consume.
    // Empty stdout signals no more tasks; the loop breaks.
    const data = __test__.handleClaimNextTaskData(args);
    if (data && data.found) {
      process.stdout.write(JSON.stringify(data));
    }
    process.exit(0);
  } else {
    __test__.handleClaimNextTask(args);
  }
} catch {
  process.exit(0);
}
