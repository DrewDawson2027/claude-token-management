#!/usr/bin/env node

import { __test__ } from "../index.js";

function printResponse(response) {
  const text =
    response?.content
      ?.map((item) => item?.text || "")
      .filter(Boolean)
      .join("\n") || "";
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  worker-cli.mjs spawn <directory> <prompt> [model] [task_id] [layout]",
      "  worker-cli.mjs get-result <task_id> [tail_lines]",
    ].join("\n") + "\n",
  );
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
if (!command) usage();

switch (command) {
  case "spawn": {
    const [directory, prompt, model = "sonnet", task_id, layout] = rest;
    if (!directory || !prompt) usage();
    printResponse(
      __test__.handleToolCall("coord_spawn_worker", {
        directory,
        prompt,
        model,
        ...(task_id ? { task_id } : {}),
        ...(layout ? { layout } : {}),
      }),
    );
    break;
  }
  case "get-result": {
    const [task_id, tail_lines] = rest;
    if (!task_id) usage();
    printResponse(
      __test__.handleToolCall("coord_get_result", {
        task_id,
        ...(tail_lines ? { tail_lines: Number(tail_lines) } : {}),
      }),
    );
    break;
  }
  default:
    usage();
}
