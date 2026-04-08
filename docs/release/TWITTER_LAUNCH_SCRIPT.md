# X Launch Script

## Brutal Read

The earlier launch copy was weak.

Why it failed:

1. It read like a release note, not a post people would stop for in-feed.
2. It used a raw outbound GitHub link in the opening post, which creates immediate friction and gives cold viewers an easy reason to leave instead of engage natively.
3. It had no open loop, no question, no conflict, and no audience participation path.
4. It asked a brand-new account to win on credibility alone, without building a reply loop or joining an existing conversation.
5. It stated the repo existed, but it did not make the pain feel immediate or the proof feel surprising.
6. It still did not explain clearly enough what the thing actually is or how it helps protect a Claude plan.
7. The thread version took too long to get to the point.
8. The mechanism was buried too late, so readers had to reconstruct the system themselves.
9. Too many posts were doing one tiny job each instead of landing the whole idea fast.

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

The goal is not to announce a repo.

The goal is to make people instantly recognize the problem, understand what you built, believe the screenshot, and reply before they ever need to click anything.

This means the opener has to do six things:

1. Name a failure mode people already hate.
2. Make it sound like it came from someone who actually hit it.
3. Make it obvious this is something you built to protect your own Claude plan.
4. Tie the image to live proof.
5. Tell people what the system blocks without making them infer it.
6. Pull replies before you ever ask for an outbound click.

## Opening Post Rules

- No raw GitHub link in the opening post.
- Use the terminal proof image.
- Lead with the pain or failure mode, not the project name.
- Include one concrete surprising claim.
- Make it clear this is what you built to stop waste on your own Claude plan.
- End with a native CTA: question, prompt for repro, or challenge.
- Do not sound like product marketing.
- Do not sound like a changelog.

## Best Main Post

Post this first with `assets/social/launch-proof.png`:

```text
Claude was chewing through my plan on dumb waste before the real task even started.

Wrong resume. Same files reread. Too many workers. Cheap work on the wrong model.

So I built local guards around Claude Code that block those paths before more usage lands. This screenshot is two of them firing live.

What’s been burning the most usage on your plan?
```

Why this one wins:

- It makes the ownership clear: this is what you built for your own plan.
- It still starts with pain people already recognize.
- `wrong resume`, `same files reread`, `too many workers`, and `wrong model` sound like real failures, not feature categories.
- It explains the mechanism in the opener instead of waiting three more posts.
- The question is easy to answer and gets people talking about their own drain patterns.

## Leaner Main Post

Use this if you want it tighter:

```text
Claude will happily waste your plan before it does anything useful.

Bad resume. Same files reread. Too many workers. Budget gone.

I got tired of watching that happen on my own plan, so I built local guards to block it before the spend lands. This screenshot is two of them firing live.

What’s the worst way it’s burned your plan?
```

## More Personal Main Post

Use this if you want it to feel more like a build-in-public post:

```text
I finally got sick of Claude chewing through my plan on bad resumes, rereading the same files, and sending cheap work down expensive paths.

So I built local guards that stop that waste before more usage lands.

This screenshot is two of those guards firing live.

What’s the most annoying way it’s wasted your usage?
```

## First Reply

Reply to your own post within 1 to 3 minutes:

```text
What it actually does:

- blocks risky resume/continue sessions before heavy work
- blocks the 3rd read of the same file
- caps wasteful fanout and duplicate spawn patterns
- forces lookup/review work onto cheaper models
```

## Second Reply

Reply to your own first reply shortly after:

```text
What it tracks after that:

- allow / warn / block audit trail
- cost and burn-rate views
- alerts and ops snapshots
- compatibility intake for upstream Claude regressions
```

## Third Reply

Reply to your own second reply shortly after:

```text
Current receipts from the runtime right now:

10/10 fresh cert
481 passed hook tests
42/42 health checks
9/9 drain bench
1,307 schema validations
316/316 coordinator

I didn’t make up a fake savings percentage. I’d rather show what it blocks and how it certifies.
```

## Fourth Reply

Only after the thread has native engagement, or if someone explicitly asks for the repo:

```text
Repo is here:

github.com/DrewDawson2027/claude-token-management?ref=x-launch
```

If the post is getting replies fast, delay this reply and answer people first.
Use `?ref=x-launch` because X can hang onto an older GitHub card for the plain repo URL; the query string forces a fresh crawl while still resolving to the same repo.

## Fifth Reply

Use this if people start asking whether this “fixes Anthropic”:

```text
It does not control Anthropic upstream behavior.

It blocks the local waste, measures the rest, and makes the ugly failure modes visible instead of mysterious.
```

## Reply Targets Before Posting

Do this before the launch post goes up:

1. Find 5 to 10 current posts from real people complaining about Claude usage burn, resume weirdness, or runaway sessions.
2. Reply from your account with short, useful observations that do not mention the repo.
3. Make those replies sound like someone in the trenches, not like a lead magnet.
4. Then publish the main post.

The reason is simple:

- A new account without conversation history looks like drive-by self-promo.
- A new account already in the conversation looks more real and gets better profile curiosity.

## Bad Patterns To Avoid

- Do not write `Repo + certs:` in the opening post.
- Do not open with `I built...` unless the pain has already been established.
- Do not make the opening post mostly nouns like `guards`, `benchmarks`, `schemas`, or `observability`.
- Do not make people guess what the thing actually does.
- Do not spend three posts setting up the point before you finally make it.
- Do not use more than one idea in each paragraph.
- Do not make the opening post about “the architecture.”
- Do not post the link first and hope the image carries it.
- Do not sound impressed with your own repo.
- Do not write like a launch announcement from a startup account.
- Do not use words like `control plane`, `observability`, or `compatibility registry` in the opener.
- Do not say `duplicate reads` in the opener when `reread the same files` sounds more human.
- Do not say `risky resumes` in the opener when `resume the wrong session` sounds more human.

## Voice Rules

- Use contractions.
- Prefer `got sick of`, `waste usage`, `burned usage`, `reread the same files`, `resume the wrong session`, `firing live`, `dumb`, `annoying`.
- Prefer short sentences over polished ones.
- If a sentence sounds like a README, cut it.
- If a sentence sounds like launch collateral, cut it.
- If a sentence sounds engineered for cleverness, cut it.
- The opener should sound like someone venting about a real failure they finally got tired of and then explaining what they built to stop it.

## What The Previous Version Got Wrong

The deleted version failed on six fronts:

1. It led with a claim that was true but too broad: `Claude Code token drain is real, and preventable.`
2. It named categories of protection instead of dramatizing one failure mode.
3. It pushed the GitHub link too early.
4. It gave no compelling reason to reply.
5. It sounded like launch collateral, not a real operator who got burned and built a fix.
6. It assumed the image alone would carry the missing story.
7. It still made people infer the mechanism instead of just telling them what it blocks.
8. It stretched one strong idea across too many posts and killed momentum.

## Grade

Brutally honest grades for the copy itself:

- original deleted opener: `D`
- previous rewrite before this pass: `C+`
- current best opener: `A-`

Why it is still not `A+`:

- the copy now explains the thing instead of making people infer it
- it is still unproven in-market
- with a brand-new account, distribution is still the limiter even when the copy is materially stronger

## Source Notes

Official X sources used for this correction:

- X Business, `Organic best practices`: concise, conversational copy; media helps posts stand out; community management matters.
- X Business, `Build your presence on X`: complete the profile, use media, post about what your audience cares about, start relevant conversations, and monitor/reply to mentions.
- X Help, `How to post X replies and mentions`: replies are ranked for relevance and meaningful contribution.
- Buffer, `Best Content Format on Social Platforms in 2026`: on X, text had the highest median engagement, with images close behind and links last.
- Hootsuite, `How to measure and increase social media engagement in 2025`: questions invite comments, relatable stories beat product promos, and Wednesday morning is a strong posting window.

The launch strategy above combines those official points with first-principles distribution logic for a brand-new account.
