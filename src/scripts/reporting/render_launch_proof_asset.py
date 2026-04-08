#!/usr/bin/env python3
"""Render a documentary-style social asset from the current proof snapshot."""

from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "README.md"
REGRESSION_RESULTS = ROOT / "docs" / "analysis" / "regression-results.md"
DEFAULT_OUTPUT = ROOT / "assets" / "social" / "launch-proof.png"
FONT_REGULAR = "/System/Library/Fonts/Menlo.ttc"
FONT_BOLD = "/System/Library/Fonts/SFNSMono.ttf"


def load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def extract(pattern: str, text: str, name: str) -> str:
    match = re.search(pattern, text, re.MULTILINE)
    if not match:
        raise SystemExit(f"missing metric: {name}")
    return match.group(1)


def metrics() -> dict[str, str]:
    readme = load_text(README)
    regression = load_text(REGRESSION_RESULTS)
    schema_docs = extract(r"- `([\d,]+)` documents validated", regression, "schema_docs")
    schema_errors = extract(r"- `([\d,]+)` schema errors", regression, "schema_errors")
    return {
        "fresh_cert": extract(r"- `([^`]+)` checks passed", regression, "fresh_cert"),
        "vendored_hooks": extract(
            r"- `([^`]+)` in vendored hook tests", regression, "vendored_hooks"
        ),
        "repo_tests": extract(
            r"- `([^`]+)` in repo-native pytest coverage", regression, "repo_tests"
        ),
        "live_hooks": extract(r"- Hook suite: `([^`]+)`", regression, "live_hooks"),
        "health": extract(r"- Health-check: `([^`]+)`", regression, "health"),
        "drain_bench": extract(r"- Live drain benchmark: `([^`]+)`", regression, "drain_bench"),
        "coordinator": extract(
            r"- Source-tree coordinator suite: `([^`]+)`", regression, "coordinator"
        ),
        "schema_docs": schema_docs,
        "schema_errors": schema_errors,
        "proof_date": extract(
            r"## ([0-9-]+) Certification Snapshot", regression, "proof_date"
        ),
        "repo_url": extract(
            r"git clone https://github\.com/([A-Za-z0-9._/-]+)\.git",
            readme,
            "repo_url",
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


def render(output_path: Path) -> None:
    data = metrics()

    width, height = 1280, 720
    canvas = Image.new("RGB", (width, height), "#0b0d10")
    draw = ImageDraw.Draw(canvas)

    regular = ImageFont.truetype(FONT_REGULAR, 22)
    small = ImageFont.truetype(FONT_REGULAR, 20)
    title = ImageFont.truetype(FONT_BOLD, 21)

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

    draw.text(
        (window_x + 78, window_y + 14),
        f"launch-proof • {data['proof_date']}",
        font=title,
        fill="#d6dee8",
    )

    prompt_green = (52, 211, 153)
    cmd_white = (230, 236, 241)
    dim = (148, 163, 184)
    accent = (147, 197, 253)
    ok = (165, 243, 174)

    y = window_y + title_h + 30
    line_gap = 18

    lines: list[list[tuple[str, tuple[int, int, int]]]] = [
        [
            ("drew@mac-studio", prompt_green),
            (" ~/token-management ", accent),
            ("% ", prompt_green),
            ("python3 tests/run_token_system_regression.py", cmd_white),
        ],
        [("  " + data["fresh_cert"], ok)],
        [("  " + data["vendored_hooks"] + " in vendored hook tests", dim)],
        [("  repo-native tests: " + data["repo_tests"], dim)],
        [("  coordinator npm ci + spawn smoke passed", dim)],
        [],
        [
            ("drew@mac-studio", prompt_green),
            (" ~/.claude ", accent),
            ("% ", prompt_green),
            ("python3 -m pytest hooks/tests -q", cmd_white),
        ],
        [("  " + data["live_hooks"], ok)],
        [],
        [
            ("drew@mac-studio", prompt_green),
            (" ~/.claude ", accent),
            ("% ", prompt_green),
            ("bash hooks/health-check.sh", cmd_white),
        ],
        [("  " + data["health"], ok)],
        [("  drain bench: " + data["drain_bench"], dim)],
        [("  coordinator: " + data["coordinator"], dim)],
        [],
        [
            ("drew@mac-studio", prompt_green),
            (" ~/token-management ", accent),
            ("% ", prompt_green),
            ("python3 tests/validate_schemas.py", cmd_white),
        ],
        [("  " + data["schema_docs"] + " documents validated", ok)],
        [("  " + data["schema_errors"] + " schema errors", dim)],
        [],
        [("repo ", dim), (data["repo_url"], cmd_white)],
    ]

    for segments in lines:
        if segments:
            draw_segments(draw, (window_x + 28, y), segments, regular)
            y += regular.size + 6
        else:
            y += line_gap

    footer = "actual cert and live-runtime proof snapshot"
    footer_w = int(draw.textlength(footer, font=small))
    draw.text(
        (window_x + window_w - footer_w - 28, window_y + window_h - 34),
        footer,
        font=small,
        fill="#8b98a5",
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)


if __name__ == "__main__":
    render(DEFAULT_OUTPUT)
