# Grounded executable feedback: an agent that verifies its own work

> The thesis and novelty behind SelfQA, and — just as important — what it
> deliberately does **not** claim. For the full design see [SPEC.md](./SPEC.md);
> for the build path and as-built status see [PLAN.md](./PLAN.md).

## The thesis: you stay the judge

Correctness depends on intent, and intent lives in your head. No amount of model
scale moves it from there. So the honest position for a coding agent is not "I will
decide whether this app is good" — it's **"you decide; my job is to make deciding
cheap."**

Cheap has two halves. **Surface every relevant state** so you don't have to go
hunting for what the agent did. And **turn each piece of your feedback into a verified
code change** so you don't have to re-check by hand whether it actually landed.
SelfQA is an attempt to do both for the one tractable case — an app the agent built
itself — without ever letting the agent quietly grade its own homework.

Two rules run through the whole design, and they're the reason the loop is
trustworthy rather than merely convenient:

- **P1 — the agent never decides whether its own work gets checked.** Re-walk scope
  is derived mechanically from the git diff, never self-reported; verdicts become
  ground truth only on your approval. An agent that can silently delete its own
  failing test can launder its mistakes — which is exactly what an external judge
  exists to prevent.
- **P2 — the agent never infers what it's supposed to fix.** No comment compiles to a
  code-bound change without a concrete trace anchor. A grounded-*looking* fix aimed at
  the wrong target is worse than an honest "I don't know," because now the
  groundedness is lying.

The verdict list sorts by **verifiability, not taste**: failed, then ambiguous, then
passed. "Green" means *machine-verified*. "Ambiguous" means the agent is explicitly
*not pretending to know* — and it tells you the reason code (replay-failed,
semantic-low-confidence, semantic-needs-human). Ambiguous is P1 and P2 made visible.

## The novelty: grounded *executable* feedback

A lot of tools can crawl a site, and comment-to-code is table stakes that editors
like Cursor already do well. Neither is the contribution here. The contribution is
that **every comment you leave compiles into something a machine can re-prove.**

Each comment becomes a five-leg tuple:

```
(mission id, action-sequence prefix, snapshot[DOM + screenshot], your words, a typed assertion)
```

Four of those legs are context. **Only one is the contribution: the typed
assertion**, because it is the only leg a machine can re-check. And codegen
**consumes the assertion, not the prose** — change the assertion and the edit
changes. (This isn't a claim; it's a test: `verify-edit-consume` feeds two tuples whose
assertions differ only in the `expected` value and asserts the generated edit writes
*that* value each time — the output varies with the assertion, not the prose.)

On re-walk, the agent replays the recorded action prefix and re-checks the same typed
assertion. When it passes where it used to fail, the verdict flips. The flip is **the
same checker run twice** — `checkAssertion` over a *before* state and an *after*
state — with the direction living entirely in the assertion's polarity, not in some
second grading engine. There is exactly one deterministic checker in the system, with
three entry points (first-walk, re-walk, regression replay), so the three can't drift.

That's the difference between executable feedback and a suggestion. When one LLM
writes a test *and* grades it, "green" is a confident vibe. SelfQA makes **"resolved"
a deterministic predicate flipping under human-anchored input** — and it does the
re-check with **zero LLM on the hot path** (more on the precise scope of that below).

## How it stays honest

The architecture spends real complexity to keep the two principles from being
aspirational:

- **Mechanical re-walk scope.** After an edit, which missions to re-walk is computed
  from the git diff through a two-bucket "provably-route-local, else everything"
  manifest — never from the agent's own report of what it changed. (P1.)
- **A hot-path that's provider-free, enforced — and here's the *precise* scope.**
  There are actually **two** mechanical gates, not one. First, an ESLint rule plus a
  grep (`verify-hot-path`) fail the build if any import from a `provider` module path
  — or the Anthropic SDK, or the `getProvider`/`AnthropicProvider` identifiers —
  appears anywhere under `harness/` or `walk/`. (The module-path rule is the real
  catch: it forbids even a type-only provider import.) Second, the per-comment
  re-check loop in `run-rewalk.ts` is fenced by `SELFQA-REWALK-LOOP-START/END`
  sentinels, and the same gate fails the build if `compileSequence`,
  `batchSemanticVerdict`, `getProvider`, `AnthropicProvider`, or `provider.complete`
  appears *inside that region*. So "zero LLM on the hot path" means precisely: **the per-comment
  replay/settle/re-assert loop calls no model.** It does **not** mean the pipeline is
  LLM-free — the codegen edit, the spec-extractor that types your comment into an
  assertion, and the single batched semantic verdict all call the model. They just
  run **off** the loop.
- **Promotion and retirement are yours.** A fixed mission becomes a permanent
  regression test only when *you* promote it; it's then frozen and replayed through
  the same checker on every later build, so it can't silently regress. Retiring one is
  **propose-then-human-approve** — there is no code path that drops a test
  automatically, and a grep test (`verify-regression`) proves only `approveRetirement`
  ever sets the `retired` status.
- **One honest nuance about the flip.** The *after* state is freshly re-walked; the
  *before* state is the snapshot **captured at comment time, reconstructed** into the
  same checker input (not a second live walk). The flip is `checkAssertion(before)` →
  `checkAssertion(after)`. This is by design — it's what makes the comparison cheap
  and deterministic — and it's worth stating plainly so "replays your exact steps and
  re-checks" isn't misread as re-walking both sides.

## What SelfQA deliberately does *not* claim

The credibility of a project like this is mostly in its disclaimers:

- **It is not "AI doing QA."** The agent never decides correctness. It compiles your
  comment into something re-provable and leaves the judging to you.
- **The crawler is not novel and comment-to-code is not the contribution.** The
  optional coverage panel (M7) is a side dish — a shallow, mechanically-deduped look
  around, clearly labeled *supplementary*; the headline artifact is the mission
  verdict list and the run-to-run diff.
- **It works only on apps the agent itself builds.** That closed world — it owns the
  routes, emits its own test-ids, seeds its own data — is exactly what makes
  deterministic verification tractable. SelfQA is not a tester of arbitrary
  third-party apps, and isn't trying to be.
- **It is not a sandbox.** v1 is a local, single-user tool that runs semi-trusted,
  self-prompted code. The SPEC states this as a hard precondition, not a footnote;
  don't deploy it as a hosted multi-tenant service.
- **The det:semantic ratio is a target, not a measured result.** The dashboard reports
  the share of comment assertions that are deterministic against an **≥80% threshold**
  (`DET_SEMANTIC_TARGET`). That's a design goal the dashboard holds you to — not an
  outcome the verify suite proves about any particular app.
- **"Resolved" is not guaranteed.** The convergence loop has a hard cap of 3; a comment
  that doesn't flip within the cap routes to **needs-human**. The hero demo shows one
  clean re-walk and one deterministic flip — it does **not** dramatize the ambiguous,
  unreachable, or needs-human paths, which are equally first-class outcomes.
- **`node:sqlite`, not Prisma.** SelfQA's own durable metadata, and the DB-backed
  isolation stub, use `node:sqlite` — disclosed in the code itself. It preserves the
  one property that matters (a server-side write routed by a **runtime** `DATABASE_URL`
  to a per-lane file, with the build-time-inlining trap), with zero engine/network/
  deps. The honest cost: it's a newer built-in that requires **Node ≥ 22.5**
  (`engines` in `package.json`), not a battle-tested ORM.

## What's actually built

The whole loop runs end-to-end with **no API key**, on a deterministic stub provider
(set `ANTHROPIC_API_KEY` for real codegen — the provider is one swappable interface).
The stub is what makes every claim above *reproducible by construction* rather than a
one-off recording; it's also why the demo's "codegen" is deterministic, not a live
model writing novel fixes.

`npm run verify:all` runs typecheck + lint + 33 `verify-*` scripts green. The single
most load-bearing one is `verify-loop-e2e`: build → walk → a reached-but-**ambiguous**
mission (its typed assertion is cleanly false) → step-anchored comment → the five-leg
tuple → codegen consumes the assertion → re-walk re-asserts → the assertion flips
false→true, moving the verdict ambiguous→pass → promote → it appears in the run diff →
it survives a worker restart → zero LLM on the loop region.

That test proves the *mechanism*. The thesis — that the right division of labor is a
machine that makes judgment cheap and a human who keeps it — is the part you're
invited to judge for yourself.
