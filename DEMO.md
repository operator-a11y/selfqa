# The 90-second hero demo

The win condition is a loop, so the demo is a loop: **build → walk → comment on a
reached-but-unproven mission → watch its verdict go green → promote it to a regression
test → prove it survived a restart.** A 30-second video can't live in a git repo, so
the demo here is **reproducible**: one command runs the whole arc and narrates it.

```bash
npm run demo        # narrated, end-to-end, ~30–60s steady-state, no API key
```

`npm run demo` drives the real worker over HTTP on the deterministic stub provider
and prints the beats below with their real values and the hero state's last-step
screenshot path. The verification lines in the storyboard (the zero-LLM scan, the
post-restart assertions) come from the hard-assertion **proof**,
`npx tsx scripts/verify-loop-e2e.ts`; the **clickable** version is `npm run worker`
+ `npm run build && npm run start`, which drives the *same worker* from the browser
(the flip banner, the run-diff, the Promote button, the Metrics and Coverage tabs).

## Storyboard (beat by beat)

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:08 | Title: *"SelfQA — an agent that builds a web app, then verifies its own work. You are the judge."* Terminal: `npm run demo`. | An agent writes a web app, then walks itself through it to check its own work — and a human signs off. This is a real run on a deterministic stub provider, so it reproduces exactly. |
| 0:08–0:18 | `build → appId + url + sha`; a glimpse of the generated todo app. | It builds a Next.js app from one line. Because it built it, it knows every route, emits its own test-ids, and seeds its own data — it owns both sides of the test. |
| 0:18–0:30 | `walk → ≥ 8 missions`; the verdict list, sorted most-actionable first (fail > ambiguous > pass — here all *ambiguous*). | It derives named missions — add a todo, remove one, an empty-submit edge case — and walks each in real Chromium. A verdict list to review in three minutes, not a thirty-minute crawl. |
| 0:30–0:40 | `found a REACHED-but-non-pass mission`; the step trace expands. | The honest part: it reached this mission but couldn't *prove* it passed — it's **ambiguous**, flagged, not faked green (its typed assertion is cleanly false). You click into that step. |
| 0:40–0:54 | The five tuple legs print: mission id · action prefix · snapshot (DOM+screenshot) · your words · a typed deterministic assertion. | Your plain-English comment compiles into a five-leg tuple anchored to that exact step. Four legs are context; the typed assertion is the contribution — it's the only leg a machine can re-check. |
| 0:54–1:06 | `codegen consumed the assertion → re-walk FLIPPED`; the green flip banner. | Codegen consumes that typed assertion and edits the code. On re-walk it replays your steps and re-checks the same assertion — it flips **false→true**, moving the mission verdict **ambiguous→pass**. The *after* is freshly walked; the *before* is your comment-time snapshot, reconstructed into the same checker. Verified, not vibes. |
| 1:06–1:14 | `re-walk loop region invokes NO provider/LLM`; `run-to-run diff: the hero newly PASSES`. | Two quiet guarantees: the re-walk scope came mechanically from the git diff, not the agent's say-so; and the per-comment re-check loop runs with zero LLM on it. The diff records this mission as newly passing. |
| 1:14–1:22 | `promote mints a permanent regression test` (the Promote button, in this beat only). | On your approval — only yours — the fixed mission is frozen into a regression test, replayed through the same checker on every future build so it can't silently break again. |
| 1:22–1:30 | Worker killed + restarted; `after restart: the flipped verdict persisted`, `…the regression test persisted`. `OK: SelfQA closes the loop end-to-end…` | Kill the worker, bring it back — the flip, the verdict, the regression, the metrics are all still there. Build, walk, comment, flip, promote, remember: one tight loop, durable, with you as the judge. |

## What this demo deliberately does *not* dramatize

1. **It runs on the stub provider.** The "codegen" is reproducible-by-construction,
   not a live model writing a novel fix. Set `ANTHROPIC_API_KEY` for that.
2. **It shows only the happy flip.** The hero is hand-picked: a *reached-but-ambiguous*
   mission whose typed assertion is cleanly false, so the assertion flips false→true
   and the verdict moves ambiguous→pass. (On the stub, the missions never hard-*fail* —
   their deterministic first-walk criteria always hold — so "ambiguous" is the honest
   pre-state, not "fail".) Unreachable missions and needs-human comments (a comment
   that doesn't flip within the cap-of-3) are equally real outcomes — just not this arc.
3. **Timing is steady-state and soft-logged.** Warm deps, exactly one re-walk. Not a
   cold first build (which installs deps), not the convergence loop. Don't read the
   seconds as a cap.
4. **`npm run demo` and the clickable UI are two equivalent drivings of the same
   worker**, not one recording. The headless script is the proof of record; the UI
   shows the same `/api/comment` machinery with a human clicking.
5. **The coverage panel (M7) is supplementary** and not part of this hero loop.
6. **The agent never decides correctness.** "Green" means machine-verified; every
   verdict and promotion needs your approval.
