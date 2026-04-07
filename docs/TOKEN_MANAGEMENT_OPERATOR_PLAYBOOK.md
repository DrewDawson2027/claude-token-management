# Token Management Operator Playbook

## Daily Commands

```bash
npm run cert:schemas
npm run cert:a-plus:fresh
PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/npm --prefix src/coordinator test
```

## Live Runtime Checks

```bash
cd ~/.claude && python3 -m pytest hooks/tests -q
bash ~/.claude/hooks/health-check.sh
```

## Fast Triage Order

1. Run schema validation.
2. Run fresh-runtime certification.
3. Run live health-check.
4. Run live hook tests if the failure smells runtime-specific.
5. Run source-tree coordinator tests if the failure smells launch, tasking, or messaging specific.

## When To Treat The System As Degraded

- Certification fails.
- Live health-check reports any failed check.
- Schema validation fails.
- Coordinator spawn smoke fails.
- Hook counters or self-heal begin showing repeated faults instead of isolated noise.

## Publication Gate

Do not publish a new revision unless all of these are green:

- `npm run cert:schemas`
- `npm run cert:a-plus:fresh`
- coordinator source-tree suite
- live hook suite
- live health-check
