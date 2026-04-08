# X Launch Script

## Launch Window

Use this on Wednesday, April 8, 2026 in Pacific time.

## Launch Goal

The goal is not empty impressions. The goal is to make cold traffic believe three things fast:

1. The problem is real.
2. The repo actually works.
3. The builder is showing receipts instead of hype.

## Pre-Flight

- Attach `assets/social/launch-proof.png` to the first post.
- Do not overwrite a good existing X header just for launch. Change it only if you explicitly want a launch-specific profile surface.
- Keep the profile bio direct: `Building guardrails and observability for Claude Code token usage. Public repo. Proof over hype.`
- Link the public repo in the profile: `https://github.com/DrewDawson2027/claude-token-management`
- If GitHub profile pins are available, pin this repo before posting.

## Main Post

Post this first:

```text
Claude Code token drain is real, and preventable.

I built a local control plane that blocks repeated reads, wasteful subagents, risky resume flows, and bad routing before spend lands.

Cert: 10/10
Health: 42/42

https://github.com/DrewDawson2027/claude-token-management
```

## Immediate Reply

Reply to your own post within 2 minutes:

```text
Current proof:

- fresh runtime cert: 10/10
- live hooks: 481 passed
- health: 42/42
- drain benchmark: 9/9
- schemas: 1,307 docs, 0 errors
- coordinator: 316/316

Local control plane, not a fake Anthropic billing fix.
```

## Thread Version

If you want the longer version, use this thread instead of adding random replies later.

### Post 1

```text
Claude Code token drain is real, and preventable.

I built a local control plane that blocks repeated reads, wasteful subagents, risky resume flows, and bad routing before spend lands.

Repo:
https://github.com/DrewDawson2027/claude-token-management
```

### Post 2

```text
What it does:

- dispatch guard before spend
- duplicate/burst read control
- budget enforcement
- compatibility tracking for known drain issues
- live ops snapshots and status reporting
```

### Post 3

```text
Proof, not vibes:

- fresh-runtime cert: 10/10
- live hooks: 481 passed
- health-check: 42/42
- drain bench: 9/9
- schemas: 1,307 docs validated, 0 errors
- coordinator: 316/316
```

### Post 4

```text
The point is not "I fixed Anthropic."

The point is that a lot of token burn is locally preventable if you treat usage like an engineering problem instead of a mystery bill.
```

### Post 5

```text
If you have a Claude Code workflow that still burns usage badly, reply with the exact flow.

I want real repro cases, not vague complaints. I'll benchmark the strongest ones next.
```

## Follow-Up Reply

Post this 60 to 90 minutes later if the post gets any traction:

```text
The repo includes the hard numbers and the ugly parts too:

- what it can block locally
- what it can only warn on
- what still belongs to upstream Claude behavior

That honesty matters more than pretending every token problem is solved.
```

## Claims To Keep

- `blocks`
- `measures`
- `benchmarks`
- `warns`
- `routes around`
- `certifies`

## Claims To Avoid

- `fixes Claude`
- `fixes Anthropic billing`
- `guarantees savings for everyone`
- `solves every upstream issue`
- `viral open source breakthrough`

## Execution Notes

- Do not post ten times in a row from a brand-new account. One main post, one proof reply, and one later follow-up is enough.
- Do not hide the repo link in the fourth post of a long thread. Put it in the first post.
- Do not lead with architecture jargon. Lead with the cost problem and the receipts.
- If people ask for proof, link them straight to `README.md`, `docs/analysis/regression-results.md`, and `docs/analysis/component-grades.md`.
- Use `docs/release/REPLY_PACK.md` for fast objection handling instead of improvising under pressure.
