# Compatibility Matrix

| Surface | Status | Notes |
|---|---|---|
| macOS live runtime | `Primary` | This is the main installed-runtime target. |
| Linux CI/runtime certification | `Supported` | Fresh-runtime cert and coordinator suite run in CI-friendly environments. |
| Windows | `Partial` | Some coordinator/platform code supports Windows paths and launch modes, but the full local control plane is not the primary target. |
| Homebrew Python + Node local setup | `Recommended local toolchain` | Used by the current repository certification path on macOS. |
| Pure system Python without extras | `Partial` | Schema validation may re-exec to Homebrew Python if `jsonschema` is unavailable. |

## Required Local Tools

- Python 3
- `pytest`
- `jsonschema`
- Node.js / npm for the coordinator suite

## Runtime Assumptions

- Installed target is `~/.claude`
- File locking and atomic replace semantics are available
- Shell runtime can execute the hook shell scripts
