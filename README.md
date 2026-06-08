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
   re-walks only what your change touched, proving the deterministic assertion flips
   **fail → pass**. On your approval the fixed mission becomes a **permanent regression
   test** — a frozen mission replayed through the *same* checker on every later build,
   so it can never silently regress — and a **run-to-run diff** shows what newly
   passes, newly fails, or changed. A **four-metric dashboard** tracks the loop's
   health, and all of it is **durable**: runs, verdicts, comments, and the regression
   registry survive a worker restart.

## Scope (on purpose)

SelfQA works **only on apps the agent itself builds** — that's the feature. Because one
agent owns both sides, it knows the routes, emits the test IDs, and seeds the data, so
verification is tractable. It is **not** designed to test arbitrary third-party web
apps.

> ⚠ **SelfQA v1 is a local, single-user tool that executes semi-trusted,
> self-prompted code. It is _not_ a sandbox — do not deploy it as a public,
> multi-tenant, or hosted service.** See [SPEC.md §14.4](./SPEC.md).

## Status — complete

**All eight milestones are implemented, verified, and pushed.** The whole loop runs
end-to-end with **no API key** (a deterministic **stub** provider; set
`ANTHROPIC_API_KEY` for real codegen — the provider is one swappable interface, SPEC
§15). The win condition, proven in one uninterrupted test (`verify-loop-e2e`):

> build → walk → a **reached-but-failing** mission → step-anchored comment → the
> **5-leg grounded tuple** → codegen **consumes the typed assertion** → re-walk
> **replays + re-asserts** → the deterministic assertion **flips fail → pass** →
> promote → it **appears in the run diff** → it's **remembered as a frozen regression
> test** and re-checked on every later build → **durable across a worker restart**,
> with **zero LLM on the hot path**.

What's built, each gated by a `scripts/verify-*.ts` script:

| Capability | Where |
|---|---|
| One 3-valued verification spine (`checkAssertion`), three entry points (first-walk, re-walk, **regression replay**) | `verify/`, `regression/replay.ts` |
| Grounded executable feedback — the tuple, codegen that **consumes** it, re-walk that **re-asserts** it | `codegen/`, `rewalk/` |
| Mechanical re-walk scope (two-bucket touched-routes manifest) + convergence loop with a hard cap | `verify/manifest.ts`, `rewalk/loop.ts` |
| **Regression memory** — promote → frozen Mission-shaped test, propose-then-approve retirement, run-to-run diff | `regression/`, the worker |
| **Durable metadata** (`node:sqlite`) — runs/verdicts/comments/regressions survive a restart | `persist/` |
| **Four-metric dashboard** (det:semantic ≥80%, recompile rate, everything-bucket fraction, attempts histogram) | `metrics/`, the Metrics tab |
| **Per-lane DB isolation** — stable-slot pool, restore-to-seed runner, the §9.3 gate (primitive + end-to-end) | `walk/`, `runner/app-runner.ts` |

- **[SPEC.md](./SPEC.md)** — what SelfQA is and why it's shaped the way it is.
- **[PLAN.md](./PLAN.md)** — the 8-milestone build path (with the as-built status).

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
# verdict list; click a mission, click a step, and comment to drive an edit. The
# flip, the run diff, the Promote button, the Metrics tab, and the regression list
# are all in the review UI.
```

### Verifying

One command runs typecheck + lint + every `verify-*` script:

```bash
npm run verify:fast    # ~20 no-browser checks (deterministic, no API key, seconds)
npm run verify:all     # the above + real-Chromium / build-driven gates (minutes)
```

Some headline gates you can run on their own:

```bash
npx tsx scripts/verify-loop-e2e.ts        # the full win condition, end-to-end (Chromium)
npx tsx scripts/verify-regression.ts      # frozen replay catches a re-break; no auto-drop
npx tsx scripts/verify-persist.ts         # sqlite & in-memory stores round-trip identically
npx tsx scripts/verify-db-e2e.ts          # N parallel lanes, per-lane DB, no "database is locked"
npx tsx scripts/verify-hot-path.ts        # the re-walk hot path imports zero LLM code
```

## Stack

Next.js 16 · TypeScript · Tailwind · React 19 · Playwright (Chromium) · `node:sqlite`
for SelfQA's own durable metadata · per-lane SQLite for generated-app data isolation ·
the Anthropic API (behind a swappable provider interface; a deterministic stub is the
default).
