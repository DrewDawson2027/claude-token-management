# X Launch Script

## Brutal Read

The earlier launch copy was weak.

Why it failed:

1. It read like a release note, not a post people would stop for in-feed.
2. It used a raw outbound GitHub link in the opening post, which creates immediate friction and gives cold viewers an easy reason to leave instead of engage natively.
3. It had no open loop, no question, no conflict, and no audience participation path.
4. It asked a brand-new account to win on credibility alone, without building a reply loop or joining an existing conversation.
5. It stated the repo existed, but it did not make the pain feel immediate or the proof feel surprising.

## Source Basis

This script is now aligned to the actual sources that matter here:

- X Business says organic copy should be concise, conversational, and paired with media, and that reply/community management matters.
- X Business also says posts should connect to topics people actually care about and should start relevant conversations.
- X Help states replies are ranked for relevance and meaningful contribution, which means conversation quality matters.

What those sources do **not** prove:

- They do not give a formal public statement that raw links are algorithmically penalized.

So the correct position is:

- There is no official X source here proving a hard link penalty.
- For a brand-new account, putting a GitHub link in the opening post is still a bad launch choice because it increases friction and reduces the chance that the first action is a native reply, quote, save, or repost.

## Launch Goal

The goal is not “announce the repo.”

The goal is to make the first post do four things:

1. Trigger recognition in people already angry about Claude token burn.
2. Show proof that the screenshot is real and current.
3. Pull native replies before any outbound click.
4. Earn permission to drop the repo link in a reply, not force the click immediately.

## Opening Post Rules

- No raw GitHub link in the opening post.
- Use the terminal proof image.
- Lead with the pain or failure mode, not the project name.
- Include one concrete surprising claim.
- End with a native CTA: question, prompt for repro, or challenge.
- Do not sound like product marketing.
- Do not sound like a changelog.

## Recommended Main Post

Post this first with `assets/social/launch-proof.png`:

```text
Claude can burn a stupid amount of usage before useful work even starts.

I got tired of watching resumed sessions and duplicate reads waste tokens, so I built local guards that block both before spend lands.

This screenshot is an actual guard firing from the repo running today.

If Claude is draining your usage, reply with the exact flow that's doing it.
```

Why this version is stronger:

- It starts with pain, not branding.
- It makes the builder sound involved, not corporate.
- It uses the screenshot as proof, not as decoration.
- It ends with a native reply CTA instead of an outbound click CTA.

## Alternate Main Post

Use this if you want a sharper, more confrontational tone:

```text
One of the dumbest Claude failure modes is burning tokens on work that should have been blocked before the session even moved.

I built local guards for that.

This screenshot is a risky resume flow and a duplicate read getting blocked before spend lands.

What exact Claude flow is wasting the most usage for you right now?
```

## First Reply

Reply to your own post within 1 to 3 minutes:

```text
Current proof from the live/runtime surface:

- fresh runtime cert: 10/10
- live hooks: 481 passed
- health-check: 42/42
- drain bench: 9/9
- schemas: 1,307 docs / 0 errors
- coordinator: 316/316
```

## Second Reply

Only after the first post has native engagement, or if someone explicitly asks for the repo:

```text
Repo is here:

github.com/DrewDawson2027/claude-token-management
```

If the post is getting replies fast, delay this reply a bit and answer people first.

## Third Reply

Use this if people start asking whether this “fixes Anthropic”:

```text
It does not control Anthropic upstream behavior.

It blocks the local waste, measures the rest, and makes the ugly failure modes visible instead of mysterious.
```

## Reply Targets Before Posting

Do this before the launch post goes up:

1. Find 5 to 10 current posts from real people complaining about Claude token burn, resume weirdness, or runaway usage.
2. Reply from your account with short, useful, non-spammy observations.
3. Do not mention your repo in those replies unless someone asks.
4. Then publish the main post.

The reason is simple:

- A new account without conversation history looks like a drive-by promo account.
- A new account that is already in the conversation has a better chance of getting profile visits and reply velocity.

## Bad Patterns To Avoid

- Do not write `Repo + certs:` in the opening post.
- Do not open with `I built...` unless the pain has already been established.
- Do not make the opening post mostly nouns like `guards, benchmarks, schemas, observability`.
- Do not use more than one idea in each paragraph.
- Do not make the opening post about “the architecture.”
- Do not post the link first and hope the image carries it.

## What The Previous Version Got Wrong

The deleted version failed on six fronts:

1. It led with a claim that was true but too broad: `Claude Code token drain is real, and preventable.`
2. It named categories of protection instead of dramatizing one failure mode.
3. It pushed the GitHub link too early.
4. It gave no compelling reason to reply.
5. It sounded like launch collateral, not a real operator who got burned and built a fix.
6. It assumed the image alone would supply the missing story.

## Source Notes

Official X sources used for this correction:

- X Business, `Organic best practices`: concise, conversational copy; media helps posts stand out; community management matters.
- X Business, `Build your presence on X`: complete the profile, use media, post about what your audience cares about, start relevant conversations, and monitor/reply to mentions.
- X Help, `How to post X replies and mentions`: replies are ranked for relevance and meaningful contribution.

The launch strategy above combines those official points with first-principles distribution logic for a brand-new account.
