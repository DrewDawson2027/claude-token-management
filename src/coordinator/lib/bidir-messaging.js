/**
 * Bidirectional tmux messaging protocol.
 *
 * W2L (Worker → Lead): worker uses Bash tool to run:
 *   tmux send-keys -t "$CLAUDE_LEAD_PANE_ID" "[W2L:task-id]: message" Enter
 *
 * L2W (Lead → Worker): lead calls coord_send_to_worker_pane MCP tool, which
 *   looks up the worker's pane ID and injects "[L2W]: message" via send-keys.
 *
 * Both sides use tmux send-keys so the receiving Claude reads the message as
 * user input and responds naturally — the same pattern as peer-to-peer demos.
 */

export const W2L_PREFIX = "[W2L:";
export const L2W_PREFIX = "[L2W]:";

/**
 * Format a worker-to-lead message.
 * @param {string} taskId - Worker's task ID (baked in at spawn time)
 * @param {string} message
 * @returns {string} e.g. "[W2L:task-abc]: I need clarification on X"
 */
export function formatW2LMessage(taskId, message) {
  return `${W2L_PREFIX}${String(taskId).trim()}]: ${String(message).trim()}`;
}

/**
 * Format a lead-to-worker message.
 * @param {string} message
 * @returns {string} e.g. "[L2W]: Here is the answer — continue"
 */
export function formatL2WMessage(message) {
  return `${L2W_PREFIX} ${String(message).trim()}`;
}

/**
 * Parse a W2L message from the lead's terminal input.
 * Returns null if the text is not a valid W2L message.
 * @param {string} text
 * @returns {{ taskId: string, content: string } | null}
 */
export function parseW2LMessage(text) {
  const str = String(text || "").trim();
  if (!str.startsWith(W2L_PREFIX)) return null;
  const close = str.indexOf("]:", W2L_PREFIX.length);
  if (close === -1) return null;
  const taskId = str.slice(W2L_PREFIX.length, close).trim();
  const content = str.slice(close + 2).trim();
  if (!taskId || !content) return null;
  return { taskId, content };
}

/**
 * Parse a L2W message from the worker's terminal input.
 * Returns null if the text is not a valid L2W message.
 * @param {string} text
 * @returns {{ content: string } | null}
 */
export function parseL2WMessage(text) {
  const str = String(text || "").trim();
  if (!str.startsWith(L2W_PREFIX)) return null;
  const content = str.slice(L2W_PREFIX.length).trim();
  if (!content) return null;
  return { content };
}

/**
 * Build the bidir protocol context to append to a worker's initial prompt.
 * Tells the worker how to send messages to the lead and how to recognize replies.
 * Baked in at spawn time — leadPaneId and taskId are literal values.
 * @param {string} leadPaneId - e.g. "%7"
 * @param {string} taskId - Worker's task ID
 * @returns {string}
 */
export function buildBidirProtocol(leadPaneId, taskId) {
  return [
    "",
    "BIDIRECTIONAL MESSAGING ACTIVE:",
    `To send a message to the lead, use the Bash tool and run:`,
    `  tmux send-keys -t "${leadPaneId}" "[W2L:${taskId}]: your message here" Enter`,
    `Wait a moment — the lead will inject a reply starting with "${L2W_PREFIX}" directly into your terminal.`,
    `If you see "${L2W_PREFIX} ..." injected into your input, it is a reply from the lead. Read it and continue.`,
    `Use this channel only for genuine blockers that require lead input. Do not narrate routine progress.`,
  ].join("\n");
}
