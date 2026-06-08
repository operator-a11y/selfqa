"use client";

import { useEffect, useRef, useState } from "react";

interface BuildResult {
  appId: string;
  url: string;
  sha: string;
}
interface VerdictT {
  status: "pass" | "fail" | "ambiguous";
  ambiguousReason?: string;
  humanApproved: boolean;
}
interface StepT {
  index: number;
  actionKind: string;
  url: string;
  screenshot: string;
  dom: string;
}
interface TraceT {
  reached: boolean;
  attempts: number;
  entryRoute: string;
  steps: StepT[];
  video?: string;
  consoleErrors: string[];
}
interface MissionRunT {
  mission: { id: string; name: string; description: string };
  verdict: VerdictT;
  trace: TraceT;
  regressionPromoted?: boolean;
}
interface RunT {
  appId: string;
  buildSha: string;
  missions: MissionRunT[];
}
interface FlipT {
  assertionResult: string;
  verdict: VerdictT;
  resolved: boolean;
  detail: string;
}
interface DiffT {
  newlyPass: string[];
  newlyFail: string[];
  changed: { missionId: string; from: string; to: string }[];
}
interface CommentTarget {
  url: string;
  domPath: string;
  rect: { x: number; y: number; width: number; height: number };
}

const artifactUrl = (p: string) => `/api/artifact?path=${encodeURIComponent(p)}`;

function VerdictBadge({ v }: { v: VerdictT }) {
  const cls =
    v.status === "pass"
      ? "bg-green-100 text-green-800"
      : v.status === "fail"
        ? "bg-red-100 text-red-800"
        : "bg-amber-100 text-amber-800";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {v.status}
      {v.status === "ambiguous" && v.ambiguousReason ? ` · ${v.ambiguousReason}` : ""}
    </span>
  );
}

export default function Home() {
  const [prompt, setPrompt] = useState("a simple todo app");
  const [building, setBuilding] = useState(false);
  const [app, setApp] = useState<BuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [tab, setTab] = useState<"review" | "explore">("review");

  // review state
  const [walking, setWalking] = useState(false);
  const [run, setRun] = useState<RunT | null>(null);
  const [selectedMission, setSelectedMission] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ missionId: string; stepIndex?: number } | null>(null);
  const [commentText, setCommentText] = useState("");
  const [flip, setFlip] = useState<FlipT | null>(null);
  const [diff, setDiff] = useState<DiffT | null>(null);

  // explore (iframe) state — M1 flow
  const [commentMode, setCommentMode] = useState(false);
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const data = e.data as { type?: string } & Partial<CommentTarget>;
      if (data && data.type === "selfqa:comment-target") {
        setTarget({
          url: data.url ?? "",
          domPath: data.domPath ?? "",
          rect: data.rect ?? { x: 0, y: 0, width: 0, height: 0 },
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function build() {
    setBuilding(true);
    setError(null);
    setApp(null);
    setRun(null);
    setSelectedMission(null);
    setAnchor(null);
    setStatus("Building app (first build installs deps, ~40s)…");
    try {
      const res = await fetch("/api/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "build failed");
      setApp(data as BuildResult);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  }

  async function runMissions() {
    if (!app) return;
    setWalking(true);
    setStatus("Deriving + walking missions…");
    setRun(null);
    setSelectedMission(null);
    try {
      const res = await fetch("/api/walk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: app.appId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "walk failed");
      setRun(data as RunT);
      setSelectedMission((data as RunT).missions[0]?.mission.id ?? null);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWalking(false);
    }
  }

  async function refreshMissions() {
    if (!app) return;
    try {
      const res = await fetch(`/api/missions?appId=${encodeURIComponent(app.appId)}`);
      const data = await res.json();
      if (res.ok) setRun(data as RunT);
    } catch {
      /* ignore */
    }
  }

  async function promote(missionId: string) {
    if (!app) return;
    try {
      await fetch("/api/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: app.appId, missionId }),
      });
      setStatus(`Promoted ${missionId} to a permanent regression test.`);
      await refreshMissions();
    } catch (e) {
      setStatus(`Promote: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function submitComment() {
    if (!app) return;
    const body: Record<string, unknown> = { appId: app.appId, nl: commentText };
    if (anchor) {
      body.missionId = anchor.missionId;
      body.commentType = typeof anchor.stepIndex === "number" ? "step-anchored" : "mission-level";
      if (typeof anchor.stepIndex === "number") body.stepIndex = anchor.stepIndex;
    } else if (target) {
      body.url = target.url;
      body.domPath = target.domPath;
    } else {
      return;
    }
    setStatus("Comment → tuple → edit → rebuild → re-walk…");
    setFlip(null);
    setDiff(null);
    try {
      const res = await fetch("/api/comment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "comment failed");
      if (data.route === "needs-human") {
        setStatus(`Couldn't ground this comment (${data.reason}) → needs-human.`);
        return;
      }
      const newUrl: string = data.url ?? app.url;
      setApp({ ...app, url: newUrl, sha: data.sha ?? app.sha });
      setFlip((data.flip as FlipT) ?? null);
      setDiff((data.diff as DiffT) ?? null);
      setStatus(
        data.flip?.assertionResult === "flipped"
          ? "✓ assertion flipped fail→pass"
          : `re-walk outcome: ${data.flip?.assertionResult ?? "done"}`,
      );
      setAnchor(null);
      setTarget(null);
      setCommentText("");
      if (iframeRef.current) iframeRef.current.src = `${newUrl}?t=${Date.now()}`;
      await refreshMissions();
    } catch (e) {
      setStatus(`Comment: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function toggleCommentMode() {
    const on = !commentMode;
    setCommentMode(on);
    iframeRef.current?.contentWindow?.postMessage({ type: "selfqa:comment-mode", on }, "*");
    if (!on) setTarget(null);
  }

  const selected = run?.missions.find((m) => m.mission.id === selectedMission) ?? null;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold">SelfQA</h1>
          <p className="text-xs text-gray-500">
            An agent that builds web apps and verifies its own work
          </p>
        </div>
        {app && (
          <div className="flex gap-1 text-sm">
            <button
              onClick={() => setTab("review")}
              className={`rounded px-3 py-1.5 ${tab === "review" ? "bg-black text-white" : "bg-gray-200"}`}
              data-testid="tab-review"
            >
              Review
            </button>
            <button
              onClick={() => setTab("explore")}
              className={`rounded px-3 py-1.5 ${tab === "explore" ? "bg-black text-white" : "bg-gray-200"}`}
              data-testid="tab-explore"
            >
              Explore
            </button>
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 flex-col gap-3 overflow-y-auto border-r p-4">
          <label className="text-sm font-medium">Prompt</label>
          <textarea
            className="h-24 resize-none rounded border p-2 text-sm"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            data-testid="prompt-input"
          />
          <button
            onClick={build}
            disabled={building}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            data-testid="build-button"
          >
            {building ? "Building…" : "Build app"}
          </button>
          {app && (
            <button
              onClick={runMissions}
              disabled={walking}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              data-testid="run-missions-button"
            >
              {walking ? "Walking missions…" : "Run missions"}
            </button>
          )}
          {status && <p className="text-sm text-gray-600">{status}</p>}
          {error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
          {app && (
            <div className="rounded bg-gray-50 p-2 text-xs text-gray-600">
              <div>appId: {app.appId}</div>
              <div>build: {app.sha.slice(0, 10)}</div>
            </div>
          )}
          {run && (
            <div className="text-xs text-gray-500">
              {run.missions.filter((m) => m.verdict.status === "fail").length} failed ·{" "}
              {run.missions.filter((m) => m.verdict.status === "ambiguous").length} ambiguous ·{" "}
              {run.missions.filter((m) => m.verdict.status === "pass").length} passed
            </div>
          )}

          {flip && (
            <div
              className={`rounded p-2 text-xs ${flip.assertionResult === "flipped" ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"}`}
              data-testid="flip-result"
            >
              <div className="font-medium">
                re-walk: {flip.assertionResult === "flipped" ? "✓ assertion flipped fail→pass" : flip.assertionResult}
              </div>
              <div className="text-gray-600">{flip.detail}</div>
            </div>
          )}

          {diff && (diff.newlyPass.length > 0 || diff.newlyFail.length > 0 || diff.changed.length > 0) && (
            <div className="rounded bg-gray-50 p-2 text-xs text-gray-700" data-testid="run-diff">
              <div className="font-medium">Run-to-run diff (SHA vs SHA)</div>
              {diff.newlyPass.length > 0 && <div className="text-green-700">newly pass: {diff.newlyPass.join(", ")}</div>}
              {diff.newlyFail.length > 0 && <div className="text-red-700">newly fail: {diff.newlyFail.join(", ")}</div>}
              {diff.changed.map((c) => (
                <div key={c.missionId}>
                  {c.missionId}: {c.from} → {c.to}
                </div>
              ))}
            </div>
          )}
        </aside>

        <main className="min-h-0 flex-1 bg-gray-50">
          {tab === "explore" ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-2 border-b bg-white px-3 py-2">
                {app && (
                  <button
                    onClick={toggleCommentMode}
                    className={`rounded px-3 py-1.5 text-sm font-medium ${commentMode ? "bg-amber-500 text-white" : "bg-gray-200"}`}
                    data-testid="comment-mode-toggle"
                  >
                    {commentMode ? "Comment mode: ON (click an element)" : "Comment mode"}
                  </button>
                )}
                {target && (
                  <span className="truncate font-mono text-xs text-gray-600">{target.domPath}</span>
                )}
              </div>
              {app ? (
                <iframe ref={iframeRef} src={app.url} className="min-h-0 flex-1 border-0 bg-white" data-testid="app-iframe" />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-gray-400">Build an app to explore it.</div>
              )}
            </div>
          ) : (
            <div className="flex h-full min-h-0">
              <div className="w-72 overflow-y-auto border-r bg-white" data-testid="mission-list">
                {!run ? (
                  <div className="p-4 text-sm text-gray-400">Run missions to see verdicts.</div>
                ) : (
                  run.missions.map((m) => (
                    <button
                      key={m.mission.id}
                      onClick={() => {
                        setSelectedMission(m.mission.id);
                        setAnchor(null);
                      }}
                      className={`flex w-full flex-col items-start gap-1 border-b px-3 py-2 text-left text-sm hover:bg-gray-50 ${selectedMission === m.mission.id ? "bg-indigo-50" : ""}`}
                      data-testid="mission-row"
                    >
                      <VerdictBadge v={m.verdict} />
                      <span className="text-gray-800">{m.mission.name}</span>
                    </button>
                  ))
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {!selected ? (
                  <div className="text-sm text-gray-400">Select a mission.</div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <VerdictBadge v={selected.verdict} />
                      <h2 className="text-base font-semibold">{selected.mission.name}</h2>
                    </div>
                    <p className="text-sm text-gray-600">{selected.mission.description}</p>
                    <div className="flex gap-2 text-xs">
                      <button
                        onClick={() => setAnchor({ missionId: selected.mission.id })}
                        className="rounded bg-gray-200 px-2 py-1"
                        data-testid="comment-mission"
                      >
                        Comment on mission
                      </button>
                      <button
                        onClick={() => promote(selected.mission.id)}
                        disabled={selected.regressionPromoted}
                        className="rounded bg-green-600 px-2 py-1 text-white disabled:opacity-50"
                        data-testid="promote-mission"
                      >
                        {selected.regressionPromoted ? "✓ regression test" : "Promote to regression test"}
                      </button>
                      {selected.trace.video && (
                        <a className="rounded bg-gray-200 px-2 py-1" href={artifactUrl(selected.trace.video)} target="_blank" rel="noreferrer">
                          video
                        </a>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {selected.trace.steps.map((s) => (
                        <button
                          key={s.index}
                          onClick={() => setAnchor({ missionId: selected.mission.id, stepIndex: s.index })}
                          className={`flex flex-col gap-1 rounded border p-1 text-left text-xs hover:border-indigo-400 ${anchor?.stepIndex === s.index && anchor?.missionId === selected.mission.id ? "border-indigo-500" : ""}`}
                          data-testid="step-thumb"
                        >
                          <span className="text-gray-500">
                            step {s.index} · {s.actionKind}
                          </span>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={artifactUrl(s.screenshot)} alt={`step ${s.index}`} className="w-full rounded border" />
                        </button>
                      ))}
                    </div>

                    {anchor && (
                      <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3">
                        <p className="text-xs font-medium text-amber-800">
                          Grounded comment ·{" "}
                          {typeof anchor.stepIndex === "number" ? `step ${anchor.stepIndex}` : "whole mission"}
                        </p>
                        <textarea
                          className="h-20 resize-none rounded border p-2 text-sm"
                          placeholder="What's wrong here?"
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                          data-testid="comment-input"
                        />
                        <button
                          onClick={submitComment}
                          className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white"
                          data-testid="comment-submit"
                        >
                          Submit comment
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
