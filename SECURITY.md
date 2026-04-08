# Security Policy

## Supported Versions

| Branch | Status |
|---|---|
| `main` | Supported |
| historical tags | Best effort only |

## Reporting A Vulnerability

Preferred path:

1. Use GitHub private vulnerability reporting if it is enabled for this repository.
2. If private reporting is unavailable, open a GitHub issue with only non-sensitive metadata and request a private follow-up channel.

Do not post secrets, credentials, session transcripts containing private data, or exploit payloads in a public issue.

## What Counts As Security Relevant Here

- guard bypasses that allow blocked tool use to proceed silently
- file-permission or shell-execution flaws in the installed runtime
- message or task injection paths in the coordinator
- unsafe handling of transcripts, alerts, audit logs, or session summaries
- state corruption paths that can suppress enforcement or falsify reporting

## Response Targets

- initial triage: within 3 business days
- confirmed severity assessment: within 7 business days
- fix target for critical issues: as fast as practical, with public follow-up after a safe patch exists
