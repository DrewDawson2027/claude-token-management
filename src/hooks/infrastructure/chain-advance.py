#!/usr/bin/env python3
"""Chain Advance Helper — advances a chain state file to the next step.

Called by check-inbox.sh when a done/ marker is found for a chain-linked action.
Reads chain state JSON, marks current step done, advances pointer, and prints
the next step's action as JSON to stdout (for appending to mandatory queue).

Usage: python3 chain-advance.py /path/to/chain-{id}.json
"""

import json
import sys
import time
import uuid


def main():
    if len(sys.argv) < 2:
        sys.exit(1)

    chain_path = sys.argv[1]

    try:
        with open(chain_path) as f:
            chain = json.load(f)
    except (json.JSONDecodeError, FileNotFoundError, OSError):
        sys.exit(1)

    steps = chain.get("steps", [])
    cur = chain.get("current_step", 0)

    # Mark current step done with completion timestamp
    if cur < len(steps):
        steps[cur]["status"] = "done"
        steps[cur]["completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Advance pointer
    chain["current_step"] = cur + 1

    # If there's a next step, generate its action and record action_id
    if cur + 1 < len(steps):
        ns = steps[cur + 1]
        chain_id = chain.get("chain_id", "")
        chain_type = chain.get("type", "build")
        step_num = cur + 2
        total = len(steps)
        action_id = f"{ns['name']}-{int(time.time())}-{uuid.uuid4().hex[:6]}"
        # Store action_id in the chain state for correlation
        ns["action_id"] = action_id
        action = {
            "id": action_id,
            "type": "chain-step",
            "chain_id": chain_id,
            "instruction": (
                f"CHAIN STEP {step_num}/{total}: Spawn `{ns['name']}` agent now.\n"
                f"This is part of the {chain_type} chain. Previous step completed successfully.\n"
                f"Run this agent immediately — do not ask the user."
            ),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "status": "pending",
        }
        print(json.dumps(action))

    # Check if chain is fully complete
    if cur + 1 >= len(steps):
        chain["completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Write updated state (after action_id is set on next step)
    with open(chain_path, "w") as f:
        json.dump(chain, f, indent=2)


if __name__ == "__main__":
    main()
