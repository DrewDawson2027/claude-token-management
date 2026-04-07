#!/usr/bin/env python3
import json
import os
import sys

ALLOWED_MODELS = {"sonnet", "haiku"}


def normalize_model(value):
    raw = str(value or "").strip().lower()
    if raw in ALLOWED_MODELS:
        return raw
    if raw.startswith("claude-sonnet-"):
        return "sonnet"
    if raw.startswith("claude-haiku-"):
        return "haiku"
    return ""


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def resolve_configured_model():
    claude_dir = os.path.expanduser("~/.claude")
    for name in ("settings.local.json", "settings.json"):
        data = read_json(os.path.join(claude_dir, name))
        if isinstance(data, dict):
            normalized = normalize_model(data.get("model"))
            if normalized:
                return normalized, name
    return "", ""


def block(reason):
    print(json.dumps({"reason": reason}))
    sys.exit(2)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if str(payload.get("tool_name") or "") != "Task":
        sys.exit(0)

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}

    explicit_model = str(tool_input.get("model") or "").strip()
    normalized = normalize_model(explicit_model)
    if explicit_model and not normalized:
        block(
            f"BLOCKED: unsupported model '{explicit_model}'. Only sonnet and haiku workers are allowed."
        )

    if normalized:
        sys.exit(0)

    configured_model, source = resolve_configured_model()
    if configured_model in ALLOWED_MODELS:
        sys.exit(0)

    location = source or "settings.local.json/settings.json"
    block(
        f"BLOCKED: worker model must resolve to sonnet or haiku. No supported default found in {location}."
    )


if __name__ == "__main__":
    main()
