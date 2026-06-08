# SelfQA

> **An agent that builds web apps and verifies its own work.**

SelfQA builds a web app from a natural-language prompt, then **runs itself through the
app** — attempting a set of named user missions end-to-end — and presents the results
as a reviewable list. You comment on what's wrong. Each comment compiles into a
**replayable, assertable test**; the agent edits the code to fix it and **re-walks to
prove the issue is resolved.** Develop → verify → review → fix becomes one tight loop,
with **you as the judge.**

## The thesis

Correctness depends on intent, and intent lives in your head — so **you stay the
judge.** The agent's job isn't to decide what's good; it's to make your judgment
*cheap* by surfacing every relevant state and turning your feedback into verified code
changes.

## The load-bearing idea: grounded *executable* feedback

Every comment you leave compiles into a tuple:

```
(mission id, action sequence, snapshot[DOM + screenshot], your comment, assertion)
```

The codegen agent receives all of it. On re-walk, it **replays the exact steps and
asserts the state changed the way you asked** — which is what makes the loop
*verifiable* instead of vibes-based. That assertion, not the crawler and not
comment-to-code, is the contribution.

## How it stays honest

Two principles run through the whole design:

- **The agent never decides whether its own work gets checked.**
- **The agent never infers what it's supposed to fix.**

Wherever the agent might substitute a guess for a knowable fact — what to check, what
to fix, whether it's "done" — the architecture forbids the guess and forces the fact
to exist. Green means *machine-verified*. "Ambiguous" means the agent *honestly
refuses to guess*.

## How it works (one loop)

1. **Build** — a Next.js + TypeScript + Tailwind + shadcn/ui app from your prompt,
   plus a fixtures file (seed users, mocked payments/email, deterministic data) so the
   agent can walk past its own auth and payment walls.
2. **Verify** — the agent derives 8–15 named missions and walks each end-to-end with
   Playwright, producing a verdict + video + step-by-step trace per mission.
3. **Review** — you get a list sorted *failed > ambiguous > passed*. A 3-minute
   review, not a 30-minute crawl. Click any step to comment.
4. **Fix** — your comment becomes the tuple above; the agent edits the code and
   re-walks only what your change touched, proving the assertion flips. The fixed
   mission becomes a permanent regression test, and a run-to-run diff shows what newly
   passes, newly fails, or changed.

## Scope (on purpose)

SelfQA works **only on apps the agent itself builds** — that's the feature. Because one
agent owns both sides, it knows the routes, emits the test IDs, and seeds the data, so
verification is tractable. It is **not** designed to test arbitrary third-party web
apps.

> ⚠ **SelfQA v1 is a local, single-user tool that executes semi-trusted,
> self-prompted code. It is _not_ a sandbox — do not deploy it as a public,
> multi-tenant, or hosted service.** See [SPEC.md §14.4](./SPEC.md).

## Status

Early. This repository currently contains the design:

- **[SPEC.md](./SPEC.md)** — what SelfQA is and why it's shaped the way it is.
- **[PLAN.md](./PLAN.md)** — the 8-week, 8-milestone build path.

## Stack

Next.js · TypeScript · Tailwind · shadcn/ui · Prisma + SQLite (file-per-worker) ·
Playwright · the Anthropic API (behind a swappable provider interface).
