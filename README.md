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

**M1 (prove the loop) and M3–M4 (the mission engine) are implemented and verified.**
End-to-end, no API key required: prompt → build → derive 8–15 missions → walk each
(Playwright, real Chromium) → a sorted **verdict list** (failed > ambiguous > passed)
with per-step screenshot/DOM/video → click a step to leave a grounded comment → edit
→ rebuild → re-verify. It runs on a deterministic **stub** provider by default (no
token spend); set `ANTHROPIC_API_KEY` for real codegen — the provider is swappable
behind one interface (SPEC §15).

- **[SPEC.md](./SPEC.md)** — what SelfQA is and why it's shaped the way it is.
- **[PLAN.md](./PLAN.md)** — the 8-week, 8-milestone build path.

### Running locally

Generated apps (and SelfQA's own UI) run in **production mode** (`next build` +
`next start`) — Next 16 dev does not reliably hydrate in this setup, so production is
also what keeps the walk deterministic (no HMR races).

```bash
npm install
npx playwright install chromium          # one-time, ~150MB (for the mission walk)
# optional — real codegen instead of the deterministic stub:
cp .env.example .env && echo "ANTHROPIC_API_KEY=sk-..." >> .env

# two processes (SPEC §14.1):
npm run worker                            # long-running worker: codegen + walks
npm run build && npm run start            # the SelfQA review UI (production)

# open http://localhost:3000 — type a prompt, Build, then Run missions to get the
# verdict list; click a mission, click a step, and comment to drive an edit.
```

Verify each layer without a browser-driver of your own (deterministic, no API key):

```bash
npx tsx scripts/verify-schema.ts          # the shared assertion/mission schema
npx tsx scripts/verify-checker.ts         # the one verification checker
npx tsx scripts/verify-mission-deriver.ts # 8–15 typed missions, cold + informed
npx tsx scripts/verify-fixtures.ts        # the fixtures contract
npx tsx scripts/verify-first-walk.ts      # conservative first-walk verdicts
npx tsx scripts/verify-loop.ts            # build → comment → edit → rebuilt → verified
npx tsx scripts/verify-isolation-gate.ts  # parallel pool + per-mission isolation (Chromium)
npx tsx scripts/verify-harness.ts         # selector ladder + settling + retry (Chromium)
npx tsx scripts/verify-walk.ts            # mission walk + capture (Chromium)
npx tsx scripts/verify-endpoints.ts       # worker build → walk → artifact → comment
npx tsx scripts/verify-ui.ts              # the review UI, real browser end-to-end
```

## Stack

Next.js · TypeScript · Tailwind · shadcn/ui · Prisma + SQLite (file-per-worker) ·
Playwright · the Anthropic API (behind a swappable provider interface).
