#!/usr/bin/env python3
"""Render a documentary-style launch asset that shows guard actions firing."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[3]
REGRESSION_RESULTS = ROOT / "docs" / "analysis" / "regression-results.md"
DEFAULT_OUTPUT = ROOT / "assets" / "social" / "launch-proof.png"
FONT_REGULAR = "/System/Library/Fonts/Menlo.ttc"
FONT_BOLD = "/System/Library/Fonts/SFNSMono.ttf"
BUDGET_GUARD = ROOT / "src" / "hooks" / "guards" / "budget-guard.py"
READ_GUARD = ROOT / "src" / "hooks" / "guards" / "read-efficiency-guard.py"


def load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def extract(pattern: str, text: str, name: str) -> str:
    match = re.search(pattern, text, re.MULTILINE)
    if not match:
        raise SystemExit(f"missing metric: {name}")
    return match.group(1)


def metrics() -> dict[str, str]:
    regression = load_text(REGRESSION_RESULTS)
    return {
        "fresh_cert": extract(r"- `([^`]+)` checks passed", regression, "fresh_cert"),
        "live_hooks": extract(r"- Hook suite: `([^`]+)`", regression, "live_hooks"),
        "health": extract(r"- Health-check: `([^`]+)`", regression, "health"),
        "proof_date": extract(
            r"## ([0-9-]+) Certification Snapshot", regression, "proof_date"
        ),
    }


def draw_segments(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    segments: list[tuple[str, tuple[int, int, int]]],
    font: ImageFont.FreeTypeFont,
) -> None:
    x, y = xy
    for text, color in segments:
        draw.text((x, y), text, font=font, fill=color)
        x += int(draw.textlength(text, font=font))


def wrap_text(text: str, width: int = 84) -> list[str]:
    lines: list[str] = []
    for paragraph in text.splitlines():
        stripped = paragraph.strip()
        if not stripped:
            lines.append("")
            continue
        lines.extend(wrap(stripped, width=width, break_long_words=False))
    return lines


def guard_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        [
            str(ROOT / "src" / "hooks" / "guards"),
            str(ROOT / "src" / "hooks" / "infrastructure"),
            env.get("PYTHONPATH", ""),
        ]
    )
    return env


def budget_guard_block() -> tuple[int, str]:
    env = guard_env()
    with tempfile.TemporaryDirectory() as td:
        runtime = Path(td) / ".claude"
        hooks = runtime / "hooks"
        cost = runtime / "cost"
        terminals = runtime / "terminals"
        hooks.mkdir(parents=True)
        cost.mkdir(parents=True)
        terminals.mkdir(parents=True)
        (hooks / "token-guard-config.json").write_text(
            json.dumps({"budget_guard": {"enabled": True}}), encoding="utf-8"
        )
        (cost / "budgets.json").write_text(
            json.dumps({"global": {"dailyUSD": 0, "monthlyUSD": 200}, "thresholds": {}}),
            encoding="utf-8",
        )
        (cost / "cache.json").write_text(
            json.dumps({"generatedAt": "2026-04-07T00:00:00Z", "windows": {}}),
            encoding="utf-8",
        )
        (terminals / "session-resumeab.json").write_text(
            json.dumps({"session": "resumeab", "source": "resume"}), encoding="utf-8"
        )
        env["CLAUDE_RUNTIME_DIR"] = str(runtime)
        cp = subprocess.run(
            [sys.executable, str(BUDGET_GUARD)],
            input=json.dumps({"session_id": "resumeabc123", "tool_name": "Read"}),
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
    stderr = cp.stderr.strip()
    stderr = re.sub(r" To acknowledge and continue anyway:.*$", "", stderr)
    return cp.returncode, stderr


def read_guard_block() -> tuple[int, str]:
    env = guard_env()
    with tempfile.TemporaryDirectory() as td:
        env["TOKEN_GUARD_STATE_DIR"] = td
        payload = {
            "tool_name": "Read",
            "tool_input": {"file_path": "/tmp/demo/file.py"},
            "session_id": "dup-test",
        }
        cp = None
        for _ in range(3):
            cp = subprocess.run(
                [sys.executable, str(READ_GUARD)],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
        assert cp is not None
    return cp.returncode, cp.stderr.strip()


def render(output_path: Path) -> None:
    data = metrics()
    budget_rc, budget_msg = budget_guard_block()
    read_rc, read_msg = read_guard_block()

    width, height = 1280, 720
    canvas = Image.new("RGB", (width, height), "#0b0d10")
    draw = ImageDraw.Draw(canvas)

    regular = ImageFont.truetype(FONT_REGULAR, 22)
    small = ImageFont.truetype(FONT_REGULAR, 19)
    title = ImageFont.truetype(FONT_BOLD, 18)

    window_x, window_y = 44, 42
    window_w, window_h = width - 88, height - 84
    radius = 24
    title_h = 54

    draw.rounded_rectangle(
        (window_x, window_y, window_x + window_w, window_y + window_h),
        radius=radius,
        fill="#111418",
        outline="#222a33",
        width=2,
    )
    draw.rounded_rectangle(
        (window_x, window_y, window_x + window_w, window_y + title_h),
        radius=radius,
        fill="#161b22",
    )
    draw.rectangle(
        (window_x, window_y + title_h - radius, window_x + window_w, window_y + title_h),
        fill="#161b22",
    )

    dot_y = window_y + 19
    for idx, color in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        left = window_x + 22 + (idx * 18)
        draw.ellipse((left, dot_y, left + 12, dot_y + 12), fill=color)

    draw.text((window_x + 78, window_y + 16), "zsh — terminal", font=title, fill="#d6dee8")

    prompt = (52, 211, 153)
    cmd = (230, 236, 241)
    dim = (148, 163, 184)
    blocked = (248, 113, 113)
    ok = (165, 243, 174)

    lines: list[tuple[str, str]] = [
        ("comment", "# resume-risk gate blocks a risky resumed session before spend"),
        ("cmd", "$ python3 src/hooks/guards/budget-guard.py"),
        ("dim", f"exit {budget_rc}"),
    ]
    lines.extend(("blocked", line) for line in wrap_text(budget_msg, 79))
    lines.extend(
        [
            ("blank", ""),
            ("comment", "# duplicate-read gate blocks the third pull of the same file"),
            ("cmd", "$ python3 src/hooks/guards/read-efficiency-guard.py"),
            ("dim", f"exit {read_rc}"),
        ]
    )
    lines.extend(("blocked", line) for line in wrap_text(read_msg, 79))
    lines.append(("blank", ""))
    for line in wrap_text(
        f"fresh cert {data['fresh_cert']} • live hooks {data['live_hooks']} • health {data['health']}",
        74,
    ):
        lines.append(("ok", line))
    lines.append(("comment", "# actual hook exits rendered from current repo"))

    y = window_y + title_h + 28
    for kind, text in lines:
        if kind == "blank":
            y += 18
            continue
        if kind == "cmd":
            draw_segments(
                draw,
                (window_x + 28, y),
                [
                    ("$ ", prompt),
                    (text[2:], cmd),
                ],
                regular,
            )
        else:
            color = {
                "comment": dim,
                "dim": dim,
                "blocked": blocked,
                "ok": ok,
                "repo": cmd,
            }[kind]
            prefix = "  " if kind in {"blocked", "dim", "ok", "repo"} else ""
            draw.text((window_x + 28, y), prefix + text, font=regular, fill=color)
        y += regular.size + 7

    footer = data["proof_date"]
    footer_w = int(draw.textlength(footer, font=small))
    draw.text((window_x + window_w - footer_w - 28, window_y + window_h - 34), footer, font=small, fill="#8b98a5")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)


if __name__ == "__main__":
    render(DEFAULT_OUTPUT)
