#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _load_validator():
    try:
        from jsonschema import Draft202012Validator

        return Draft202012Validator
    except ImportError:
        brew_python = Path("/opt/homebrew/bin/python3")
        if brew_python.exists() and Path(sys.executable) != brew_python:
            os.execv(str(brew_python), [str(brew_python), __file__, *sys.argv[1:]])
        print(
            "jsonschema is required for schema validation. Install it or run with /opt/homebrew/bin/python3.",
            file=sys.stderr,
        )
        raise SystemExit(2)


Draft202012Validator = _load_validator()

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = REPO_ROOT / "schemas" / "v1"
DATA_DIR = REPO_ROOT / "data"

for candidate in (
    REPO_ROOT,
    REPO_ROOT / "src" / "scripts" / "core",
    REPO_ROOT / "src" / "hooks" / "infrastructure",
    REPO_ROOT / "src" / "hooks" / "tracking",
    REPO_ROOT / "src" / "hooks" / "guards",
):
    candidate_str = str(candidate)
    if candidate.exists() and candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

from guard_contracts import (  # type: ignore  # noqa: E402
    build_audit_entry,
    build_metrics_lifecycle_entry,
    build_metrics_usage_entry,
)
from drain_bench import build_report, load_scenarios  # type: ignore  # noqa: E402


def load_schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))


def validate_doc(
    schema_name: str, doc: dict, label: str, errors: list[str], counts: dict[str, int]
) -> None:
    validator = Draft202012Validator(load_schema(schema_name))
    doc_errors = sorted(validator.iter_errors(doc), key=lambda err: list(err.path))
    counts[schema_name] = counts.get(schema_name, 0) + 1
    for err in doc_errors:
        path = ".".join(str(part) for part in err.absolute_path) or "<root>"
        errors.append(f"{label}: {path}: {err.message}")


def validate_jsonl_file(
    path: Path, schema_name: str, errors: list[str], counts: dict[str, int]
) -> None:
    for index, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        raw = raw.strip()
        if not raw:
            continue
        validate_doc(
            schema_name,
            json.loads(raw),
            f"{path.name}:{index}",
            errors,
            counts,
        )


def main() -> int:
    errors: list[str] = []
    counts: dict[str, int] = {}

    validate_doc(
        "audit-decision",
        build_audit_entry(
            event_type="block",
            subagent_type="Explore",
            description="Map the repo for duplicate-read hotspots",
            session_id="schema-audit",
            reason="necessity_check",
            matched_pattern="read_file",
            latency_ms=12,
            message="blocked for schema validation",
        ),
        "generated:audit:block",
        errors,
        counts,
    )
    validate_doc(
        "audit-decision",
        build_audit_entry(
            event_type="resume",
            subagent_type="general-purpose",
            description="resume validation",
            session_id="schema-audit",
            reason="resume",
        ),
        "generated:audit:resume",
        errors,
        counts,
    )
    validate_doc(
        "agent-metrics",
        build_metrics_lifecycle_entry(
            event="agent_started",
            agent_type="Explore",
            agent_id="agent-1",
            session_id="schema-metrics",
            decision_id="dec-1",
            duration_known=False,
        ),
        "generated:metrics:lifecycle",
        errors,
        counts,
    )
    validate_doc(
        "agent-metrics",
        build_metrics_usage_entry(
            agent_type="Explore",
            agent_id="agent-1",
            session_id="schema-metrics",
            totals={
                "input_tokens": 10,
                "output_tokens": 20,
                "cache_read_tokens": 30,
                "cache_creation_tokens": 40,
                "api_calls": 2,
            },
            cost_usd=1.25,
            decision_id="dec-1",
            correlated=True,
            transcript_found=True,
            usage_records_parsed=2,
            usage_records_skipped=0,
        ),
        "generated:metrics:usage",
        errors,
        counts,
    )

    validate_jsonl_file(DATA_DIR / "alerts" / "alerts.jsonl", "alert-event", errors, counts)
    validate_doc(
        "alert-state",
        json.loads((DATA_DIR / "alerts" / "alert-state.json").read_text(encoding="utf-8")),
        "alert-state.json",
        errors,
        counts,
    )

    for session_file in sorted((DATA_DIR / "sessions").glob("*.jsonl")):
        validate_jsonl_file(session_file, "session-summary", errors, counts)

    validate_doc(
        "cost-cache",
        json.loads((DATA_DIR / "cost-cache-snapshot.json").read_text(encoding="utf-8")),
        "cost-cache-snapshot.json",
        errors,
        counts,
    )
    validate_doc(
        "usage-index",
        json.loads((DATA_DIR / "usage-index-snapshot.json").read_text(encoding="utf-8")),
        "usage-index-snapshot.json",
        errors,
        counts,
    )
    validate_doc(
        "ops-snapshot",
        json.loads((DATA_DIR / "ops-snapshot.json").read_text(encoding="utf-8")),
        "ops-snapshot.json",
        errors,
        counts,
    )
    validate_doc(
        "benchmark-report",
        build_report(
            load_scenarios(
                str(REPO_ROOT / "tests" / "fixtures" / "token-drain-scenarios.json")
            )
        ),
        "generated:benchmark-report",
        errors,
        counts,
    )

    summary = {
        "schema_version": 1,
        "validated_documents": sum(counts.values()),
        "documents_by_schema": counts,
        "errors": len(errors),
    }
    print(json.dumps(summary, indent=2))
    if errors:
        for err in errors:
            print(err, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
