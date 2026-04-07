#!/usr/bin/env python3
"""Pricing module — converts token counts to equivalent USD.

Official Anthropic API pricing (Feb 2026) from platform.claude.com/docs/en/about-claude/pricing.
Drew is on the Max 20x flat-rate plan ($200/mo), so these costs are
"what it would cost on pay-as-you-go" — useful for understanding value
and optimizing allocation usage.

Cache pricing multipliers (relative to base input):
  - 5-minute cache writes: 1.25x base input
  - 1-hour cache writes:   2x base input
  - Cache reads:           0.1x base input
"""

from __future__ import annotations

import re
from typing import Any

# All prices in USD per million tokens
PRICING_TABLE: dict[str, dict[str, float]] = {
    # --- Opus family ---
    "claude-opus-4-6": {
        "input": 5.00,
        "output": 25.00,
        "cache_write_5m": 6.25,
        "cache_write_1h": 10.00,
        "cache_read": 0.50,
    },
    "claude-opus-4-5": {
        "input": 5.00,
        "output": 25.00,
        "cache_write_5m": 6.25,
        "cache_write_1h": 10.00,
        "cache_read": 0.50,
    },
    "claude-opus-4-1": {
        "input": 15.00,
        "output": 75.00,
        "cache_write_5m": 18.75,
        "cache_write_1h": 30.00,
        "cache_read": 1.50,
    },
    "claude-opus-4": {
        "input": 15.00,
        "output": 75.00,
        "cache_write_5m": 18.75,
        "cache_write_1h": 30.00,
        "cache_read": 1.50,
    },
    # --- Sonnet family ---
    "claude-sonnet-4-6": {
        "input": 3.00,
        "output": 15.00,
        "cache_write_5m": 3.75,
        "cache_write_1h": 6.00,
        "cache_read": 0.30,
    },
    "claude-sonnet-4-5": {
        "input": 3.00,
        "output": 15.00,
        "cache_write_5m": 3.75,
        "cache_write_1h": 6.00,
        "cache_read": 0.30,
    },
    "claude-sonnet-4": {
        "input": 3.00,
        "output": 15.00,
        "cache_write_5m": 3.75,
        "cache_write_1h": 6.00,
        "cache_read": 0.30,
    },
    # --- Haiku family ---
    "claude-haiku-4-5": {
        "input": 1.00,
        "output": 5.00,
        "cache_write_5m": 1.25,
        "cache_write_1h": 2.00,
        "cache_read": 0.10,
    },
    "claude-haiku-3-5": {
        "input": 0.80,
        "output": 4.00,
        "cache_write_5m": 1.00,
        "cache_write_1h": 1.60,
        "cache_read": 0.08,
    },
}

# Fallback for unknown models — use Sonnet pricing (middle tier)
DEFAULT_PRICING = PRICING_TABLE["claude-sonnet-4-5"]


def normalize_model_name(raw_model: str) -> str:
    """Normalize raw model identifiers to canonical pricing keys.

    Handles formats like:
      'claude-opus-4-6'                    → 'claude-opus-4-6'
      'claude-opus-4-5-20251101'           → 'claude-opus-4-5'
      'claude-sonnet-4-5-20250929'         → 'claude-sonnet-4-5'
      'claude-haiku-4-5-20251001'          → 'claude-haiku-4-5'
      'claude-3-5-sonnet-20241022'         → 'claude-sonnet-3-5' (legacy)
    """
    if not raw_model:
        return ""

    model = raw_model.lower().strip()

    # Strip date suffixes like -20251101
    model = re.sub(r"-\d{8,}$", "", model)

    # Handle legacy format: claude-3-5-sonnet → claude-sonnet-3-5
    legacy_match = re.match(r"claude-(\d+(?:-\d+)?)-(\w+)", model)
    if legacy_match:
        version = legacy_match.group(1)
        family = legacy_match.group(2)
        if family in ("opus", "sonnet", "haiku"):
            model = f"claude-{family}-{version}"

    return model


def get_model_pricing(model: str) -> dict[str, float]:
    """Get pricing for a model, with normalization and fallback."""
    normalized = normalize_model_name(model)
    return PRICING_TABLE.get(normalized, DEFAULT_PRICING)


def calculate_cost(
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
    cache_5m_tokens: int = 0,
    cache_1h_tokens: int = 0,
) -> float:
    """Calculate equivalent USD cost for a set of token counts.

    Args:
        model: Raw model identifier (will be normalized)
        input_tokens: Fresh (non-cached) input tokens
        output_tokens: Output tokens generated
        cache_read_tokens: Tokens read from cache
        cache_creation_tokens: Total cache creation tokens (if 5m/1h split unknown)
        cache_5m_tokens: 5-minute cache write tokens
        cache_1h_tokens: 1-hour cache write tokens

    If cache_5m_tokens and cache_1h_tokens are both 0 but cache_creation_tokens > 0,
    we assume 1h cache pricing (conservative — Claude Code uses 1h cache by default).
    """
    pricing = get_model_pricing(model)

    # Fresh input (subtract cache reads from reported input_tokens if needed)
    # Note: Anthropic API reports input_tokens as fresh input only (not including cache reads)
    input_cost = (input_tokens / 1_000_000) * pricing["input"]
    output_cost = (output_tokens / 1_000_000) * pricing["output"]
    cache_read_cost = (cache_read_tokens / 1_000_000) * pricing["cache_read"]

    # Cache write cost — use granular 5m/1h if available, otherwise assume 1h
    if cache_5m_tokens > 0 or cache_1h_tokens > 0:
        cache_write_cost = (
            (cache_5m_tokens / 1_000_000) * pricing["cache_write_5m"]
            + (cache_1h_tokens / 1_000_000) * pricing["cache_write_1h"]
        )
    elif cache_creation_tokens > 0:
        # Default to 1h pricing (Claude Code's default cache duration)
        cache_write_cost = (cache_creation_tokens / 1_000_000) * pricing["cache_write_1h"]
    else:
        cache_write_cost = 0

    return round(input_cost + output_cost + cache_read_cost + cache_write_cost, 6)


def calculate_cost_from_usage(model: str, usage: dict[str, Any]) -> float:
    """Calculate cost directly from an API usage dict (as found in session JSONL).

    Handles the full usage structure:
    {
        "input_tokens": 3,
        "output_tokens": 22,
        "cache_creation_input_tokens": 19220,
        "cache_read_input_tokens": 22123,
        "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 19220
        }
    }
    """
    if not usage:
        return 0.0

    input_tokens = int(usage.get("input_tokens", 0) or 0)
    output_tokens = int(usage.get("output_tokens", 0) or 0)
    cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
    cache_creation = int(usage.get("cache_creation_input_tokens", 0) or 0)

    # Extract granular cache write breakdown if available
    cache_detail = usage.get("cache_creation", {}) or {}
    cache_5m = int(cache_detail.get("ephemeral_5m_input_tokens", 0) or 0)
    cache_1h = int(cache_detail.get("ephemeral_1h_input_tokens", 0) or 0)

    return calculate_cost(
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read,
        cache_creation_tokens=cache_creation,
        cache_5m_tokens=cache_5m,
        cache_1h_tokens=cache_1h,
    )


def format_cost(usd: float | None) -> str:
    """Format USD cost for display."""
    if usd is None:
        return "n/a"
    if usd < 0.01:
        return f"${usd:.4f}"
    if usd < 1.00:
        return f"${usd:.2f}"
    return f"${usd:,.2f}"


def get_pricing_table() -> dict[str, dict[str, float]]:
    """Return the full pricing table (for serialization/display)."""
    return dict(PRICING_TABLE)


# ---------------------------------------------------------------------------
# CLI self-test
# ---------------------------------------------------------------------------

def _self_test() -> None:
    """Quick validation of pricing calculations."""
    print("=== Pricing Module Self-Test ===\n")

    # Test normalize_model_name
    tests = [
        ("claude-opus-4-6", "claude-opus-4-6"),
        ("claude-opus-4-5-20251101", "claude-opus-4-5"),
        ("claude-sonnet-4-5-20250929", "claude-sonnet-4-5"),
        ("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
        ("claude-sonnet-4-6", "claude-sonnet-4-6"),
    ]
    print("Model normalization:")
    for raw, expected in tests:
        result = normalize_model_name(raw)
        status = "OK" if result == expected else f"FAIL (got {result})"
        print(f"  {raw} → {result} [{status}]")

    print("\nCost calculations:")

    # Test: 1M input + 1M output for each model tier
    for model_key in ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]:
        cost = calculate_cost(model_key, input_tokens=1_000_000, output_tokens=1_000_000)
        pricing = PRICING_TABLE[model_key]
        expected = pricing["input"] + pricing["output"]
        status = "OK" if abs(cost - expected) < 0.001 else f"FAIL (expected {expected})"
        print(f"  {model_key}: 1M in + 1M out = {format_cost(cost)} [{status}]")

    # Test: Cache reads (should be 0.1x input)
    cost_cache = calculate_cost("claude-opus-4-6", cache_read_tokens=1_000_000)
    print(f"  Opus cache read 1M = {format_cost(cost_cache)} [expected $0.50]")

    # Test: Cache write 1h (should be 2x input)
    cost_write = calculate_cost("claude-opus-4-6", cache_1h_tokens=1_000_000)
    print(f"  Opus 1h cache write 1M = {format_cost(cost_write)} [expected $10.00]")

    # Test: Real-world usage dict
    usage = {
        "input_tokens": 3,
        "output_tokens": 22,
        "cache_creation_input_tokens": 19220,
        "cache_read_input_tokens": 22123,
        "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 19220,
        },
    }
    cost_real = calculate_cost_from_usage("claude-opus-4-6", usage)
    print(f"\n  Real-world usage dict (Opus): {format_cost(cost_real)}")
    print(f"    input: 3 tokens, output: 22, cache_read: 22,123, cache_write_1h: 19,220")

    # Test: This month's totals from usage-index
    # Opus 4.6: 686K input, 3.78M output, 157M cache create, 3.52B cache read
    month_opus = calculate_cost(
        "claude-opus-4-6",
        input_tokens=686073,
        output_tokens=3775574,
        cache_read_tokens=3522387776,
        cache_1h_tokens=157019473,
    )
    # Sonnet 4.5: 953K input, 163K output, 157M cache create, 1.59B cache read
    month_sonnet = calculate_cost(
        "claude-sonnet-4-5",
        input_tokens=953415,
        output_tokens=163416,
        cache_read_tokens=1585258170,
        cache_1h_tokens=157195497,
    )
    print(f"\n  This month estimates:")
    print(f"    Opus 4.6:   {format_cost(month_opus)}")
    print(f"    Sonnet 4.5: {format_cost(month_sonnet)}")
    print(f"    Combined:   {format_cost(month_opus + month_sonnet)}")
    print(f"\n  (vs $200/mo flat rate)")


if __name__ == "__main__":
    import sys
    if "--test" in sys.argv:
        _self_test()
    else:
        print("Usage: python3 pricing.py --test")
        print("  Or import: from pricing import calculate_cost, calculate_cost_from_usage")
