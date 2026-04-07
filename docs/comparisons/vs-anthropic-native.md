# Vs Anthropic Native

Anthropic native features and this repository solve overlapping but different problems.

| Capability | Anthropic Native | This Repository | Current Read |
|---|---|---|---|
| Product-authoritative billing and limits | Native | No | Anthropic wins. Local code cannot replace native billing truth. |
| Local pre-spend dispatch blocking | Limited | Yes | Repository wins for local guardrails before spend. |
| Local operator telemetry over subagents and sessions | Limited publicly | Yes | Repository wins for local attribution depth. |
| Local workflow enforcement around review/build chains | No | Yes | Repository wins for custom operator workflows. |
| Native prompt-cache behavior control | Native only | No | Anthropic wins. |
| Native throttling/rate-limit control | Native only | No | Anthropic wins. |
| Local customization and override policy | Limited | Yes | Repository wins. |
| Product support and service-level guarantees | Yes | No | Anthropic wins. |

## Honest Position

This repository should not be described as “better than the product” in a blanket sense. The accurate claim is narrower:

- It is stronger for local prevention, attribution, and operator customization.
- Anthropic remains authoritative for billing, cache behavior, rate limits, and platform policy.

## Why The Repository Still Matters

Most user pain in token-drain situations is operational, not theoretical:

- “Why did usage spike?”
- “Which worker caused it?”
- “Why did the read pattern explode?”
- “Why did this prompt path use the wrong model?”
- “Why was I not warned before the session was already gone?”

Native product layers do not currently expose all of that local control-plane behavior. This repository exists to close that gap without pretending it can replace the platform.
