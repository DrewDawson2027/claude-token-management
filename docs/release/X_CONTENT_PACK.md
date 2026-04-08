# X Content Pack

This is the canonical X/Twitter launch writing pack for `claude-token-management`.

Ground rules for this pack:

- No made-up savings numbers.
- No repo link in the opening post.
- The writing has to sound like someone who got sick of Claude chewing through their plan and built around it.
- The mechanism has to be clear enough that people know what the thing actually does.

## Main Launch Thread

Use `assets/social/launch-proof.png` with this thread.

### Post 1

```text
Claude was chewing through my plan on dumb waste before the real task even started.

Wrong resume. Same files reread. Too many workers. Cheap work on the wrong model.

So I built local guards around Claude Code that block those paths before more usage lands. This screenshot is two of them firing live.

What’s been burning the most usage on your plan?
```

### Post 2

```text
What it actually blocks:

- risky resume/continue sessions before heavy work
- the 3rd read of the same file
- wasteful fanout and duplicate spawn patterns
- lookup/review work on the wrong model tier
```

### Post 3

```text
What it tracks after that:

- allow / warn / block audit trail
- cost and burn-rate views
- alerts and ops snapshots
- compatibility intake for upstream Claude regressions
```

### Post 4

```text
Current receipts from the runtime:

10/10 fresh cert
481 passed hook tests
42/42 health checks
9/9 drain bench
1,307 schema validations
316/316 coordinator

I didn’t measure a clean before/after percentage, so I’m not going to invent one.
```

### Post 5

```text
It doesn’t give me control over Anthropic upstream.

If cache behavior or throttling goes weird on their side, I can’t patch that from my laptop.

What I can do is stop the local waste I actually see burning my plan.

What’s the worst usage-burn pattern Claude keeps hitting you with?
```

### Repo Link Reply

Only post this after the thread has native engagement, or if someone explicitly asks for the repo.

```text
Repo is here:

github.com/DrewDawson2027/claude-token-management?ref=x-launch
```

Use the `?ref=x-launch` variant when posting on X so a stale card cache does not keep serving the older GitHub preview image.

## Standalone Posts

### Post 1: Worst Session Story

```text
The Claude session that finally broke me wasn't even doing anything hard.

Wrong resume. Same files reread. Plan getting chewed up before the real task even started.

That was the moment I stopped treating this like a discipline problem and started building guards around it.
```

### Post 2: Mechanical Failure Mode

```text
People talk about Claude "wasting tokens" like it’s one vague problem.

It usually isn’t.

It’s stuff like resuming the wrong session, rereading the same files, or spawning extra work that pays the same overhead twice.
```

### Post 3: What I Built

```text
I built a local guard layer around my Claude setup because I got sick of watching my plan get burned on dumb avoidable stuff.

It blocks bad resumes, repeated reads, wasteful fanout, and bad routing before they pile up.
```

### Post 4: Receipts

```text
Current receipts from the runtime:

10/10 fresh cert
481 passed hook tests
42/42 health checks
9/9 drain bench
1,307 schema validations
316/316 coordinator
```

### Post 5: Before / After Framing

```text
Before this, I’d watch a session go sideways and only realize after more of my plan was already gone.

Now the obvious bad paths get blocked earlier.

I didn’t measure a clean savings percentage, so I’m not going to fake one. I just got tired of paying for the same dumb mistakes.
```

### Post 6: Contrarian Take

```text
Budget warnings are useful, but they’re not the same as stopping waste.

If Claude already resumed the wrong thing and reread the same files three times, the warning is late.

The only place this gets better is before the next chunk of usage goes out the door.
```

### Post 7: Build In Public

```text
Every time Claude finds a new dumb way to chew through my plan, I turn it into a test or a guard.

That’s basically the whole loop now.
```

### Post 8: Honest Limits

```text
This doesn’t let me reach into Anthropic and fix their side.

It handles the local waste I can actually see: bad resumes, repeated reads, fanout nonsense, bad routing, ugly session drift.

That’s still been worth building.
```

## Engagement / Question Posts

### Question 1

```text
What’s the dumbest way Claude has burned usage on your plan?
```

### Question 2

```text
Which one burns more for you right now: bad resumes or rereading the same files?
```

### Question 3

```text
At what point do you know a Claude session has gone bad and is just chewing through usage?
```

### Question 4

```text
What Claude behavior would save you the most plan if you could kill it tomorrow?
```

### Question 5

```text
Have you had a session where you knew the next few minutes were going to be pure waste but let it run anyway?

What was it doing?
```

## Educational Mini-Threads

### Mini-Thread 1: Why Bad Resumes Burn Usage

#### Post 1

```text
Bad resumes burn usage for a boring reason.

You’re usually not continuing the exact work you think you are. You’re paying to reload baggage from the wrong session or too much stale session history.
```

#### Post 2

```text
Then Claude has to re-orient, reread, restate, and crawl back toward the task you actually wanted.

That overhead hits your plan before the real work starts.
```

### Mini-Thread 2: Why Repeated Reads Add Up

#### Post 1

```text
Rereading the same files burns usage even when the output still looks "fine."

Every repeat read drags the same context back through the workflow again.
```

#### Post 2

```text
It feels harmless in the moment because you’re "just checking a file again."

Your plan feels something else.
```

### Mini-Thread 3: Why Budgets Alone Don’t Solve It

#### Post 1

```text
Budgets don’t save you if the workflow is dumb.

If one task keeps going down a bad resume path or fans out extra work for no reason, the burn is already underway.
```

#### Post 2

```text
A warning after the fanout is a receipt.

The only useful place to intervene is before the extra work starts.
```

## Reply Templates

### 1. "This is just prompt engineering."

```text
Prompting better helps.

It doesn’t stop a bad resume or the same files getting reread three times. I built this for the mechanical waste around the prompt.
```

### 2. "Just set a budget."

```text
A budget helps you stop the bleeding.

It doesn’t stop dumb spend before it happens. I wanted the waste blocked earlier than that.
```

### 3. "Does Anthropic know about this?"

```text
I’m sure they know people feel it.

I couldn’t wait on that, so I built around the parts I can control locally.
```

### 4. "How much does it save?"

```text
I didn’t measure a clean before/after percentage, so I’m not going to fake one.

What I can show is what it blocks and the runtime receipts around it.
```

### 5. "Isn’t this just logging?"

```text
If it were just logging I wouldn’t have bothered.

It actually blocks bad resumes, repeated reads, and other dumb waste before more plan gets burned.
```

### 6. "Why not just use the API directly?"

```text
Different problem.

Most people feeling this pain are in Claude itself, not rebuilding their whole workflow around the API.
```

### 7. "Open source, but what’s the catch?"

```text
No catch.

I put it out because other Claude users are getting hit by the same stuff and I wanted the work inspectable.
```

### 8. "This seems like overkill."

```text
If your plan never gets chewed up, then yeah, don’t use it.

Mine did, so I built around it.
```

### 9. "Isn’t this just user error?"

```text
Some of it is user behavior.

A lot of it is mechanical overhead once a session goes sideways. I’m trying to cut that part down.
```

### 10. "Why not just start fresh sessions more often?"

```text
Sometimes that is the right answer.

The problem is you often only realize that after usage is already gone.
```

### 11. "Does it slow Claude down?"

```text
A little guard friction is cheaper than burning plan on a bad path.

I’d rather get blocked for a second than lose usage on nonsense.
```

### 12. "Is this only for your setup?"

```text
It started there, yeah.

That’s why I know the failure modes are real. The repo is public so other people can see if the same pain shows up for them.
```

### 13. "Can it fix Anthropic cache issues?"

```text
It can’t fix Anthropic upstream from the outside.

It can catch the local patterns that usually make the burn worse.
```

### 14. "Why not just be more disciplined?"

```text
Because discipline fails when you’re tired and the workflow still matters.

I wanted the setup itself to push back when a session goes stupid.
```

### 15. "What is this actually?"

```text
It’s a local guard layer around my Claude setup.

It blocks bad resumes, repeated reads, wasteful fanout, and bad routing before they chew through more of my plan.
```

### 16. "Why should I trust this?"

```text
Because it ships receipts instead of vague claims.

10/10 fresh cert. 481 passed hooks. 42/42 health. 9/9 drain bench.
```

## Quote-Reply Templates

### Quote Reply 1

```text
This is exactly the kind of thing that made me build guards around my Claude setup.

Wrong resume + same files reread was chewing through my plan before the useful work even started.
```

### Quote Reply 2

```text
Same pattern here.

The part that drove me nuts was the waste happening before the real task, so I started blocking the dumb paths locally.
```

### Quote Reply 3

```text
I kept seeing this too: wrong session, same files reread, more plan gone for no gain.

Ended up building around it because I got tired of eating it.
```

### Quote Reply 4

```text
This is the important split to me: some burn is upstream, some is local workflow waste.

I can’t patch Anthropic from here, but I can stop the local nonsense.
```

## Posting Strategy

### Three Days Before Launch

Post one engagement question in the morning.

Use one of the question posts above. No repo link. No screenshot yet.

Then spend 20 to 30 minutes replying to real people already complaining about Claude usage burn. Keep those replies useful and short.

### Two Days Before Launch

Post one standalone vent post.

Use `Worst Session Story` or `Mechanical Failure Mode`. The goal is to sound like a real person dealing with a real pain, not like someone warming up a launch.

### One Day Before Launch

Post one educational mini-thread.

Best choice is `Why Bad Resumes Burn Usage` because it teaches people something concrete and sets up the main thread without sounding promotional.

### Launch Day

Post the main launch thread in the morning Pacific when you can stay online for at least 90 minutes after.

Order:

1. Post the main thread with `launch-proof.png`.
2. Stay in the app.
3. Reply fast to real questions.
4. Do not drop the repo link in the opener.
5. Do not drop the repo link until someone asks or the thread already has native replies.

Use this reply order:

1. First mechanism reply.
2. Then the receipts reply.
3. Repo link only after engagement.

### First 24 Hours After Launch

Post one standalone proof post or the contrarian budget post.

Quote-reply 3 to 5 good complaint posts with the quote-reply templates. Keep it conversational. Do not paste the same reply everywhere.

### Days 2 Through 7 After Launch

Post one thing per day from this mix:

1. one standalone post
2. one question post
3. one mini-thread

Keep using replies to pull real failure cases out of people. If someone gives a specific drain pattern, that’s the gold.

### Cadence Rules

- One main post a day is enough from a brand-new account.
- Replies matter more than extra standalone posts.
- If one post gets traction, stay with it instead of rushing to the next one.
- If people are clearly reacting to one failure mode, lean into that one instead of trying to cover everything at once.

## Honest Grade

My honest grade for this pack as writing, before market feedback, is `A-`.

Why it is not `A+` yet:

- The writing is strong, but real A+ X content gets sharpened by live replies and real audience friction.
- Some of these posts will hit harder than others in practice.
- The structure is much tighter now, but the final edge still comes from live market feedback and cutting anything that still feels over-explained.
