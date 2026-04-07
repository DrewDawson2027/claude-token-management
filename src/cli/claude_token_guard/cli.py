#!/usr/bin/env python3
"""CLI for Claude Token Guard: hooks + cost + ops unified entrypoint."""

import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from claude_token_guard import __version__
except ModuleNotFoundError:
    # Allow direct execution: python3 ~/.claude/hooks/claude_token_guard/cli.py
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from claude_token_guard import __version__

HOOKS_DIR = os.path.expanduser("~/.claude/hooks")
SETTINGS_PATH = os.path.expanduser("~/.claude/settings.json")
VERSION_FILE = os.path.join(HOOKS_DIR, ".version")
MANIFEST_FILE = os.path.join(HOOKS_DIR, ".manifest.json")
COST_RUNTIME_PATH = os.path.expanduser("~/.claude/scripts/cost_runtime.py")
OBSERVABILITY_PATH = os.path.expanduser("~/.claude/scripts/observability.py")

PACKAGE_DIR = Path(__file__).resolve().parent


def _discover_project_root() -> Path:
    for candidate in PACKAGE_DIR.parents:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return PACKAGE_DIR.parent


PROJECT_ROOT = _discover_project_root()
SOURCE_IMPORT_DIRS = [
    PROJECT_ROOT,
    PROJECT_ROOT / "src" / "hooks" / "ops",
    PROJECT_ROOT / "src" / "hooks" / "infrastructure",
    PROJECT_ROOT / "src" / "hooks" / "tracking",
    PROJECT_ROOT / "src" / "hooks" / "guards",
    PROJECT_ROOT / "src" / "hooks" / "routing",
    PROJECT_ROOT / "src" / "scripts" / "core",
]
for candidate in SOURCE_IMPORT_DIRS:
    candidate_str = str(candidate)
    if candidate.exists() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

# Files to install (relative to package data or source root)
HOOK_FILES = [
    "token-guard.py",
    "read-efficiency-guard.py",
    "hook_utils.py",
    "self-heal.py",
    "health-check.sh",
    "token-guard-config.json",
    "guard_contracts.py",
    "guard_normalize.py",
    "guard_events.py",
    "ops_sources.py",
    "ops_trends.py",
    "ops_alerts.py",
    "ops_recap.py",
    "ops_aggregator.py",
    "agent-lifecycle.sh",
    "agent-metrics.py",
]
HOOK_SOURCE_MAP = {
    "token-guard.py": "src/hooks/guards/token-guard.py",
    "read-efficiency-guard.py": "src/hooks/guards/read-efficiency-guard.py",
    "hook_utils.py": "src/hooks/infrastructure/hook_utils.py",
    "self-heal.py": "src/hooks/infrastructure/self-heal.py",
    "health-check.sh": "src/hooks/runtime/health-check.sh",
    "token-guard-config.json": "config/token-guard-config.json",
    "guard_contracts.py": "src/hooks/infrastructure/guard_contracts.py",
    "guard_normalize.py": "src/hooks/infrastructure/guard_normalize.py",
    "guard_events.py": "src/hooks/infrastructure/guard_events.py",
    "ops_sources.py": "src/hooks/ops/ops_sources.py",
    "ops_trends.py": "src/hooks/ops/ops_trends.py",
    "ops_alerts.py": "src/hooks/ops/ops_alerts.py",
    "ops_recap.py": "src/hooks/ops/ops_recap.py",
    "ops_aggregator.py": "src/hooks/ops/ops_aggregator.py",
    "agent-lifecycle.sh": "src/hooks/runtime/agent-lifecycle.sh",
    "agent-metrics.py": "src/hooks/tracking/agent-metrics.py",
}


def _share_data_root() -> Path:
    return Path(sys.prefix) / "share" / "claude-token-guard"


def _resolve_install_source(fname: str) -> str | None:
    candidates = []
    mapped = HOOK_SOURCE_MAP.get(fname)
    if mapped:
        candidates.append(PROJECT_ROOT / mapped)
    candidates.append(PROJECT_ROOT / fname)
    candidates.append(_share_data_root() / fname)
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def _resolve_fixture_path(name: str) -> str | None:
    for candidate in (
        PROJECT_ROOT / "tests" / "fixtures" / name,
        PROJECT_ROOT / "tests" / name,
        PROJECT_ROOT / "tests" / "vendor" / "hooks-runtime" / "fixtures" / name,
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def _run_python(script_path, argv, check=False, capture=False, timeout=60):
    cmd = ["python3", script_path, *argv]
    if capture:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=check
        )
    return subprocess.run(cmd, timeout=timeout, check=check)


def _import_ops_modules():
    from ops_aggregator import build_ops_today, render_ops_today
    from ops_alerts import alert_status, evaluate_alerts
    from ops_recap import build_session_recap, render_recap
    from ops_trends import build_trends, render_text as render_trends_text

    return {
        "build_ops_today": build_ops_today,
        "render_ops_today": render_ops_today,
        "alert_status": alert_status,
        "evaluate_alerts": evaluate_alerts,
        "build_session_recap": build_session_recap,
        "render_recap": render_recap,
        "build_trends": build_trends,
        "render_trends_text": render_trends_text,
    }


def _print_deprecation_hint(legacy_name, canonical_command):
    if "--no-deprecation-warning" in sys.argv:
        return
    print(
        f"DEPRECATED: `{legacy_name}` is kept for compatibility. Use `{canonical_command}`.",
        file=sys.stderr,
    )


def _dispatch_cost_legacy_with_hint(cmd):
    mapping = {
        "summary": "claude-token-guard cost overview",
        "statusline": "claude-token-guard cost overview --format statusline",
        "hook-statusline": "claude-token-guard cost overview --format statusline --hook",
        "budget-status": "claude-token-guard cost budget status",
        "set-budget": "claude-token-guard cost budget set",
        "session": "claude-token-guard cost sessions show",
        "team": "claude-token-guard cost teams show",
        "team-budget-recommend": "claude-token-guard cost teams recommend-budget",
        "burn-rate-check": "claude-token-guard ops alerts check --kind burn-rate",
        "anomaly-check": "claude-token-guard ops alerts check --kind anomaly",
        "daily-report": "claude-token-guard ops today --markdown",
        "cost-trends": "claude-token-guard ops trends",
        "spend-leaderboard": "claude-token-guard cost teams leaderboard",
        "active-block": "claude-token-guard cost budget active-block",
        "index-refresh": "claude-token-guard cost index refresh",
        "export": "claude-token-guard cost export",
    }
    if cmd in mapping:
        _print_deprecation_hint(cmd, mapping[cmd])
        cp = _run_python(COST_RUNTIME_PATH, sys.argv[1:], capture=True)
        if cp.stdout:
            sys.stdout.write(cp.stdout)
        if cp.stderr:
            sys.stderr.write(cp.stderr)
        raise SystemExit(cp.returncode)


def _cmd_ops(argv):
    ops = _import_ops_modules()
    if not argv or argv[0] in {"help", "--help", "-h"}:
        print(
            "Usage: claude-token-guard ops <today|session-recap|alerts|trends|doctor>"
        )
        print("Examples:")
        print("  claude-token-guard ops today --json")
        print("  claude-token-guard ops session-recap --latest")
        print("  claude-token-guard ops alerts status")
        print("  claude-token-guard ops trends --window 7 --json")
        raise SystemExit(0)

    sub = argv[0]
    if sub == "today":
        ap = argparse.ArgumentParser(prog="claude-token-guard ops today")
        ap.add_argument("--json", action="store_true")
        ap.add_argument("--markdown", action="store_true")
        ap.add_argument("--statusline", action="store_true")
        ap.add_argument("--refresh", action="store_true")
        ap.add_argument("--evaluate-alerts", action="store_true")
        ap.add_argument("--deliver-alerts", action="store_true")
        args = ap.parse_args(argv[1:])
        doc = ops["build_ops_today"](
            evaluate_alerts_now=args.evaluate_alerts,
            deliver_alerts=args.deliver_alerts,
            use_cache=not args.refresh,
        )
        fmt = (
            "json"
            if args.json
            else "markdown"
            if args.markdown
            else "statusline"
            if args.statusline
            else "text"
        )
        print(ops["render_ops_today"](doc, fmt=fmt))
        raise SystemExit(0)

    if sub == "session-recap":
        ap = argparse.ArgumentParser(prog="claude-token-guard ops session-recap")
        ap.add_argument("--session-id")
        ap.add_argument("--latest", action="store_true")
        ap.add_argument("--json", action="store_true")
        ap.add_argument("--markdown", action="store_true")
        args = ap.parse_args(argv[1:])
        doc = ops["build_session_recap"](
            session_id=args.session_id, latest=args.latest or not args.session_id
        )
        if args.json:
            print(json.dumps(doc, indent=2))
        else:
            print(ops["render_recap"](doc, markdown=args.markdown))
        raise SystemExit(0)

    if sub == "alerts":
        if len(argv) == 1 or argv[1] in {"help", "--help", "-h"}:
            print("Usage: claude-token-guard ops alerts <status|evaluate|check>")
            raise SystemExit(0)
        action = argv[1]
        if action in {"status"}:
            ap = argparse.ArgumentParser(prog="claude-token-guard ops alerts status")
            ap.add_argument("--limit", type=int, default=20)
            ap.add_argument("--json", action="store_true")
            args = ap.parse_args(argv[2:])
            doc = ops["alert_status"](limit=args.limit)
            if args.json:
                print(json.dumps(doc, indent=2))
            else:
                print(f"Recent alerts: {len(doc.get('recent') or [])}")
                for a in doc.get("recent") or []:
                    print(
                        f"- {a.get('ts')} [{a.get('severity')}] {a.get('category')}: {a.get('message')}"
                    )
            raise SystemExit(0)
        if action in {"evaluate"}:
            ap = argparse.ArgumentParser(prog="claude-token-guard ops alerts evaluate")
            ap.add_argument("--source", default="cli")
            ap.add_argument("--session-key", default="")
            ap.add_argument("--no-deliver", action="store_true")
            ap.add_argument("--json", action="store_true")
            args = ap.parse_args(argv[2:])
            doc = ops["evaluate_alerts"](
                trigger_source=args.source,
                deliver=not args.no_deliver,
                session_key=args.session_key,
            )
            if args.json:
                print(json.dumps(doc, indent=2))
            else:
                print(f"Alerts evaluated: {doc.get('count', 0)}")
            raise SystemExit(0)
        if action == "check":
            ap = argparse.ArgumentParser(prog="claude-token-guard ops alerts check")
            ap.add_argument(
                "--kind", choices=["burn-rate", "anomaly", "all"], default="all"
            )
            ap.add_argument("--json", action="store_true")
            args = ap.parse_args(argv[2:])
            if args.kind == "burn-rate":
                cp = _run_python(
                    COST_RUNTIME_PATH,
                    ["burn-rate-check"] + (["--json"] if args.json else []),
                    capture=True,
                )
            elif args.kind == "anomaly":
                cp = _run_python(
                    COST_RUNTIME_PATH,
                    ["anomaly-check"] + (["--json"] if args.json else []),
                    capture=True,
                )
            else:
                cp = _run_python(
                    os.path.join(HOOKS_DIR, "ops_alerts.py"),
                    ["evaluate", "--source", "cli:alerts-check"]
                    + (["--json"] if args.json else []),
                    capture=True,
                )
            if cp.stdout:
                sys.stdout.write(cp.stdout)
            if cp.stderr:
                sys.stderr.write(cp.stderr)
            raise SystemExit(cp.returncode)

    if sub == "trends":
        ap = argparse.ArgumentParser(prog="claude-token-guard ops trends")
        ap.add_argument("--window", type=int, default=7, choices=[7, 14, 30])
        ap.add_argument("--json", action="store_true")
        ap.add_argument("--markdown", action="store_true")
        args = ap.parse_args(argv[1:])
        doc = ops["build_trends"](window_days=args.window)
        if args.json:
            print(json.dumps(doc, indent=2))
        elif args.markdown:
            print("```")
            print(ops["render_trends_text"](doc))
            print("```")
        else:
            print(ops["render_trends_text"](doc))
        raise SystemExit(0)

    if sub == "doctor":
        # Unified operator doctor: health-check stats + self-heal smoke + ops snapshot statusline
        hc = os.path.join(HOOKS_DIR, "health-check.sh")
        if os.path.isfile(hc):
            subprocess.run(["bash", hc, "--stats"], check=False)
        else:
            print("health-check.sh not found", file=sys.stderr)
        sh = os.path.join(HOOKS_DIR, "self-heal.py")
        if os.path.isfile(sh):
            subprocess.run(["python3", sh], check=False)
        raise SystemExit(0)

    print(f"Unknown ops command: {sub}", file=sys.stderr)
    raise SystemExit(1)


def _cmd_cost(argv):
    if not argv or argv[0] in {"help", "--help", "-h"}:
        print(
            "Usage: claude-token-guard cost <overview|budget|sessions|teams|export|index>"
        )
        raise SystemExit(0)
    sub = argv[0]
    if sub == "overview":
        parser = argparse.ArgumentParser(prog="claude-token-guard cost overview")
        parser.add_argument(
            "--format", choices=["summary", "statusline"], default="summary"
        )
        parser.add_argument("--window", default="today")
        parser.add_argument("--json", action="store_true")
        parser.add_argument("--team-id")
        parser.add_argument("--session-id")
        parser.add_argument("--project")
        parser.add_argument("--breakdown", action="store_true")
        parser.add_argument("--hook", action="store_true")
        args = parser.parse_args(argv[1:])
        if args.format == "statusline":
            cmd = ["hook-statusline"] if args.hook else ["statusline"]
        else:
            cmd = ["summary", "--window", args.window]
            if args.breakdown:
                cmd.append("--breakdown")
            if args.json:
                cmd.append("--json")
        for flag, val in [
            ("--team-id", args.team_id),
            ("--session-id", args.session_id),
            ("--project", args.project),
        ]:
            if val:
                cmd.extend([flag, val])
        cp = _run_python(COST_RUNTIME_PATH, cmd, capture=True)
        if cp.stdout:
            sys.stdout.write(cp.stdout)
        if cp.stderr:
            sys.stderr.write(cp.stderr)
        raise SystemExit(cp.returncode)

    if sub == "budget":
        if len(argv) < 2:
            print(
                "Usage: claude-token-guard cost budget <status|set|active-block>",
                file=sys.stderr,
            )
            raise SystemExit(2)
        action = argv[1]
        if action == "status":
            cp = _run_python(
                COST_RUNTIME_PATH, ["budget-status", *argv[2:]], capture=True
            )
            if cp.stdout:
                sys.stdout.write(cp.stdout)
            if cp.stderr:
                sys.stderr.write(cp.stderr)
            raise SystemExit(cp.returncode)
        if action == "set":
            cp = _run_python(COST_RUNTIME_PATH, ["set-budget", *argv[2:]], capture=True)
            if cp.stdout:
                sys.stdout.write(cp.stdout)
            if cp.stderr:
                sys.stderr.write(cp.stderr)
            raise SystemExit(cp.returncode)
        if action == "active-block":
            cp = _run_python(
                COST_RUNTIME_PATH, ["active-block", *argv[2:]], capture=True
            )
            if cp.stdout:
                sys.stdout.write(cp.stdout)
            if cp.stderr:
                sys.stderr.write(cp.stderr)
            raise SystemExit(cp.returncode)
    if sub == "sessions":
        action = argv[1] if len(argv) > 1 else "show"
        if action == "show":
            cp = _run_python(COST_RUNTIME_PATH, ["session", *argv[2:]], capture=True)
            if cp.stdout:
                sys.stdout.write(cp.stdout)
            if cp.stderr:
                sys.stderr.write(cp.stderr)
            raise SystemExit(cp.returncode)
    if sub == "teams":
        action = argv[1] if len(argv) > 1 else "show"
        mapped = {
            "show": "team",
            "recommend-budget": "team-budget-recommend",
            "leaderboard": "spend-leaderboard",
        }.get(action)
        if mapped:
            cp = _run_python(COST_RUNTIME_PATH, [mapped, *argv[2:]], capture=True)
            if cp.stdout:
                sys.stdout.write(cp.stdout)
            if cp.stderr:
                sys.stderr.write(cp.stderr)
            raise SystemExit(cp.returncode)
    if sub == "export":
        cp = _run_python(COST_RUNTIME_PATH, ["export", *argv[1:]], capture=True)
        if cp.stdout:
            sys.stdout.write(cp.stdout)
        if cp.stderr:
            sys.stderr.write(cp.stderr)
        raise SystemExit(cp.returncode)
    if sub == "index":
        action = argv[1] if len(argv) > 1 else "refresh"
        if action == "refresh":
            cp = _run_python(
                COST_RUNTIME_PATH, ["index-refresh", *argv[2:]], capture=True
            )
            if cp.stdout:
                sys.stdout.write(cp.stdout)
            if cp.stderr:
                sys.stderr.write(cp.stderr)
            raise SystemExit(cp.returncode)
    print(f"Unknown cost command: {' '.join(argv)}", file=sys.stderr)
    raise SystemExit(1)


def _cmd_hooks(argv):
    if not argv or argv[0] in {"help", "--help", "-h"}:
        print("Usage: claude-token-guard hooks <report|usage|health|verify|drift>")
        raise SystemExit(0)
    sub = argv[0]
    if sub == "report":
        tg_path = os.path.join(HOOKS_DIR, "token-guard.py")
        cp = _run_python(tg_path, ["--report", *argv[1:]], capture=True)
        if cp.stdout:
            sys.stdout.write(cp.stdout)
        if cp.stderr:
            sys.stderr.write(cp.stderr)
        raise SystemExit(cp.returncode)
    if sub == "usage":
        tg_path = os.path.join(HOOKS_DIR, "token-guard.py")
        cp = _run_python(tg_path, ["--usage", *argv[1:]], capture=True)
        if cp.stdout:
            sys.stdout.write(cp.stdout)
        if cp.stderr:
            sys.stderr.write(cp.stderr)
        raise SystemExit(cp.returncode)
    if sub == "health":
        cmd_health()
        raise SystemExit(0)
    if sub == "verify":
        if "--full" in argv[1:]:
            runner = os.path.expanduser(
                "~/Projects/claude-lead-system/scripts/run_token_system_regression.py"
            )
            if os.path.isfile(runner):
                cp = _run_python(runner, [], capture=True, timeout=600)
                if cp.stdout:
                    sys.stdout.write(cp.stdout)
                if cp.stderr:
                    sys.stderr.write(cp.stderr)
                raise SystemExit(cp.returncode)
        cmd_verify()
        raise SystemExit(0)
    if sub == "drift":
        cmd_drift()
        raise SystemExit(0)
    print(f"Unknown hooks command: {sub}", file=sys.stderr)
    raise SystemExit(1)


def _dispatch_unified_cli():
    if len(sys.argv) > 1 and sys.argv[1] in {"--help", "-h"}:
        print(f"claude-token-guard {__version__}")
        print("\nUsage: claude-token-guard <command>")
        print("\nStart here:")
        print("  ops today                 Single pane of glass (what happened today)")
        print("  ops session-recap         What just happened in a session")
        print("  ops alerts status         Recent proactive alerts")
        print("  ops trends --window 7     Rolling cost trends (7/14/30d)")
        print("  cost overview             Canonical cost summary")
        print("  hooks report              Hook analytics")
        print("\nCommand groups: ops, cost, hooks")
        print("Legacy commands are still supported with deprecation hints.")
        print("\nDocs:")
        print("  README.md (Start Here: Ops / Cost / Hooks)")
        print("  docs/TOKEN_MANAGEMENT_MIGRATION_GUIDE.md")
        print("  docs/TOKEN_MANAGEMENT_OPERATOR_PLAYBOOK.md")
        raise SystemExit(0)

    # Legacy long-flag alias
    if len(sys.argv) > 1 and sys.argv[1] == "--session-recap":
        ops = _import_ops_modules()
        ap = argparse.ArgumentParser(prog="token-guard --session-recap")
        ap.add_argument("--session-id")
        ap.add_argument("--latest", action="store_true")
        ap.add_argument("--json", action="store_true")
        args = ap.parse_args(sys.argv[2:])
        doc = ops["build_session_recap"](
            session_id=args.session_id, latest=args.latest or not args.session_id
        )
        if args.json:
            print(json.dumps(doc, indent=2))
        else:
            print(ops["render_recap"](doc))
        raise SystemExit(0)

    # Canonical grouped commands
    if len(sys.argv) > 1 and sys.argv[1] == "ops":
        _cmd_ops(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "cost":
        _cmd_cost(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "hooks":
        _cmd_hooks(sys.argv[2:])

    # Legacy cost_runtime direct passthrough aliases on the unified entrypoint
    if len(sys.argv) > 1:
        _dispatch_cost_legacy_with_hint(sys.argv[1])


def _find_source_dir():
    """Find the directory containing the hook source files."""
    candidates = [
        str(PROJECT_ROOT),
        os.path.join(sys.prefix, "share", "claude-token-guard"),  # installed data
    ]
    for candidate in candidates:
        if os.path.isfile(os.path.join(candidate, "token-guard.py")):
            return candidate
        mapped = PROJECT_ROOT / HOOK_SOURCE_MAP["token-guard.py"]
        if candidate == str(PROJECT_ROOT) and mapped.is_file():
            return candidate
    return None


def _get_installed_version():
    """Read the installed version from the .version file, or None."""
    try:
        with open(VERSION_FILE, "r") as f:
            return f.read().strip()
    except (FileNotFoundError, OSError):
        return None


def _sha256(path):
    """Compute SHA256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _build_manifest():
    """Build and write install manifest with checksums to MANIFEST_FILE."""
    files = {}
    for fname in HOOK_FILES:
        fpath = os.path.join(HOOKS_DIR, fname)
        if os.path.isfile(fpath):
            files[fname] = {
                "sha256": _sha256(fpath),
                "size": os.path.getsize(fpath),
            }
    manifest = {
        "version": __version__,
        "installed_at": datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        ),
        "files": files,
    }
    with open(MANIFEST_FILE, "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest


def cmd_install():
    """Copy hooks to ~/.claude/hooks/ and patch settings.json."""
    force = "--force" in sys.argv

    # Check if already up to date
    installed_ver = _get_installed_version()
    if installed_ver == __version__ and not force:
        print(f"Token Guard {__version__} already installed and up to date.")
        print("Use --force to reinstall.")
        return

    source_dir = _find_source_dir()
    if not source_dir:
        print("ERROR: Cannot find hook source files.", file=sys.stderr)
        print("If installed via pip, try reinstalling.", file=sys.stderr)
        sys.exit(1)

    os.makedirs(HOOKS_DIR, exist_ok=True)

    installed = []
    for fname in HOOK_FILES:
        src = _resolve_install_source(fname)
        dst = os.path.join(HOOKS_DIR, fname)
        if src and os.path.isfile(src):
            shutil.copy2(src, dst)
            if fname.endswith(".sh"):
                os.chmod(dst, 0o755)
            installed.append(fname)

    # Write version stamp
    with open(VERSION_FILE, "w") as f:
        f.write(__version__)

    # Create session-state directory with restricted permissions
    state_dir = os.path.join(HOOKS_DIR, "session-state")
    os.makedirs(state_dir, exist_ok=True)
    try:
        os.chmod(state_dir, 0o700)
    except OSError:
        pass

    # Patch settings.json with hook configuration
    _patch_settings()

    # Write install manifest with checksums
    _build_manifest()

    action = "Updated" if installed_ver else "Installed"
    print(f"{action} {len(installed)} files to {HOOKS_DIR}/ (v{__version__})")
    for f in installed:
        print(f"  + {f}")
    print(f"\nState directory: {state_dir}")
    print("Settings patched: ~/.claude/settings.json")
    print("\nToken Guard is active. Restart Claude Code to apply.")


def _patch_settings():
    """Add hook entries to ~/.claude/settings.json."""
    settings = {}
    if os.path.isfile(SETTINGS_PATH):
        try:
            with open(SETTINGS_PATH, "r") as f:
                settings = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass

    hooks = settings.setdefault("hooks", {})
    pre_tool = hooks.setdefault("PreToolUse", [])
    session_start = hooks.setdefault("SessionStart", [])

    # Add token-guard if not present
    tg_entry = {
        "type": "command",
        "command": f"python3 {HOOKS_DIR}/token-guard.py",
    }
    if not any("token-guard" in str(e) for e in pre_tool):
        pre_tool.append(tg_entry)

    # Add read-efficiency-guard if not present
    reg_entry = {
        "type": "command",
        "command": f"python3 {HOOKS_DIR}/read-efficiency-guard.py",
    }
    if not any("read-efficiency-guard" in str(e) for e in pre_tool):
        pre_tool.append(reg_entry)

    # Add self-heal if not present
    sh_entry = {
        "type": "command",
        "command": f"python3 {HOOKS_DIR}/self-heal.py",
    }
    if not any("self-heal" in str(e) for e in session_start):
        session_start.append(sh_entry)

    # Add agent lifecycle hooks (SubagentStart/SubagentStop)
    subagent_start = hooks.setdefault("SubagentStart", [])
    subagent_stop = hooks.setdefault("SubagentStop", [])

    lc_entry = {
        "type": "command",
        "command": f"bash {HOOKS_DIR}/agent-lifecycle.sh",
    }
    if not any("agent-lifecycle" in str(e) for e in subagent_start):
        subagent_start.append(lc_entry)
    if not any("agent-lifecycle" in str(e) for e in subagent_stop):
        subagent_stop.append(dict(lc_entry))

    am_entry = {
        "type": "command",
        "command": f"python3 {HOOKS_DIR}/agent-metrics.py",
    }
    if not any("agent-metrics" in str(e) for e in subagent_stop):
        subagent_stop.append(am_entry)

    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    with open(SETTINGS_PATH, "w") as f:
        json.dump(settings, f, indent=2)


def cmd_uninstall():
    """Remove hooks and unpatch settings.json."""
    removed = []
    for fname in HOOK_FILES:
        path = os.path.join(HOOKS_DIR, fname)
        if os.path.isfile(path):
            os.unlink(path)
            removed.append(fname)

    # Remove version stamp and manifest
    for cleanup_file in [VERSION_FILE, MANIFEST_FILE]:
        if os.path.isfile(cleanup_file):
            os.unlink(cleanup_file)

    # Unpatch settings.json
    _hook_markers = [
        "token-guard",
        "read-efficiency-guard",
        "self-heal",
        "agent-lifecycle",
        "agent-metrics",
    ]
    if os.path.isfile(SETTINGS_PATH):
        try:
            with open(SETTINGS_PATH, "r") as f:
                settings = json.load(f)
            hooks = settings.get("hooks", {})
            for key in ["PreToolUse", "SessionStart", "SubagentStart", "SubagentStop"]:
                if key in hooks:
                    hooks[key] = [
                        e
                        for e in hooks[key]
                        if not any(h in str(e) for h in _hook_markers)
                    ]
            with open(SETTINGS_PATH, "w") as f:
                json.dump(settings, f, indent=2)
        except (json.JSONDecodeError, OSError):
            pass

    print(f"Removed {len(removed)} files from {HOOKS_DIR}/")
    print("Settings unpatched. Restart Claude Code to apply.")


def cmd_report():
    """Run token-guard.py --report for analytics."""
    tg_path = os.path.join(HOOKS_DIR, "token-guard.py")
    if not os.path.isfile(tg_path):
        print(
            "Token Guard not installed. Run: claude-token-guard install",
            file=sys.stderr,
        )
        sys.exit(1)
    subprocess.run(["python3", tg_path, "--report"])


def cmd_health():
    """Run self-heal.py and report status."""
    sh_path = os.path.join(HOOKS_DIR, "self-heal.py")
    if not os.path.isfile(sh_path):
        print(
            "Self-heal not installed. Run: claude-token-guard install", file=sys.stderr
        )
        sys.exit(1)
    subprocess.run(["python3", sh_path])


def cmd_status():
    """Check installed version vs package version."""
    installed_ver = _get_installed_version()
    if not installed_ver:
        print("Token Guard is not installed.")
        print(f"Package version: {__version__}")
        print("\nRun: claude-token-guard install")
        return

    print(f"Installed version: {installed_ver}")
    print(f"Package version:   {__version__}")

    if installed_ver == __version__:
        print("\nUp to date.")
    else:
        print("\nUpdate available! Run: claude-token-guard install")


def cmd_verify():
    """Post-install verification: checksums, settings, smoke test."""
    ok = True
    checks = 0

    # 1. Check all HOOK_FILES exist
    print("Checking installed files...")
    for fname in HOOK_FILES:
        checks += 1
        fpath = os.path.join(HOOKS_DIR, fname)
        if os.path.isfile(fpath):
            print(f"  OK  {fname}")
        else:
            print(f"  MISSING  {fname}")
            ok = False

    # 2. Compare checksums against manifest
    print("\nChecking manifest checksums...")
    if os.path.isfile(MANIFEST_FILE):
        try:
            with open(MANIFEST_FILE, "r") as f:
                manifest = json.load(f)
            for fname, meta in manifest.get("files", {}).items():
                checks += 1
                fpath = os.path.join(HOOKS_DIR, fname)
                if not os.path.isfile(fpath):
                    print(f"  MISSING  {fname}")
                    ok = False
                    continue
                current = _sha256(fpath)
                if current == meta["sha256"]:
                    print(f"  OK  {fname}")
                else:
                    print(f"  CHANGED  {fname}")
                    ok = False
        except (json.JSONDecodeError, OSError, KeyError) as e:
            print(f"  ERROR reading manifest: {e}")
            ok = False
    else:
        print("  No manifest found. Run: claude-token-guard install")
        ok = False

    # 3. Verify settings.json has hook registrations
    print("\nChecking settings.json registrations...")
    checks += 1
    if os.path.isfile(SETTINGS_PATH):
        try:
            with open(SETTINGS_PATH, "r") as f:
                settings = json.load(f)
            hooks = settings.get("hooks", {})
            for key, marker in [
                ("PreToolUse", "token-guard"),
                ("PreToolUse", "read-efficiency-guard"),
                ("SessionStart", "self-heal"),
            ]:
                checks += 1
                entries = hooks.get(key, [])
                if any(marker in str(e) for e in entries):
                    print(f"  OK  {key}/{marker}")
                else:
                    print(f"  MISSING  {key}/{marker}")
                    ok = False
        except (json.JSONDecodeError, OSError):
            print("  ERROR reading settings.json")
            ok = False
    else:
        print("  settings.json not found")
        ok = False

    # 4. Run self-heal and check exit code
    print("\nRunning self-heal smoke test...")
    checks += 1
    sh_path = os.path.join(HOOKS_DIR, "self-heal.py")
    if os.path.isfile(sh_path):
        result = subprocess.run(
            ["python3", sh_path], capture_output=True, text=True, timeout=15
        )
        if result.returncode == 0:
            print("  OK  self-heal exited 0")
        else:
            print(f"  FAIL  self-heal exited {result.returncode}")
            ok = False
    else:
        print("  SKIP  self-heal.py not found")

    # 5. Pipe test input through token-guard
    print("\nRunning token-guard smoke test...")
    checks += 1
    tg_path = os.path.join(HOOKS_DIR, "token-guard.py")
    if os.path.isfile(tg_path):
        test_input = json.dumps(
            {
                "tool_name": "Read",
                "tool_input": {"file_path": "/tmp/test"},
                "session_id": "verify-smoke",
            }
        )
        result = subprocess.run(
            ["python3", tg_path],
            input=test_input,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            print("  OK  token-guard passthrough exited 0")
        else:
            print(f"  FAIL  token-guard exited {result.returncode}")
            ok = False
    else:
        print("  SKIP  token-guard.py not found")

    # Summary
    status = "PASS" if ok else "FAIL"
    print(f"\nVerification: {status} ({checks} checks)")
    if not ok:
        sys.exit(1)


def cmd_drift():
    """Compare installed files against manifest checksums."""
    if not os.path.isfile(MANIFEST_FILE):
        print("No manifest found. Run: claude-token-guard install")
        sys.exit(1)

    try:
        with open(MANIFEST_FILE, "r") as f:
            manifest = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"ERROR reading manifest: {e}", file=sys.stderr)
        sys.exit(1)

    manifest_files = manifest.get("files", {})
    changed = []
    missing = []
    extra = []

    # Check manifest entries against current files
    for fname, meta in manifest_files.items():
        fpath = os.path.join(HOOKS_DIR, fname)
        if not os.path.isfile(fpath):
            missing.append(fname)
        elif _sha256(fpath) != meta["sha256"]:
            changed.append(fname)

    # Check for extra hook files not in manifest
    for fname in HOOK_FILES:
        if fname not in manifest_files:
            fpath = os.path.join(HOOKS_DIR, fname)
            if os.path.isfile(fpath):
                extra.append(fname)

    print(f"Manifest version: {manifest.get('version', 'unknown')}")
    print(f"Installed at: {manifest.get('installed_at', 'unknown')}")
    print(f"Tracked files: {len(manifest_files)}")

    if not changed and not missing and not extra:
        print("\nNo drift detected. All files match manifest.")
    else:
        if changed:
            print(f"\nChanged ({len(changed)}):")
            for f in changed:
                print(f"  ~ {f}")
        if missing:
            print(f"\nMissing ({len(missing)}):")
            for f in missing:
                print(f"  - {f}")
        if extra:
            print(f"\nExtra ({len(extra)}):")
            for f in extra:
                print(f"  + {f}")
        print("\nDrift detected. Run: claude-token-guard install --force")
        sys.exit(1)


def cmd_benchmark():
    """Run latency benchmarks against hook scripts."""
    import statistics
    import tempfile
    import time as _time

    # Load benchmark inputs
    fixtures_path = os.path.join(
        PROJECT_ROOT,
        "tests",
        "fixtures",
        "benchmark_inputs.json",
    )
    resolved_fixtures = _resolve_fixture_path("benchmark_inputs.json")
    if resolved_fixtures and os.path.isfile(resolved_fixtures):
        with open(resolved_fixtures, "r") as f:
            benchmarks = json.load(f)
    else:
        # Fallback: simple passthrough test
        benchmarks = [
            {
                "name": "passthrough",
                "description": "Non-Task tool call (passthrough)",
                "input": {
                    "tool_name": "Grep",
                    "tool_input": {"pattern": "x"},
                    "session_id": "bench",
                },
                "expected_exit": 0,
            }
        ]

    tg_path = _resolve_install_source("token-guard.py") or os.path.join(
        str(PROJECT_ROOT), "token-guard.py"
    )
    reg_path = _resolve_install_source("read-efficiency-guard.py") or os.path.join(
        str(PROJECT_ROOT), "read-efficiency-guard.py"
    )

    iterations = 20  # Enough for stable percentiles without being slow
    all_latencies = []

    print(f"\n{'=' * 50}")
    print("  CLAUDE TOKEN GUARD BENCHMARK")
    print(f"{'=' * 50}")
    print(f"Iterations per input: {iterations}")
    print()

    for bench in benchmarks:
        name = bench["name"]
        payload = json.dumps(bench["input"])
        tool_name = bench["input"].get("tool_name", "")

        # Pick the right script
        if tool_name == "Read":
            script = reg_path
        else:
            script = tg_path

        if not os.path.isfile(script):
            print(f"  SKIP  {name} — script not found: {script}")
            continue

        latencies = []
        for i in range(iterations):
            with tempfile.TemporaryDirectory() as tmp_dir:
                state_dir = os.path.join(tmp_dir, "session-state")
                os.makedirs(state_dir)
                config_path = os.path.join(tmp_dir, "config.json")
                with open(config_path, "w") as cf:
                    json.dump(
                        {
                            "max_agents": 50,
                            "global_cooldown_seconds": 0,
                            "parallel_window_seconds": 0,
                            "max_per_subagent_type": 50,
                            "audit_log": False,
                        },
                        cf,
                    )

                # Pre-seed if needed
                if "pre_seed" in bench:
                    env = os.environ.copy()
                    env["TOKEN_GUARD_STATE_DIR"] = state_dir
                    env["TOKEN_GUARD_CONFIG_PATH"] = config_path
                    subprocess.run(
                        ["python3", script],
                        input=json.dumps(bench["pre_seed"]),
                        capture_output=True,
                        text=True,
                        env=env,
                        timeout=10,
                    )

                env = os.environ.copy()
                env["TOKEN_GUARD_STATE_DIR"] = state_dir
                env["TOKEN_GUARD_CONFIG_PATH"] = config_path

                t0 = _time.monotonic()
                subprocess.run(
                    ["python3", script],
                    input=payload,
                    capture_output=True,
                    text=True,
                    env=env,
                    timeout=10,
                )
                elapsed_ms = (_time.monotonic() - t0) * 1000
                latencies.append(elapsed_ms)

        latencies.sort()
        all_latencies.extend(latencies)
        p50 = statistics.median(latencies)
        p95 = latencies[int(len(latencies) * 0.95)]
        p99 = latencies[int(len(latencies) * 0.99)]

        print(f"  {name}:")
        print(
            f"    min={latencies[0]:.0f}ms  p50={p50:.0f}ms  p95={p95:.0f}ms  "
            f"p99={p99:.0f}ms  max={latencies[-1]:.0f}ms"
        )

    # Overall summary
    if all_latencies:
        all_latencies.sort()
        overall_p95 = all_latencies[int(len(all_latencies) * 0.95)]
        budget = 500  # ms — subprocess overhead budget
        status = "PASS" if overall_p95 <= budget else "OVER BUDGET"
        print(f"\n  Overall p95: {overall_p95:.0f}ms (budget: {budget}ms) — {status}")

    print(f"{'=' * 50}\n")


def cmd_version():
    """Print version."""
    print(f"claude-token-guard {__version__}")


def main():
    """CLI entry point."""
    _dispatch_unified_cli()

    if len(sys.argv) < 2:
        print(f"claude-token-guard {__version__}")
        print("\nUsage: claude-token-guard <command>")
        print("\nCommands:")
        print(
            "  ops        Unified ops views (today, session-recap, alerts, trends, doctor)"
        )
        print(
            "  cost       Canonical cost commands (overview, budget, sessions, teams, export)"
        )
        print(
            "  hooks      Canonical hook commands (report, usage, health, verify, drift)"
        )
        print("  install    Copy hooks to ~/.claude/hooks/ and patch settings")
        print("  uninstall  Remove hooks and unpatch settings")
        print("  status     Check installed vs package version")
        print("  verify     Post-install verification (checksums + smoke tests)")
        print("  drift      Compare installed files against manifest")
        print("  benchmark  Run latency benchmarks against hook scripts")
        print("  report     Show token usage analytics")
        print("  health     Run self-heal diagnostics")
        print("  version    Show version")
        print("\nDocs:")
        print("  docs/TOKEN_MANAGEMENT_MIGRATION_GUIDE.md")
        print("  docs/TOKEN_MANAGEMENT_OPERATOR_PLAYBOOK.md")
        sys.exit(0)

    cmd = sys.argv[1].lower()
    commands = {
        "install": cmd_install,
        "uninstall": cmd_uninstall,
        "status": cmd_status,
        "verify": cmd_verify,
        "drift": cmd_drift,
        "benchmark": cmd_benchmark,
        "report": cmd_report,
        "health": cmd_health,
        "version": cmd_version,
    }

    if cmd in commands:
        if cmd == "verify" and "--full" in sys.argv[2:]:
            runner = os.path.expanduser("~/Projects/claude-lead-system/scripts/run_token_system_regression.py")
            if os.path.isfile(runner):
                cp = _run_python(runner, [], capture=True, timeout=600)
                if cp.stdout:
                    sys.stdout.write(cp.stdout)
                if cp.stderr:
                    sys.stderr.write(cp.stderr)
                sys.exit(cp.returncode)
        commands[cmd]()
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print(
            "Available: ops, cost, hooks, install, uninstall, status, verify, drift, benchmark, report, health, version",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
