"""Normalization helpers for token management hooks.

Centralizes sanitization/normalization of session IDs, text fields, and paths so
all hooks persist safe, stable identifiers while remaining backward compatible.
"""

from __future__ import annotations

import hashlib
import os
import re
from typing import Any

CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
ALLOWED_SESSION_RE = re.compile(r"[A-Za-z0-9_-]+")


def normalize_text(value: Any, max_len: int = 512) -> str:
    """Return a bounded, printable single-line string."""
    if value is None:
        return ""
    text = str(value)
    text = CONTROL_CHARS_RE.sub(" ", text)
    text = " ".join(text.split())
    return text[:max_len]


def normalize_subagent_type(value: Any, max_len: int = 80) -> str:
    text = normalize_text(value, max_len=max_len)
    return text or "unknown"


def normalize_session_key(raw_session_id: Any, max_len: int = 12) -> str:
    """Create a safe persisted session key from arbitrary hook payload values.

    Prevents path traversal strings and control characters from being written to
    audit/metrics logs. Uses a stable hash fallback when the source string has no
    safe characters.
    """
    raw = normalize_text(raw_session_id, max_len=256)
    if not raw:
        return "unknown"

    tokens = ALLOWED_SESSION_RE.findall(raw)
    joined = "-".join(t for t in tokens if t)
    joined = re.sub(r"-+", "-", joined).strip("-")

    if joined:
        # avoid preserving obvious path traversal artifacts verbatim
        joined = joined.replace("..", "")
        joined = joined.strip("-")
    if not joined:
        digest = hashlib.sha256(raw.encode("utf-8", "ignore")).hexdigest()[:10]
        joined = f"sid-{digest}"

    return joined[:max_len]


def is_invalid_session_key(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return True
    if "/" in value or "\\" in value or ".." in value:
        return True
    if CONTROL_CHARS_RE.search(value):
        return True
    return False


def normalize_file_path(path: Any) -> str:
    """Return a canonical best-effort path for duplicate detection and logs."""
    text = normalize_text(path, max_len=4096)
    if not text:
        return ""
    expanded = os.path.expanduser(text)
    normed = os.path.normpath(expanded)
    try:
        # realpath collapses symlinks where possible; path need not exist
        return os.path.realpath(normed)
    except OSError:
        return os.path.abspath(normed)


def short_hash(value: str, length: int = 12) -> str:
    return hashlib.sha256((value or "").encode("utf-8", "ignore")).hexdigest()[:length]
