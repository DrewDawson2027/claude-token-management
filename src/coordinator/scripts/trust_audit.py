#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
SETTINGS = HOME / ".claude/settings.json"
APPROVALS = HOME / ".claude/governance/tier2-approvals.json"
REPORT_DIR = HOME / ".claude/reports"


def tier_for(plugin_name: str) -> int:
    market = plugin_name.split("@")[-1] if "@" in plugin_name else "local"
    if market == "claude-plugins-official":
        return 1
    if market in {"local", ""}:
        return 0
    return 2


def main():
    parser = argparse.ArgumentParser(
        description="Audit enabled plugins against trust policy"
    )
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    settings = json.loads(SETTINGS.read_text())
    approvals_doc = (
        json.loads(APPROVALS.read_text()) if APPROVALS.exists() else {"approved": []}
    )
    approved = {
        x.get("plugin") for x in approvals_doc.get("approved", []) if x.get("plugin")
    }

    enabled = [k for k, v in settings.get("enabledPlugins", {}).items() if v]
    violations = []
    summary = {"tier0": 0, "tier1": 0, "tier2": 0}

    for p in enabled:
        t = tier_for(p)
        summary[f"tier{t}"] += 1
        if t == 2 and p not in approved:
            violations.append(p)

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = {
        "enabled": enabled,
        "summary": summary,
        "tier2_unapproved": violations,
    }
    rpt = REPORT_DIR / "trust-audit-latest.json"
    rpt.write_text(json.dumps(out, indent=2) + "\n")

    if not args.quiet:
        print(json.dumps(out, indent=2))

    if violations:
        print("WARNING: Unapproved tier-2 plugins enabled:")
        for v in violations:
            print(f"- {v}")


if __name__ == "__main__":
    main()
