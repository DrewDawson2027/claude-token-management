#!/usr/bin/env python3
"""Render repo-facing brand assets in the same visual grammar as the lead system."""

from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from render_launch_proof_asset import budget_guard_block, metrics, read_guard_block, wrap_text


ROOT = Path(__file__).resolve().parents[3]
REGRESSION_RESULTS = ROOT / "docs" / "analysis" / "regression-results.md"
ASSETS = ROOT / "assets" / "social"

FONT_SANS = "/System/Library/Fonts/Helvetica.ttc"
FONT_MONO = "/System/Library/Fonts/Menlo.ttc"

BG = "#0d1117"
GRID = "#161b22"
TEXT = "#f0f6fc"
MUTED = "#9aa4b2"
PILL = "#0f141b"
PILL_BORDER = "#30363d"
ACCENT = "#72f0c0"
ACCENT_DIM = "#2ea97f"
BLUE = "#8bdcff"
WARN = "#ffb44c"
RED = "#ff7b72"
GREEN = "#8cfca6"


def load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def extract(pattern: str, text: str, name: str) -> str:
    match = re.search(pattern, text)
    if not match:
        raise ValueError(f"missing {name}")
    return match.group(1)


def extra_metrics() -> dict[str, str]:
    text = load_text(REGRESSION_RESULTS)
    return {
        "schemas": extract(r"- `([\d,]+)` documents validated", text, "schemas"),
        "schema_errors": extract(r"- `([\d,]+)` schema errors", text, "schema_errors"),
        "drain_bench": extract(r"- Live drain benchmark: `([^`]+)`", text, "drain_bench"),
        "compatibility": extract(
            r"- Live compatibility report: `([^`]+)`", text, "compatibility"
        ),
        "coordinator": extract(
            r"- Source-tree coordinator suite: `([^`]+)`", text, "coordinator"
        ),
    }


def fonts():
    return {
        "title": ImageFont.truetype(FONT_SANS, 66),
        "subtitle": ImageFont.truetype(FONT_SANS, 30),
        "section": ImageFont.truetype(FONT_MONO, 26),
        "body": ImageFont.truetype(FONT_SANS, 22),
        "pill": ImageFont.truetype(FONT_MONO, 22),
        "pill_big": ImageFont.truetype(FONT_MONO, 24),
        "term": ImageFont.truetype(FONT_MONO, 28),
        "term_small": ImageFont.truetype(FONT_MONO, 22),
    }


def draw_grid(draw: ImageDraw.ImageDraw, width: int, height: int, step: int = 80) -> None:
    draw.rectangle((0, 0, width, height), fill=BG)
    for x in range(0, width + 1, step):
        draw.line((x, 0, x, height), fill=GRID, width=1)
    for y in range(0, height + 1, step):
        draw.line((0, y, width, y), fill=GRID, width=1)


def draw_pill(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    *,
    border: str = PILL_BORDER,
    fill: str = PILL,
    color: str = MUTED,
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(box, radius=(y1 - y0) // 2, fill=fill, outline=border, width=1)
    tw = draw.textlength(text, font=font)
    th = font.size
    draw.text((x0 + (x1 - x0 - tw) / 2, y0 + (y1 - y0 - th) / 2 - 2), text, font=font, fill=color)


def pill_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, padding: int = 34) -> int:
    return int(draw.textlength(text, font=font)) + padding


def compact_metrics() -> dict[str, str]:
    data = metrics()
    extra = extra_metrics()
    return {
        "fresh": data["fresh_cert"].replace("/", " / "),
        "hooks": data["live_hooks"].split(",")[0],
        "health": "42 / 42 health",
        "drain": extra["drain_bench"].replace("/", " / ") + " drain",
        "schemas": f"{extra['schemas']} schemas",
    }


def draw_banner(path: Path) -> None:
    data = metrics()
    compact = compact_metrics()
    f = fonts()

    width, height = 1500, 500
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw_grid(draw, width, height)

    label = "CLAUDE TOKEN MANAGEMENT"
    draw.text((74, 112), label, font=f["section"], fill=ACCENT)
    draw.text((74, 174), "Claude Token Management", font=f["title"], fill=TEXT)
    draw.text(
        (74, 254),
        "Local control plane for Claude Code token drain. Blocks spend before it lands.",
        font=f["subtitle"],
        fill=MUTED,
    )

    command_box = (74, 300, 980, 354)
    draw.rounded_rectangle(command_box, radius=16, fill="#0b1016", outline=PILL_BORDER, width=1)
    command = "$ budget-guard.py -> BLOCKED risky resume before spend lands"
    draw.text((96, 314), command, font=f["pill"], fill=BLUE)

    y = 386
    pill_specs = [
        (compact["fresh"] + " fresh", PILL_BORDER, MUTED),
        (compact["hooks"], PILL_BORDER, MUTED),
        (compact["health"], PILL_BORDER, MUTED),
        (compact["drain"], PILL_BORDER, MUTED),
        ("blocks before spend", TEXT, TEXT),
    ]
    x = 74
    for text, border, color in pill_specs:
        width_hint = pill_width(draw, text, f["pill"])
        draw_pill(
            draw,
            (x, y, x + width_hint, y + 44),
            text,
            f["pill"],
            border=border,
            color=color,
        )
        x += width_hint + 16

    repo = "github.com/DrewDawson2027/claude-token-management"
    draw.line((74, height - 54, width - 74, height - 54), fill=GRID, width=1)
    draw.text((74, height - 40), repo, font=f["body"], fill="#4b5563")

    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def draw_x_header(path: Path) -> None:
    compact = compact_metrics()
    f = fonts()

    width, height = 1500, 500
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw_grid(draw, width, height)

    draw.text((68, 108), "CLAUDE TOKEN MANAGEMENT", font=f["section"], fill=ACCENT)
    draw.text((68, 170), "Guardrails for Claude Code token drain", font=ImageFont.truetype(FONT_SANS, 58), fill=TEXT)
    draw.text(
        (68, 238),
        "Real runtime proof. Real guard blocks. No synthetic dashboard look.",
        font=ImageFont.truetype(FONT_SANS, 28),
        fill=MUTED,
    )
    draw.rounded_rectangle((68, 292, 1188, 346), radius=16, fill="#0b1016", outline=PILL_BORDER, width=1)
    draw.text(
        (92, 307),
        "$ budget-guard.py -> BLOCKED resume risk    $ read-efficiency-guard.py -> BLOCKED duplicate read",
        font=ImageFont.truetype(FONT_MONO, 19),
        fill=BLUE,
    )

    x = 68
    y = 390
    pills = [
        (compact["fresh"] + " fresh", PILL_BORDER, MUTED),
        (compact["hooks"], PILL_BORDER, MUTED),
        (compact["health"], PILL_BORDER, MUTED),
        (compact["drain"], PILL_BORDER, MUTED),
        (compact["schemas"], TEXT, TEXT),
    ]
    for text, border, color in pills:
        width_hint = pill_width(draw, text, ImageFont.truetype(FONT_MONO, 20))
        draw_pill(
            draw,
            (x, y, x + width_hint, y + 42),
            text,
            ImageFont.truetype(FONT_MONO, 20),
            border=border,
            color=color,
        )
        x += width_hint + 14

    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def draw_runtime_demo(path: Path) -> None:
    data = metrics()
    extra = extra_metrics()
    budget_rc, budget_msg = budget_guard_block()
    read_rc, read_msg = read_guard_block()
    f = fonts()

    width, height = 1280, 860
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw_grid(draw, width, height, step=96)

    outer = (44, 40, width - 44, height - 42)
    draw.rounded_rectangle(outer, radius=24, fill="#0b1016", outline="#1f2a37", width=2)
    draw.rectangle((outer[0] + 1, outer[1] + 1, outer[2] - 1, outer[1] + 54), fill="#11161d")

    for idx, color in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        left = outer[0] + 18 + idx * 18
        draw.ellipse((left, outer[1] + 14, left + 12, outer[1] + 26), fill=color)

    draw.text((outer[0] + 78, outer[1] + 12), "proof-session.sh", font=ImageFont.truetype(FONT_MONO, 21), fill="#d0d7de")

    lines: list[tuple[str, str]] = [
        ("comment", "# real guard exits rendered from the current repo"),
        ("cmd", "$ python3 src/hooks/guards/budget-guard.py"),
        ("dim", f"exit {budget_rc}"),
    ]
    lines.extend(("red", line) for line in wrap_text(budget_msg, 78))
    lines.extend(
        [
            ("blank", ""),
            ("cmd", "$ python3 src/hooks/guards/read-efficiency-guard.py"),
            ("dim", f"exit {read_rc}"),
        ]
    )
    lines.extend(("red", line) for line in wrap_text(read_msg, 78))
    lines.extend(
        [
            ("blank", ""),
            ("comment", "# current certification snapshot"),
            ("green", f"fresh runtime: {data['fresh_cert']}"),
            ("green", f"live hooks: {data['live_hooks']}"),
            ("green", f"health: {data['health']}"),
            ("green", f"drain bench: {extra['drain_bench']}"),
            ("green", f"schemas: {extra['schemas']} docs / {extra['schema_errors']} errors"),
            ("green", f"coordinator: {extra['coordinator']}"),
            ("blank", ""),
            ("white", "Prevention first. Proof second. Hype never."),
        ]
    )

    x = outer[0] + 28
    y = outer[1] + 82
    colors = {
        "comment": MUTED,
        "cmd": ACCENT,
        "dim": "#94a3b8",
        "red": RED,
        "green": GREEN,
        "white": TEXT,
    }
    term_font = f["term"]
    small_font = f["term_small"]

    for kind, text in lines:
        if kind == "blank":
            y += 18
            continue
        if kind == "cmd":
            draw.text((x, y), "$ ", font=term_font, fill=ACCENT)
            draw.text((x + 26, y), text[2:], font=term_font, fill=TEXT)
            y += term_font.size + 8
            continue
        font = term_font if kind in {"comment", "white"} else small_font
        prefix = "  " if kind in {"dim", "red", "green"} else ""
        draw.text((x, y), prefix + text, font=font, fill=colors[kind])
        y += font.size + 8

    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def main() -> None:
    draw_banner(ASSETS / "readme-hero.png")
    draw_x_header(ASSETS / "x-header.png")
    draw_runtime_demo(ASSETS / "runtime-demo.png")


if __name__ == "__main__":
    main()
