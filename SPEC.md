# SelfQA — Specification

> An agent that builds web apps and verifies its own work.

This document specifies **what SelfQA is and why it is shaped the way it is.** The
build sequence lives in [PLAN.md](./PLAN.md). Every decision below is *locked* —
it was argued to, not defaulted to. Where a decision reconciles two rules that
appeared to conflict, the reconciliation is stated so it can't be silently undone
later.

---

## 1. Concept

One agent builds a web app from a natural-language prompt, then autonomously walks
its own creation. It attempts a set of **named user missions** end-to-end and
presents the results as a reviewable list. A human reviews that list and comments
on what's wrong. **Each comment compiles into a replayable, assertable test.** The
agent edits the code to fix the issue and **re-walks to prove the issue is
resolved.**

This collapses the *develop* and *test* stages of the SDLC into a single iterative
loop:

```
develop → verify → review → fix → (re-verify) → ...
```

— with the human as the judge throughout, instead of two separate stages with a
hand-off between them.

---

## 2. Thesis — why this design

**Correctness depends on intent, and intent lives in the human's head — so the
human stays the judge.**

The agent's job is **not** to decide what is good. Its job is to make the human's
judgment *cheap*: surface every relevant state, and turn each piece of human
feedback into a verified code change. Everything in this spec follows from that one
commitment.

---

## 3. The load-bearing novelty — grounded *executable* feedback

This is the heart of the project. Build everything around it.

Every human comment compiles into a tuple:

```
(mission id, action sequence, snapshot, NL comment, assertion)

  mission id      — which mission the feedback is anchored to
  action sequence — the deterministic steps to reach the commented state
  snapshot        — DOM + screenshot captured at that exact moment
  NL comment      — what the human said
  assertion       — { type: deterministic | semantic, predicate? }
```

The codegen agent receives **all of it**. On re-walk, the agent replays the action
sequence and **asserts that the resulting state changed in the way the comment
requested.** That assertion is what makes the loop *verifiable* instead of
vibes-based.

**The novelty is precisely this — grounded, executable feedback to codegen.** It is
**not** the crawler, **not** comment-to-code (Cursor owns that), **not** "AI does
QA." Those are table stakes or side dishes. The tuple — and the assertion that
closes the loop on it — is the contribution.

---

## 4. Named design principles

These sit at the top of the spec because **every future feature must be tested
against them.** They are not decoration; they are the constraints that keep the
project coherent past the point where any one person remembers every decision.

### P1 — The agent never decides whether its own work gets checked.

Wherever the agent could quietly exempt its own output from verification, the
architecture forbids it. Instances:

- **First-walk whitelist (§7.2):** the agent auto-asserts only against a *fixed*
  list of mechanically-knowable facts. It does not self-grade its confidence.
- **No silent retirement (§7.5):** the agent may *propose* retiring a regression
  test, but only a human can drop one. *"An agent that can silently delete its own
  failing tests can launder its mistakes"* — which is the exact thing an external
  judge exists to stop.
- **Mechanically-derived manifest (§8.3):** what gets re-walked is computed from the
  actual diff, never self-reported by the agent.

### P2 — The agent never infers what it's supposed to fix.

Wherever the agent would otherwise substitute a guess for a knowable quantity, the
architecture forbids the guess and forces the quantity to exist at the input.
Instance:

- **Trace-anchored comments (§10):** there is no path from comment to code except
  selecting a coordinate in a deterministic trace. *"A grounded-looking tuple aimed
  at the wrong target is worse than an honestly mission-level one, because the
  groundedness is now lying."*

### The three agent↔judgment relationships (positive checklist)

P1 and P2 are prohibitions. Stated positively, there are **exactly three** ways the
agent is allowed to relate to judgment. Every agent action must fall into one of
the three; **none of them is "the agent decides what is good, unsupervised."** A
future feature that needs a fourth box is the thing to reject on sight.

1. **Propose → dispose.** The agent suggests; the human's approval makes it ground
   truth. *(Initial verdicts §7.2; promotion & retirement §7.5.)*
2. **Enforce past judgment.** The agent acts automatically, but the judgment it
   enforces was *already* the human's. *(Deterministic frozen-regression hard-block
   §11.4 — the human approved that assertion as ground truth, so enforcing it
   mechanically honors a past human judgment rather than substituting an agent
   one.)*
3. **Surface → decide.** The agent establishes a fact mechanically and hands the
   human a specific, grounded choice. *(Conflicts, semantic flips, every
   `needs-human` state §11.4–§11.5.)*

---

## 5. Scope: only apps the agent itself builds

SelfQA works **only on apps the agent itself builds. This is a feature, not a
limitation.** Because one agent owns both sides — the app and its verification — it
knows the routes, it emits the test IDs, it can seed the data, and it can walk past
its own auth and payment walls. **Do not design for "works on any web app."** That
constraint is what makes the testing half tractable at all.

---

## 6. The verification spine — one mechanism, everywhere

There is **one** verification mechanism in the system, not two. This is the single
most important structural decision: it prevents two parallel judgment paths from
drifting apart.

### 6.1 The typed assertion

```
assertion := { type: deterministic | semantic, predicate? }
```

The same shape is used by **mission acceptance criteria** (§7.1) and by **comment
assertions** (§3). The compile step decides which kind you get and *records it*. The
checker dispatches on `type`:

- **deterministic** — a concrete, mechanically-checkable predicate
  (e.g. `[data-testid=cart-total]` text equals `$0.00`; no element matching
  `.error-banner` is visible; URL is `/login` after submit). Checked with **zero
  LLM involvement.** This is the "verifiable, not vibes" core; most actionable
  feedback ("missing confirmation," "accepts empty email," "total doesn't update")
  compiles cleanly to it.
- **semantic** — irreducibly fuzzy ("this feels cluttered," "the spacing is off").
  It cannot become a clean predicate, so it carries the snapshot + NL comment
  forward and is judged by **one batched LLM verdict call** comparing before/after
  against the comment.

### 6.2 One checker, three entry points

The same checker runs at:

1. **Initial walk** — first attempt at each mission.
2. **Re-walk** — after an edit, to prove a comment was resolved.
3. **Regression replay** — re-running a promoted regression test.

Build it once; use it in three places. They must never grow separate
implementations.

### 6.3 The hot path, and what an LLM call costs

> **Hot path** = the replay + settling loop: resolving selectors, executing the
> action sequence, waiting for the settling predicate, capturing state. This loop
> runs many times per mission. **It never contains an LLM call.** That is the rule
> that actually protects the latency budget, because that is where the repetition
> and the latency live.

LLM calls are allowed **outside** the hot path, specifically:

- **One batched semantic verdict** per mission *that carries semantic criteria*,
  fired after the deterministic replay is done. Deterministic-only missions cost
  **zero** LLM at re-walk.
- **Path recompile** (§8.1) when an edit invalidated a cached action sequence.

Both are one-shot, off-loop, and bounded — not per-step, not in the loop.

### 6.4 Tracked metric

**deterministic : semantic ratio** of compiled assertions. If ≥80% compile
deterministic, the "verifiable" claim is strong and the demo is bulletproof. If it
skews semantic, that is an early signal the loop is softer than the thesis promises
— better learned in M5 than at launch.

---

## 7. Missions — the review primitive

The review primitive is **missions, not a state graph.**

### 7.1 Derivation & shape

From the prompt + generated code, an LLM derives **8–15 named missions**
(e.g. "sign up with valid email," "sign up with empty email," "add item, remove it,
check total," "frustrated user mashes the back button," "malicious user submits a
10k-char input"). Each mission is:

```
{ id, name, NL description, ordered intended steps, acceptance criteria }
```

— and the **acceptance criteria are typed exactly like comment assertions**
(§6.1). This is the symmetry that keeps the system to one verification mechanism:
initial walk, re-walk, and regression replay all dispatch on the same `type` field
through the same checker.

### 7.2 The initial verdict — conservative by construction

On the first walk, *before any human comment exists*, the agent must propose a
verdict per mission. It does so **conservatively**, and this conservatism is the
thesis rendered in the UI, not a cost:

- **Auto-assert only against a fixed deterministic whitelist:**
  - HTTP status codes
  - post-action URL
  - presence/absence of elements matching a known-error selector set
  - native form-validation blocking submission
  - console errors thrown
- **Anything off the whitelist → `ambiguous: semantic-needs-human`.** No guessed
  `pass`/`fail` on anything that requires taste.

The whitelist is **fixed and enumerated**, not "the LLM felt confident." Letting the
agent self-grade its confidence would reintroduce exactly the discretion P1 removes.
On the whitelist → auto-assert. Off it → ambiguous.

The result: **run one is honest by construction.** Green means machine-verified, full
stop. Ambiguous means the agent is explicitly *not pretending to know*. The sort
order is "here's what I could verify, and here's everything I refuse to guess on" —
it sorts by **verifiability, not by taste**. (A list sorted by confident-looking
verdicts invites rubber-stamping; that would technically preserve "human is judge"
while practically letting the agent's taste drive what the human looks at. The
conservative rule kills that.)

The cost — a fuller ambiguous bucket on run one — is real but front-loaded and
self-decaying: once the human approves verdicts they become regression tests, and
later runs only re-ambiguate what changed.

### 7.3 `ambiguous` is a defined state, not a vague middle

`ambiguous` always carries a **reason enum** so the human knows which hat to wear
before clicking in:

```
ambiguous.reason := replay-failed | semantic-low-confidence | semantic-needs-human

  replay-failed          — selector ladder exhausted or flake-after-retry; the
                           agent could not even reach the state. → "your test is
                           flaky / the path moved, look at the trace."
  semantic-low-confidence — reached the state, but the LLM verdict was uncertain.
  semantic-needs-human   — reached the state, but judging it requires taste the
                           agent is not allowed to fake.
```

### 7.4 Durable identity vs. cached artifact

A mission's **durable identity** is `{ id, NL intent (the ordered steps in
language), typed acceptance criteria }`. The **action sequence is a build-specific
*cache*** — a compilation of that intent against one build — **not** part of the
identity. (This is what lets the novelty survive its own fixes; see §8.1.)

### 7.5 Promotion, the diff, and retirement

- **Promotion.** A verdict becomes *ground truth* only on **human approval**, and
  that approval **mints a permanent named regression test**.
- **Run-to-run diff.** Missions are matched across runs by **stable `id`**. The
  deriver runs *informed* — handed the existing mission set + frozen regression
  tests — and proposes **net-new missions only** rather than regenerating. The diff
  is then well-defined: same `id` + changed verdict = "changed outcome"; new `id` =
  "new surface." **This diff is the reviewable artifact** — not a graph diff.
- **Retirement.** When a mission's feature is removed, the agent may set it
  `retirement-proposed` (with a reason). **Only a human approval drops a regression
  test. No auto-drop** (P1).

---

## 8. Re-walk & cost control

**Target: under 2 minutes from comment to re-walked verdict, in steady state.** No
LLM calls in the hot path (§6.3).

### 8.1 Replay is an optimization; replaying *intent* is the contract

> "Replay the exact action sequence" is the **fast-path optimization** for the
> common case. The **durable contract** is "replay the mission *intent*,
> recompiling the sequence when the path changed."

- **Path untouched** (per the manifest, §8.3) → replay the cached action sequence
  exactly; selector ladder (§13) absorbs leaf drift; **zero LLM**; fast.
- **Path touched** → the cached sequence is presumed invalid (a fix can insert a
  required step, split a page, move an element, gate a flow — structural change, not
  just a renamed testid). The agent **recompiles** the action sequence from the
  mission's NL intent against the new code (it owns both sides). Recompile is an LLM
  call but is **outside the settling loop** (§6.3).
- **Recompile still can't reach the state** → `ambiguous: replay-failed`, surfaced
  with the trace. Never a silent guess.

### 8.2 Codegen modality — incremental editor, not regenerator

> **Codegen is a stateful editor of a persistent repo, not a regenerator.** The
> initial build is the **one and only** full generation; **every fix is a diff.**

A stochastic LLM regenerating a whole app churns everything — testids drift, seed
data shifts, file structure wobbles — so "touched routes" inflates to "almost
everything," the selector ladder fires constantly, fixtures destabilize, and the
2-minute target becomes fiction. Incremental editing (read current code, apply a
localized diff — the way Claude Code itself works) keeps untouched files
**byte-identical**, so fixtures/selectors are stable for free and "touched routes"
is honestly small.

*(Wherever older drafts said "rebuild," read "edit.")*

### 8.3 The touched-routes manifest — mechanical, and closed over imports

- **Mechanically derived from the actual file diff, never self-reported** (P1).
  Self-reported touched-routes is a discretion hole: under-report and you skip
  re-walking something you broke — the laundering failure mode in a different coat.
- **Import-graph closure**, not a naive file→route map. Editing a shared `<Button>`,
  a global layout, or a `lib/` util touches *one file* but breaks *every route that
  imports it*. So the manifest is: `touched files → transitive importers → affected
  routes → missions through those routes`, **∪ the always-on smoke set.** This is
  the only version that doesn't leak a regression through shared code.

### 8.4 v1 fallback — provably-local-else-everything

A correct Next.js import-graph resolver must understand app-vs-pages routing,
server/client component boundaries, dynamic imports, and barrel re-exports — real
effort. So v1 ships a **coarse but mechanical over-approximation**, *not*
"re-walk everything when in doubt" ("doubt" is unspecified and degrades into
discretion):

- If the diff touches any file with **>1 importer** (a cheap one-hop check —
  `components/`, `lib/`, `app/layout`, etc.) → re-walk the **full** mission set.
- If the diff touches only a **single route's own subtree** (no shared importers) →
  re-walk **just that route's missions + smoke set.**

Two buckets: *provably-local* → scoped; *anything else* → everything. It is
mechanical at the decision point (no discretion), and its only error is re-walking
*too much* — costing time, **never** correctness. The **precise import-graph closure
(TS compiler API / `madge`-style)** is the *earned optimization* that shrinks the
"everything" bucket; the 2-minute target applies to that steady state, not to M5 day
one.

### 8.5 Tracked metrics

- **recompile rate per re-walk** — if it climbs, the 2-minute target is eroding.
- **fraction of re-walks hitting the "everything" bucket** — high on day one
  (coarse approximation), drops as the precise import-graph lands. You can watch the
  optimization pay off.

---

## 9. State, data, and hermeticity

A verdict must be **reproducible** — the run-to-run diff is meaningless noise
otherwise. This section is the determinism substrate.

### 9.1 Per-mission isolation

Every mission starts from the **same known seed state, restored before it runs.**
Shared sequential state is poison: it makes a verdict a property of *mission order*,
not of the mission ("add item, remove it, check total" leaves the cart empty for
whatever runs next; flip two missions and verdicts change with no code change). With
restore-to-seed, **a verdict is a property of `(mission, build)` and nothing else** —
the precondition for the diff meaning anything, which is the precondition for the
whole regression-memory half of the product.

### 9.2 One primitive: snapshot/restore

The DB **snapshot/restore** hook is **the single primitive** for three things that
might otherwise be built three ways:

- **Isolation** — restore-to-seed before every mission.
- **Reproducibility** — same seed every time.
- **Destructive-action safety** — `delete account` needs no special handling; the
  next mission's restore *is* the cleanup.

"Run hermetically" simply means "ephemeral DB seeded from the snapshot, restored per
mission." Only outward-reaching actions (charge card, send real email) hit the
**mocks** instead — and those were already in the fixtures contract (§12).

### 9.3 Data layer — locked for the verifier's benefit

> **Locked: the agent builds the app's data layer on Prisma + SQLite,
> file-per-worker.**

This is load-bearing for the **testing** half exactly the way Next/Tailwind/shadcn is
load-bearing for the **app** half. file-per-worker makes snapshot/restore + parallel
isolation nearly free: *seed once → copy the file → each parallel walker gets its own
byte-identical file → discard after.* Shared Postgres drags you into per-test
transactions or truncate-and-reseed, which fight parallelism and turn the cheap
primitive expensive.

**Do not "upgrade" this to Postgres for app reasons** — it would silently break the
isolation economics. The data-layer lock exists for the verifier, not the app.

> **⚠ Implementation trap — name it now so it isn't misdiagnosed later.**
> file-per-worker sidesteps SQLite's single-writer limitation *only* if each worker
> truly gets its own file and **nothing shares a connection.** If any fixture or
> helper holds a shared connection, or a WAL file leaks across workers, you get
> intermittent `database is locked` errors that *look like settling flakiness* and
> will be misattributed to the settling predicate. **Strict file-per-worker, no
> shared connections, and a deliberate concurrent-write isolation test in M5 before
> trusting any parallel verdict.**

### 9.4 Seed-entity identity is stable-by-contract

Deterministic assertions reference seed entities (`cart-total` equals `$0.00` for
`seed-user-1`). If an edit renames or renumbers a seed entity, those assertions
silently break — identical to testid drift, same root cause, same discipline: under
incremental editing the fixtures file changes **only by diff**; codegen may *add*
seed entities but **must not gratuitously renumber or rename existing ones.**
Seed-entity stability and testid stability are the same rule on two surfaces.

### 9.5 Parallelism is first-class

**Parallel mission walking is the dominant lever on the 2-minute budget — more than
the import graph.** The import graph shrinks *how many* missions re-walk;
isolation-enabled parallelism collapses wall-clock to the **slowest single mission.**
They are multiplicative, and they differ in difficulty: parallelism is nearly free
the moment isolation holds (file-per-worker), whereas the precise import graph is
real effort earned later. Hence the M5 priority order (also in PLAN.md):

```
isolation + parallelism   (cheap, huge)
  > two-bucket manifest    (cheap, coarse)
    > precise import graph  (expensive, refining)
```

---

## 10. Comments — groundedness guaranteed at the input

Groundedness is a property of the **input**, not a post-hoc inference (P2). If a
human could drop a free-floating "login is broken," the agent would have to *infer*
which mission/step/state was meant — an LLM guess, which is the precise
ungrounded-vibes failure the whole project exists to kill, sneaking in through the
input instead of the verdict.

### 10.1 Hard constraint

**No codegen-bound comment exists without a trace anchor.** The UI offers **no path**
from comment to code except **selecting a coordinate in a deterministic mission
trace** — a `(mission, step)` point. The action-sequence prefix and the snapshot are
**read directly off the trace** at that coordinate; they are never inferred. That
single constraint is what makes three of the tuple's legs (mission, action sequence,
snapshot) exist **by construction** rather than by guess.

### 10.2 Comment taxonomy — three types, routed differently

| Type | Anchor | Routes to | Replayable? |
|------|--------|-----------|-------------|
| **step-anchored** | a `(mission, step)` point | codegen (full tuple) | yes |
| **mission-level** | a mission (no single step); action sequence = full trace, snapshot = terminal/failing step | codegen | yes (whole-trace grounded) |
| **meta / derivation** | "also test X"; "retire this mission" | deriver / retirement queue — **never codegen** | n/a |

**Mission-level is kept separate from step-anchored on purpose.** Forcing a
flow-level complaint ("this whole signup flow is too long") onto a representative
step produces **false precision** — a tuple that *looks* grounded but points at the
wrong place. A grounded-looking tuple aimed at the wrong target is worse than an
honestly mission-level one, because the groundedness is now lying.

**Meta feedback never masquerades as a code-change tuple.** Retirement re-enters the
human-approved path of §7.5.

### 10.3 Routing is mechanical, not classified

Which of the three types a comment is, is determined by the **UI affordance the
human used** — clicking a step → step-anchored; clicking a mission header →
mission-level; a separate "suggest a test / retire this" control → meta. The
interaction surface determines the type; we do **not** parse the comment text to
classify it (misrouting is its own discretion hole — a meta comment misrouted to
codegen becomes a garbage fix; a step comment misrouted to the deriver vanishes).

The **one** sanctioned exception: a step-anchored comment that is *actually* a meta
request ("this step is fine, but you should also test X"). That is the single place
the **spec-extractor's one clarifying question** earns its keep — "is this a fix for
this step, or a new test to add?" — with a **mechanical fallback to step-anchored.**
Never a silent reclassification.

### 10.4 The spec-extractor

Every comment passes through a **spec-extractor LLM** (off the hot path). It:

1. asks **exactly one** clarifying question when the comment is vague, then proceeds
   on best guess;
2. emits the typed `assertion` (§6.1), tagging it `deterministic` or `semantic`;
3. is the only sanctioned reclassifier, per §10.3.

### 10.5 Capability boundary — stated so nobody builds past it

| Phase | Comments are… |
|-------|---------------|
| **M1–M2** | grounded-in-**location** (URL + DOM path + screenshot region), **not replayable** |
| **M3+**   | grounded-in-location **AND replayable** (the full tuple) |

In M1–M2 the human hand-explores a live iframe; free-form clicks are **not** a
deterministic trace, so there is no action sequence to anchor to — and the M1–M2 win
condition deliberately does not require one. **Replayability begins at M3–M4**, the
first time feedback attaches to a deterministic trace. Stated here so nobody reads
"grounded executable feedback" as a day-one promise and builds against a
replayability guarantee that doesn't exist yet.

---

## 11. The loop — how one iteration executes and terminates

### 11.1 Git is the substrate; `build = commit SHA`

The app is a **git repo.** Initial build = initial commit; **every edit attempt = a
commit** on a working branch. **Verdicts key on the commit SHA** — this is what makes
`(mission, build)` from §9.1 concrete: `build` *is* the SHA. "Which code produced
this verdict" becomes a mechanical fact (the SHA), not something the agent reports.
**Rollback = `git revert`/`reset`** — free, auditable, no clever state machine.
Rejected attempts revert with **history preserved**, so even failed attempts are
auditable. *Plain git is the feature; resist getting cleverer than this.*

The **run-to-run diff backbone** is therefore: verdicts at `SHA_n` vs `SHA_{n-1}`.

### 11.2 Batch per review pass

A review pass yields a *set* of anchored comments. **Batch the whole pass into one
edit + one re-walk** (budget win), because **attribution survives batching for
free:** each comment already carries its own assertion (§6.1), so after one batched
edit and one re-walk you check **each comment's assertion independently** — A's fix
confirmed by A's assertion flipping, B's by B's, regardless of being edited together.

> This is the typed-assertion spine paying a dividend it wasn't designed for: the
> assertions were for *verification*, and they turn out to be what makes *batching*
> safe.

Do **not** fall back to serial per-comment edits — that pays N re-walks for
attribution you already get for free. The one genuine hazard, two fixes conflicting
in the same region, is handled in §11.4.

### 11.3 Convergence — the loop provably terminates

After the batched edit + re-walk, check every comment's assertion. Any that didn't
flip → the fix failed for that comment → feed the new state back to codegen and
retry, bounded by a **hard attempt cap.**

- The cap is a **mechanical count** (configurable, **default 3**) — **not** "codegen
  thinks it's stuck" (that self-assessment is exactly what P1 forbids).
- After the cap, mark the comment **`unresolved: needs-human`** and **stop.** No path
  loops forever.

### 11.4 Fix-induced regression gate

Every re-walk's blast radius is `affected missions ∪ smoke set ∪ the frozen
regression tests in the affected set` (§8.3 decides "affected"). Then:

- A previously-human-approved **deterministic** regression test flipping red is a
  **mechanically-certain** regression → it **hard-blocks the edit.** Codegen must
  satisfy *both* the new comment's assertion *and* the existing regression, within
  the §11.3 cap.
  > This is **not** the agent deciding what is good. The human approved that
  > assertion as ground truth (§7.5); enforcing it mechanically **honors a past
  > human judgment** rather than substituting an agent one. (Relationship #2.)
- A **semantic** regression test flipping **cannot** be mechanically certain (it's a
  judgment) → it does **not** auto-block; it **surfaces as `newly-failing`** in the
  diff for human review.

### 11.5 Escalation as a grounded choice

When codegen cannot satisfy both within the cap, or two comments are mutually
unsatisfiable in the same region, the agent surfaces an **explicit, grounded,
specific tradeoff** — *"fixing X breaks Y — your call,"* or *"comments A and B are
mutually unsatisfiable."* Not "I'm confused." The agent does exactly its job (surface
the conflict, grounded and specific) and **nothing more** (it does not pick). The
human accepts the tradeoff and may human-retire the loser via §7.5. (Relationship
#3.)

---

## 12. The fixtures contract

The build agent emits **two artifacts: the app, and a fixtures file** — so the agent
can walk past its own auth/payment walls. The fixtures file provides:

- **seed users** + a programmatic **login hook**
- **mock payment keys**
- **stubbed email / OTP**
- **deterministic seed data** with **stable identities** (§9.4)
- a **DB snapshot/restore hook** (§9.2)

Destructive actions (delete account, charge card) are **marked** and either
**confirmed** by the human or run **hermetically** (the restore primitive, §9.2).
Outward-reaching actions hit the mocks, never the real service — and §13.3
egress-blocking enforces this at a second layer.

---

## 13. Browser automation & determinism

### 13.1 Engine

**Playwright.**

### 13.2 Selector ladder (replay determinism)

Record action sequences against the **accessibility tree** and resolve in this order,
re-resolving at replay time with fallbacks:

```
data-testid  >  role + name  >  text  >  xpath
```

**Log failures loudly.**

### 13.3 Settling predicate (do not trust `networkidle`)

A state is "settled" when **all** hold:

- **RAF quiescence**
- **MutationObserver quiet for 500 ms**
- **no pending fetches**

Expect **5–10% flakiness**; **retry once.**

---

## 14. Host architecture

### 14.1 SelfQA itself

**SelfQA is itself a Next.js + TypeScript + Tailwind + shadcn/ui app** — it dogfoods
the locked stack, and its own existence is a proof the stack is buildable. Because
the orchestration work (driving Playwright, managing subprocesses, long re-walks, the
job queue) does not fit request/response, SelfQA is:

- **One repo, two processes:** the **Next UI** + a **long-running Node/TS worker**
  that owns the job queue.
- **Live walk progress over SSE/WebSocket.** Walks take minutes; the reviewer
  *watches missions resolve* rather than polling a spinner. This is **product, not
  plumbing** — "watch the missions go green in real time" is half the demo's
  emotional payload.

Resist anything cleverer than two processes for v1.

### 14.2 Where generated apps run

Each generated app is its **own git repo** in a workspace dir (§11.1), run as a
**lifecycle-managed `next dev` subprocess** on an allocated port; Playwright hits
`localhost:port`; start before walk, kill after, **reap orphans.** Subprocess for v1;
**Docker-per-app explicitly deferred** (it buys isolation not needed at single-user
scale and adds real infra weight).

### 14.3 Egress blocked — the network-layer half of hermeticity

**Network egress is blocked for generated apps by default.** This is **not** a
standalone safety bullet — it is the **§9 hermeticity invariant enforced at a second
layer.** §9 makes a verdict a property of `(mission, build)` at the *data* layer
(restore-to-seed); egress-blocking enforces the same invariant at the *network*
layer: a generated app **cannot silently reach a real API** and make a verdict depend
on the outside world, so the mocks are **provably** the only external path. *A verdict
that depends on a live external API is a corrupted verdict; egress-blocking makes
that corruption impossible rather than merely discouraged.* It is the one piece of
hardening that earns its place even in semi-trusted v1 (cheap, doubles as a
correctness guarantee, and contains the blast radius of "dumb code" that
accidentally phones home).

### 14.4 Threat model — a hard deployment precondition, not a footnote

The malicious-input missions ("10k-char input," "back-button mashing") are **inputs
to the app under test, not attacks on the host** — they test the app's own
validation; the hostility is aimed at the generated app, not at SelfQA. So the honest
threat model is *"LLM-written code has a bug or does something dumb,"* not *"an
adversary controls it."* The code is **semi-trusted** (you prompted it), not hostile.
This correctly justifies **not** building an adversarial sandbox in v1.

This boundary gets louder treatment than anything else in this spec, because it is
the **only** "wrong" in the project whose cost is not a bad verdict:

> **DEPLOYMENT PRECONDITION (hard).** SelfQA v1 executes **semi-trusted,
> self-prompted code as a local, single-user tool. It is NOT a sandbox. Do NOT
> deploy it as a public, multi-tenant, or hosted service** — doing so executes
> untrusted code with host filesystem access (i.e. you would ship a remote
> code-execution service without realizing it). **Docker-per-app or a microVM is the
> *mandatory* (not optional) prerequisite before any untrusted or multi-user
> deployment.** Egress-blocking (§14.3) is in v1; everything else (Docker, microVM,
> seccomp) is the named earned hardening for the day the trust assumption changes.

### 14.5 Storage — three tiers by data shape

- **SQLite** — SelfQA's own structured metadata (runs, missions, verdicts, comments,
  assertions, regression tests, the four dashboard metrics). **Distinct from the
  generated apps' per-worker SQLite** (§9.3); do not conflate the tool's database
  with the apps' databases.
- **Filesystem** — heavy artifacts (videos, per-step screenshots, DOM snapshots),
  referenced by path from SQLite.
- **Git** — each generated app's code + history (the §11.1 substrate).

---

## 15. Locked technical stack

| Layer | Choice | Why locked |
|-------|--------|-----------|
| App frontend (and SelfQA itself) | **Next.js + TypeScript + Tailwind + shadcn/ui** | The agent builds in *one* stack; that constraint is what makes the testing half tractable. SelfQA dogfoods it. |
| App data layer | **Prisma + SQLite, file-per-worker** | Cheap snapshot/restore + parallel isolation (§9.3). Locked for the verifier's benefit. |
| Codegen engine | **Direct Anthropic API behind a provider interface** | Swappable behind the interface. |
| Browser automation | **Playwright** | §13. |
| Selector ladder | **`data-testid > role+name > text > xpath`** | Replay determinism (§13.2). |
| Settling predicate | **RAF quiescence + MutationObserver quiet 500 ms + no pending fetches** | Don't trust `networkidle`; 5–10% flake, retry once (§13.3). |

---

## 16. The four-metric dashboard

Tracked from the moment each becomes measurable; together they tell you whether the
core claims are holding:

1. **deterministic : semantic ratio** (§6.4) — is feedback actually verifiable, or
   softening toward vibes?
2. **recompile rate per re-walk** (§8.5) — is the 2-minute target eroding?
3. **fraction of re-walks hitting the "everything" bucket** (§8.5) — is the
   coarse-to-precise manifest optimization paying off?
4. **distribution of attempts-to-resolution** (§11.3) — is the default cap of 3
   right, too high, or too low?

---

## 17. Explicitly cut from v1

- **A standalone visual critic.** Mission failure + route depth + novelty surface
  enough.
- **Auth / payments / external APIs** beyond the mocked fixtures.
- **Multi-step wizards longer than 2 steps.**
- **Spec-first authoring.** The whole point is that users *avoid* writing specs by
  prompting an agent.

---

## 18. What "done" looks like

The hero artifact is a **90-second video**: prompt → app → mission list → comment on a
failed mission step → re-walked verdict flips green, regression test added. SelfQA is
open-sourced with a short essay explaining the thesis (§2) and the novelty (§3).

See [PLAN.md](./PLAN.md) for the milestone path to that artifact.
