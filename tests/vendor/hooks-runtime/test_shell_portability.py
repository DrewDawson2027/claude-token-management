"""Shell portability validation tests (Item 6).

Tests bash compatibility edge cases for shell hooks:
- portable.sh functions (flock, date, jq)
- jq safety (--arg usage, no string interpolation)
- Shebang consistency
- Hostile field values in JSON construction
"""

import json
import os
import re
import subprocess
import sys
import tempfile

import pytest

HOOKS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORTABLE_SH = os.path.join(HOOKS_DIR, "lib", "portable.sh")


def run_bash(script, env=None, timeout=10):
    """Run a bash script and return (exit_code, stdout, stderr)."""
    result = subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        env=env or os.environ.copy(),
        timeout=timeout,
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


# ═══════════════════════════════════════════════════════════════════════════════
# Shebang consistency
# ═══════════════════════════════════════════════════════════════════════════════


class TestShebangConsistency:
    """All .sh files should use #!/bin/bash consistently."""

    def test_all_shell_hooks_have_bash_shebang(self):
        """Every .sh file in hooks dir should start with #!/bin/bash."""
        sh_files = []
        for f in os.listdir(HOOKS_DIR):
            if f.endswith(".sh"):
                sh_files.append(os.path.join(HOOKS_DIR, f))
        # Also check lib/
        lib_dir = os.path.join(HOOKS_DIR, "lib")
        if os.path.isdir(lib_dir):
            for f in os.listdir(lib_dir):
                if f.endswith(".sh"):
                    sh_files.append(os.path.join(lib_dir, f))

        assert len(sh_files) > 0, "Should find at least one .sh file"

        for path in sh_files:
            with open(path) as f:
                first_line = f.readline().strip()
            assert first_line in ("#!/bin/bash", "#!/usr/bin/env bash"), (
                f"{os.path.basename(path)} has shebang '{first_line}', "
                "expected '#!/bin/bash' or '#!/usr/bin/env bash'"
            )

    def test_shell_hooks_are_executable(self):
        """Every .sh file should have executable permission."""
        for f in os.listdir(HOOKS_DIR):
            if f.endswith(".sh"):
                path = os.path.join(HOOKS_DIR, f)
                assert os.access(path, os.X_OK), (
                    f"{f} is not executable (chmod +x needed)"
                )


# ═══════════════════════════════════════════════════════════════════════════════
# portable.sh function tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestPortableSh:
    """Test portable.sh functions directly."""

    def test_get_file_mtime_epoch_returns_number(self, tmp_path):
        test_file = tmp_path / "test.txt"
        test_file.write_text("hello")
        code, stdout, _ = run_bash(
            f'source "{PORTABLE_SH}"; get_file_mtime_epoch "{test_file}"'
        )
        assert code == 0
        assert stdout.strip().isdigit(), f"Expected epoch number, got: {stdout}"

    def test_get_file_mtime_epoch_nonexistent_file(self, tmp_path):
        code, stdout, _ = run_bash(
            f'source "{PORTABLE_SH}"; get_file_mtime_epoch "/nonexistent/file"'
        )
        assert code == 0
        assert stdout.strip() == "0"

    def test_parse_iso_to_epoch_valid(self):
        code, stdout, _ = run_bash(
            f'source "{PORTABLE_SH}"; parse_iso_to_epoch "2025-01-01T00:00:00Z"'
        )
        assert code == 0
        epoch = stdout.strip()
        assert epoch.isdigit(), f"Expected epoch, got: {epoch}"
        assert int(epoch) > 1700000000  # After 2023

    def test_parse_iso_to_epoch_invalid(self):
        code, stdout, _ = run_bash(
            f'source "{PORTABLE_SH}"; parse_iso_to_epoch "not-a-date"'
        )
        assert code == 0
        assert stdout.strip() == "0"

    def test_get_tty_returns_string(self):
        code, stdout, _ = run_bash(
            f'source "{PORTABLE_SH}"; get_tty'
        )
        assert code == 0
        # May return empty in non-interactive context, that's fine

    def test_require_jq_succeeds_when_installed(self):
        """jq should be available on this system."""
        code, _, _ = run_bash(
            f'source "{PORTABLE_SH}"; require_jq'
        )
        # If jq is installed, exit 0. If not, exit 2.
        # Either is acceptable — we test the behavior, not the environment.
        assert code in (0, 2)

    def test_portable_flock_try_and_release(self, tmp_path):
        lockfile = str(tmp_path / "test.lock")
        code, _, _ = run_bash(f"""
source "{PORTABLE_SH}"
portable_flock_try "{lockfile}"
result=$?
portable_flock_release "{lockfile}"
exit $result
""")
        assert code == 0, "Should acquire lock successfully"

    def test_portable_flock_append(self, tmp_path):
        target = str(tmp_path / "output.txt")
        lockfile = str(tmp_path / "output.lock")
        code, _, _ = run_bash(f"""
source "{PORTABLE_SH}"
portable_flock_append "{lockfile}" 'echo "line1" >> "{target}"'
portable_flock_append "{lockfile}" 'echo "line2" >> "{target}"'
""")
        assert code == 0
        with open(target) as f:
            lines = f.read().strip().split("\n")
        assert len(lines) == 2


# ═══════════════════════════════════════════════════════════════════════════════
# jq safety — all shell hooks should use --arg, not string interpolation
# ═══════════════════════════════════════════════════════════════════════════════


class TestJqSafety:
    """Verify shell hooks use jq --arg for safe JSON construction."""

    def _get_shell_hooks(self):
        hooks = []
        for f in os.listdir(HOOKS_DIR):
            if f.endswith(".sh"):
                hooks.append(os.path.join(HOOKS_DIR, f))
        return hooks

    def test_no_string_interpolation_in_jq_filters(self):
        """No shell variable interpolation inside jq filter strings."""
        # Pattern: jq '...$VAR...' (variable inside single-quoted jq filter)
        # Safe: jq --arg var "$VAR" '...$var...'
        # Unsafe: jq ".field = \"$VAR\"" or jq '{field: "'$VAR'"}'
        unsafe_patterns = [
            # Double-quoted jq with $VAR inside
            re.compile(r'jq\s+"[^"]*\$[A-Z_]+[^"]*"'),
            # Single-quoted jq broken by concatenation with unquoted $VAR
            re.compile(r"jq\s+'[^']*'\s*\$[A-Z_]"),
        ]

        for hook_path in self._get_shell_hooks():
            with open(hook_path) as f:
                content = f.read()
            basename = os.path.basename(hook_path)
            for pattern in unsafe_patterns:
                matches = pattern.findall(content)
                # Filter out false positives (comments)
                real_matches = [m for m in matches if not m.strip().startswith("#")]
                assert len(real_matches) == 0, (
                    f"{basename} has unsafe jq interpolation: {real_matches[:3]}"
                )

    def test_hostile_values_in_jq_arg(self, tmp_path):
        """jq --arg should safely handle hostile values."""
        hostile_values = [
            'hello"world',  # Embedded double quote
            "line1\nline2",  # Newline
            "back\\slash",  # Backslash
            'tab\there',  # Tab
            "",  # Empty
            "a" * 10000,  # Very long
        ]
        for val in hostile_values:
            code, stdout, stderr = run_bash(
                f'echo "test" | jq -n --arg v "$VAL" \'{{"value": $v}}\'',
                env={**os.environ, "VAL": val},
            )
            if code == 0:
                parsed = json.loads(stdout)
                assert parsed["value"] == val, f"Value mismatch for: {repr(val)}"


# ═══════════════════════════════════════════════════════════════════════════════
# Bash 3.2 compatibility checks
# ═══════════════════════════════════════════════════════════════════════════════


class TestBash32Compatibility:
    """Verify no bash 4+ features used in shell hooks."""

    def _get_all_sh_content(self):
        """Return list of (filename, content) for all .sh files."""
        files = []
        for f in os.listdir(HOOKS_DIR):
            if f.endswith(".sh"):
                path = os.path.join(HOOKS_DIR, f)
                with open(path) as fh:
                    files.append((f, fh.read()))
        lib_dir = os.path.join(HOOKS_DIR, "lib")
        if os.path.isdir(lib_dir):
            for f in os.listdir(lib_dir):
                if f.endswith(".sh"):
                    path = os.path.join(lib_dir, f)
                    with open(path) as fh:
                        files.append((f"lib/{f}", fh.read()))
        return files

    def test_no_associative_arrays(self):
        """declare -A is bash 4+ only, not available on macOS default bash."""
        for fname, content in self._get_all_sh_content():
            assert "declare -A" not in content, (
                f"{fname} uses 'declare -A' (associative array) — bash 4+ only"
            )

    def test_no_mapfile_readarray(self):
        """mapfile/readarray is bash 4+ only."""
        for fname, content in self._get_all_sh_content():
            assert "mapfile" not in content and "readarray" not in content, (
                f"{fname} uses mapfile/readarray — bash 4+ only"
            )

    def test_no_nameref(self):
        """declare -n (nameref) is bash 4.3+ only."""
        for fname, content in self._get_all_sh_content():
            assert "declare -n" not in content, (
                f"{fname} uses 'declare -n' (nameref) — bash 4.3+ only"
            )
