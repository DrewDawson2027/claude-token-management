/**
 * output-forwarder.js — Worker-side stdout forwarder.
 *
 * Replaces the `script -q` / tee approach with a Node.js wrapper that:
 *   1. Spawns `claude -p` as a child process
 *   2. Creates a Unix domain socket at /tmp/claude-worker-{taskId}.sock
 *   3. Streams stdout/stderr to BOTH the result file AND any connected socket clients
 *   4. On exit, writes the .done marker and cleans up
 *
 * Usage: node output-forwarder.js <taskId> <resultFile> <metaDoneFile> <pidFile> -- <claude args...>
 *
 * Data flow:
 *   claude stdout → forwarder → socket (real-time, ~5ms) + file (persistent)
 *                              └→ .done marker on exit (always, regardless of exit code)
 */

import { spawn } from "child_process";
import { createServer } from "net";
import { createWriteStream, writeFileSync, unlinkSync, existsSync } from "fs";

const args = process.argv.slice(2);
const separatorIdx = args.indexOf("--");
if (separatorIdx === -1 || separatorIdx < 4) {
  process.stderr.write(
    "Usage: node output-forwarder.js <taskId> <resultFile> <metaDoneFile> <pidFile> -- <command> [args...]\n",
  );
  process.exit(1);
}

const [taskId, resultFile, metaDoneFile, pidFile] = args.slice(0, 4);
const childCmd = args[separatorIdx + 1];
const childArgs = args.slice(separatorIdx + 2);

const socketPath = `/tmp/claude-worker-${taskId}.sock`;
const mirrorToTerminal = process.env.CLAUDE_WORKER_VISIBLE === "1";

// Clean up stale socket if it exists
try {
  if (existsSync(socketPath)) unlinkSync(socketPath);
} catch {}

// Write PID file
writeFileSync(pidFile, String(process.pid));

// Open result file for appending
const resultStream = createWriteStream(resultFile, { flags: "a" });
const startBanner = `Worker '${taskId}' starting at ${new Date().toLocaleString()}\n`;
resultStream.write(startBanner);
if (mirrorToTerminal) process.stdout.write(startBanner);

// Track connected socket clients
const clients = new Set();

// Create Unix domain socket server
const socketServer = createServer((conn) => {
  clients.add(conn);
  conn.on("error", () => clients.delete(conn));
  conn.on("close", () => clients.delete(conn));
});

socketServer.on("error", () => {
  // Socket server failed to start — continue without it (file-only mode)
});

socketServer.listen(socketPath, () => {
  // Socket ready — clients can connect at socketPath
});

// Spawn the child process (claude -p or any command)
const child = spawn(childCmd, childArgs, {
  stdio: ["inherit", "pipe", "pipe"],
  env: { ...process.env, CLAUDECODE: undefined },
});

// Broadcast data to all connected socket clients
function broadcast(chunk) {
  for (const client of clients) {
    try {
      client.write(chunk);
    } catch {
      clients.delete(client);
    }
  }
}

// Pipe stdout to both file and socket
child.stdout.on("data", (chunk) => {
  resultStream.write(chunk);
  broadcast(chunk);
  if (mirrorToTerminal) process.stdout.write(chunk);
});

// Pipe stderr to both file and socket (interleaved, same as 2>&1)
child.stderr.on("data", (chunk) => {
  resultStream.write(chunk);
  broadcast(chunk);
  if (mirrorToTerminal) process.stderr.write(chunk);
});

// On child exit, write .done marker and clean up (always, regardless of exit code)
child.on("close", (code) => {
  const donePayload = JSON.stringify({
    status: code === 0 ? "completed" : "completed",
    finished: new Date().toISOString(),
    task_id: taskId,
    exit_code: code,
  });
  try {
    writeFileSync(metaDoneFile, donePayload);
  } catch {}

  // Close result file
  resultStream.end();

  // Clean up PID file
  try {
    unlinkSync(pidFile);
  } catch {}

  // Clean up socket
  socketServer.close();
  try {
    unlinkSync(socketPath);
  } catch {}

  // Disconnect all clients
  for (const client of clients) {
    try {
      client.end();
    } catch {}
  }

  process.exit(code || 0);
});

// Handle signals — forward to child and clean up
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
