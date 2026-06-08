# SelfQA — Build Plan

> The milestone path to the hero artifact. Read [SPEC.md](./SPEC.md) first — this
> document assumes its vocabulary (the tuple, P1/P2, the verification spine, the
> manifest, the metrics) and only sequences the *build*.

An **8-week, 8-milestone** plan. Each milestone has a **single win condition** — if
the win condition isn't met, the milestone isn't done, regardless of how much code
exists. Milestones are ordered so that **the hard problem (grounded executable
feedback) is attempted only after the loop and the mission engine already work.**

---

## Build status — as shipped ✅

**All milestones M1–M6 (incl. every M5 checkpoint A–L and M6 A–D) are implemented,
verified, and pushed.** Each checkpoint is gated by a `scripts/verify-*.ts` script;
`npm run verify:all` runs typecheck + lint + all of them green.

| Milestone | Status | Headline verify gate(s) |
|---|---|---|
| M1–M2 · prove the loop | ✅ | `verify-loop`, `verify-instrument` |
| M3–M4 · mission engine | ✅ | `verify-walk`, `verify-first-walk`, `verify-endpoints`, `verify-ui` |
| M5-A…E · tuple + manifest | ✅ | `verify-tuple-assemble`, `verify-edit-consume`, `verify-manifest` |
| M5-G…J · flip + re-walk + converge | ✅ | `verify-flip`, `verify-rewalk` (headline), `verify-converge`, `verify-gate` |
| M5-K · durable persistence | ✅ | `verify-persist` (node:sqlite ⇄ in-memory, restart-safe) |
| M5-L · regression memory + diff | ✅ | `verify-regression`, `verify-diff` |
| M5-F / F-INT · per-lane DB isolation | ✅ | `verify-db-isolation` (primitive), `verify-db-e2e` (end-to-end gate) |
| M6-A…D · worker + UI + metrics + e2e | ✅ | `verify-metrics`, `verify-loop-e2e` (the win condition) |

**As-built note (honesty):** the *generated-app* data layer the §9.3 gate isolates is
SQLite-per-lane; the DB-backed stub app and SelfQA's own durable metadata both use
`node:sqlite` (zero engine/network/deps) rather than Prisma — the load-bearing
property (a server-side write routed by a **runtime** `DATABASE_URL` to a per-lane
file, with the build-time-inlining trap) is identical, and swapping in Prisma is a
build-agent prompt change. M7 (coverage side panel) and M8 (dogfood video/essay)
remain as the explicitly-optional / out-of-code deliverables below.

---

## Sequencing principles (apply across milestones)

- **Build the verification spine once (SPEC §6).** One typed-assertion checker, three
  entry points. Never let initial-walk, re-walk, and regression-replay grow separate
  implementations.
- **The M5 latency priority order (SPEC §9.5)** — spend effort in this order, because
  you get most of the 2-minute win from the cheapest piece:
  ```
  isolation + parallelism   (cheap, huge)
    > two-bucket manifest    (cheap, coarse)
      > precise import graph  (expensive, refining)
  ```
- **Track the four metrics (SPEC §16)** from the moment each is measurable. They are
  the early-warning system for the thesis.
- **Honor P1/P2 and the three-relationships checklist at every step.** Any feature
  that needs the agent to self-grade, self-report what to check, infer what to fix, or
  decide-good-unsupervised is wrong by construction.

---

## M1–M2 · Prove the loop (no hard problem yet)

**Goal:** establish the develop → comment → fix loop end-to-end with grounded
*context*, before any crawler, mission engine, graph, or critic exists.

**What's in:**
- Initial build from a NL prompt → a running Next.js + TS + Tailwind + shadcn/ui app
  (SPEC §15), as an incremental-editable git repo (SPEC §11.1).
- The human **manually explores** the app in a live **iframe** — the human does
  **all** exploration; **no crawler.**
- Comment → **spec-extractor** (SPEC §10.4: one clarifying question, then best
  guess) → **edit** (a diff, not a regeneration — SPEC §8.2) → reload.
- Grounded **context** captured at comment time: **URL + DOM path + screenshot
  region.** (Comments here are grounded-in-location, **not replayable** — SPEC
  §10.5.)

**What's explicitly NOT in:** crawler, missions, state graph, visual critic,
replayable action sequences.

**Win condition:**
> A human comment becomes a **working code change with grounded context (URL + DOM
> path + screenshot region) in under 60 seconds.**

**Foundations to lay here (cheap now, expensive later):**
- App is a git repo; codegen is an **incremental editor** from day one (SPEC §8.2) —
  do **not** start with a regenerator you'll have to rip out.
- The provider interface around the Anthropic codegen call (SPEC §15) — swappable.
- Two-process shape (Next UI + long-running worker) even if the worker is thin
  (SPEC §14.1).

---

## M3–M4 · The mission engine

**Goal:** replace human exploration with autonomous mission walking, and build the
reviewable verdict list.

**What's in:**
- **Mission derivation:** an LLM derives **8–15 named missions** from prompt + code,
  each `{id, name, NL description, ordered intended steps, typed acceptance criteria}`
  (SPEC §7.1).
- **Playwright walking** with the **selector ladder** (SPEC §13.2) and the **settling
  predicate** (SPEC §13.3, retry once).
- **Per-mission output:** verdict + video + per-step screenshot/DOM trace + action
  trace.
- **The fixtures contract (SPEC §12)** — seed users + login hook, mock payment keys,
  stubbed email/OTP, deterministic seed data with stable identities, the
  snapshot/restore hook.
- **Per-mission isolation via restore-to-seed (SPEC §9.1–§9.2)** — establish here;
  every later guarantee depends on it.
- **The verdict UI:** list sorted **failed > ambiguous > passed**; click any step to
  comment.
- **First-walk conservatism (SPEC §7.2):** auto-assert **only** the fixed
  deterministic whitelist; everything else → `ambiguous: semantic-needs-human`.
  `ambiguous` carries its **reason enum** (SPEC §7.3).
- **Comment anchoring (SPEC §10):** the UI's only comment-to-code path is selecting a
  trace coordinate; **routing by affordance** (step / mission-header / meta control).

**Win condition:**
> From prompt + code, the agent produces an **8–15-mission sorted verdict list** with
> per-mission video + step trace, where **green means machine-verified** and
> **ambiguous means the agent honestly refuses to guess** — and a human can click any
> step to leave an anchored comment.

**Metric online here:** deterministic : semantic ratio (SPEC §6.4) starts being
measurable as soon as criteria are typed.

**⚠ Gate before trusting parallel verdicts (SPEC §9.3):** write a **deliberate
concurrent-write isolation test** proving strict file-per-worker / no shared
connections, so a `database is locked` error can never be misdiagnosed as settling
flake.

---

## M5–M6 · Grounded executable feedback (THE NOVELTY)

**Goal:** close the loop verifiably. This is the milestone the whole project exists
for; the first four exist to make this one possible.

**What's in:**
- **Comment → tuple (SPEC §3):** `(mission id, action sequence, snapshot, NL
  comment, assertion)`. The spec-extractor populates the **typed assertion**
  (`deterministic | semantic`, SPEC §6.1).
- **Codegen consumes the whole tuple.**
- **Touched-routes manifest (SPEC §8.3):** mechanically derived from the actual diff
  (never self-reported), import-graph closure ∪ smoke set.
  - Ship the **two-bucket fallback first** (SPEC §8.4): provably-local → scoped;
    anything else → everything.
- **Re-walk (SPEC §8.1):** untouched path → exact replay (zero LLM); touched path →
  **recompile the sequence from NL intent** (off-hot-path LLM); can't reach state →
  `ambiguous: replay-failed`.
- **Assertion check on re-walk** — replay, then assert the snapshot changed in the
  requested direction; deterministic = mechanical, semantic = one batched LLM verdict
  (SPEC §6.3). **No LLM in the hot path.**
- **Regression memory (SPEC §7.5):** human approval promotes a mission to a permanent
  named regression test. **Retirement is propose-then-human-approve; no auto-drop.**
- **Run-to-run diff (SPEC §7.5, §11.1):** match by stable `id`; verdicts at `SHA_n`
  vs `SHA_{n-1}`; newly-pass / newly-fail / changed-outcome.
- **The loop's operational model (SPEC §11):** `build = commit SHA`; **batch per
  review pass** (one edit + one re-walk, per-comment-assertion attribution);
  **convergence cap** (default 3 → `unresolved: needs-human`); **fix-induced
  regression gate** (deterministic hard-blocks, semantic surfaces); **escalation as a
  grounded tradeoff choice.**

**Apply the M5 latency priority order here** — isolation+parallelism first (most of
the win, nearly free once §9 holds), two-bucket manifest second, precise import graph
**last** (and only as an earned optimization).

**Win condition:**
> A comment on a **failed** mission step compiles to the tuple, drives an edit, and
> the agent **re-walks and proves resolution** (the assertion flips) **in under 2
> minutes**, with the passed mission persisted as a regression test and showing up in
> the run-to-run diff. No LLM call in the hot path.

**Metrics online here:** recompile rate; everything-bucket fraction;
attempts-to-resolution distribution (SPEC §16). The four-metric dashboard is now
complete.

---

## M7 · Coverage side panel (OPTIONAL — not load-bearing)

**Goal:** supplementary coverage *on top of* missions. **The product must ship and
demo fully even if this panel is mediocre or cut.**

**What's in (light crawling only):**
- From each visited page, pick **3 unvisited interactive elements**, click, capture.
- **Cheap dedup only:** route + structural-skeleton hash (drop text/values); a
  vision-LLM embedding **only on ties.**
- Surface as: *"the agent saw N states beyond your missions and flagged M as
  suspicious."*

**Win condition (soft):**
> The side panel surfaces a handful of unvisited states with cheap dedup, clearly
> framed as **supplementary** to the mission list — and the headline product is
> unaffected if this is cut.

**This is a Week-7 side panel, not the headline.** State-coverage is supplementary;
the reviewable artifact is the **run-to-run mission diff** (M5–M6), not a graph diff.

---

## M8 · Dogfood, demo, ship

**Goal:** use SelfQA to build a real app, run the loop on real issues, and produce the
hero artifact.

**What's in:**
- **Dogfood app:** a real app with 4–5 routes and real forms.
  - **Recommended: job-application tracker** — clean CRUD + status transitions make a
    rich mission surface (apply → interview → offer/reject; empty states; validation;
    a 2-step max flow).
  - **Fallback: recipe organizer.** Decide at M8 start; both fit the cut list (SPEC
    §17 — no auth/payments beyond mocks, no >2-step wizards).
- Run the loop: **comment on 3–4 things**, capture before/after.
- **Hero artifact — a 90-second video:** prompt → app → mission list → comment on a
  **failed** mission step → re-walked verdict **flips green**, regression test added
  (SPEC §18).
- **Open-source** with a short **essay** explaining the thesis (SPEC §2) and the
  novelty (SPEC §3) — and what is deliberately *not* claimed (the crawler, comment-to-
  code, "AI does QA").

**Win condition:**
> SelfQA builds the dogfood app from a prompt; a human comments on 3–4 real issues;
> each becomes a verified code change with a re-walked green verdict and a persisted
> regression test; the 90-second hero video exists; the repo is public with the
> essay.

---

## Milestone → SPEC cross-reference

| Milestone | Primary SPEC sections |
|-----------|----------------------|
| M1–M2 | §8.2 (incremental editor), §10.4 (spec-extractor), §10.5 (capability boundary), §11.1 (git substrate), §14.1 (two-process shape) |
| M3–M4 | §7 (missions), §9.1–§9.3 (isolation + data layer + the SQLite gate), §10 (anchoring), §12 (fixtures), §13 (automation) |
| M5–M6 | §3 (tuple), §6 (verification spine), §8 (re-walk + manifest), §9.5 (parallelism priority), §11 (loop operation), §16 (metrics) |
| M7 | §17 (cuts — coverage is supplementary, cuttable) |
| M8 | §18 (done), §2/§3 (thesis & novelty for the essay) |

---

## Definition of done (the whole project)

1. The hero 90-second video exists and shows a failed verdict flipping green via a
   grounded, replayed, asserted comment — with a regression test added.
2. The four-metric dashboard (SPEC §16) is populated from a real dogfood run.
3. The repo is public with SPEC.md, PLAN.md, a README, and the thesis essay.
4. Every shipped agent action maps to one of the three sanctioned
   agent↔judgment relationships (SPEC §4). None is "agent decides, unsupervised."
