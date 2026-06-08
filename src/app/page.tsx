"use client";

import { useEffect, useRef, useState } from "react";

interface BuildResult {
  appId: string;
  url: string;
  sha: string;
}

interface CommentTarget {
  url: string;
  domPath: string;
  rect: { x: number; y: number; width: number; height: number };
}

export default function Home() {
  const [prompt, setPrompt] = useState("a simple todo app");
  const [building, setBuilding] = useState(false);
  const [app, setApp] = useState<BuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [commentMode, setCommentMode] = useState(false);
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [commentText, setCommentText] = useState("");
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

  function postToIframe(msg: unknown) {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }

  function toggleCommentMode() {
    const on = !commentMode;
    setCommentMode(on);
    postToIframe({ type: "selfqa:comment-mode", on });
    if (!on) setTarget(null);
  }

  async function build() {
    setBuilding(true);
    setError(null);
    setApp(null);
    setTarget(null);
    setCommentMode(false);
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
      setStatus(null);
    } finally {
      setBuilding(false);
    }
  }

  async function submitComment() {
    if (!app || !target) return;
    setStatus("Sending grounded comment…");
    try {
      const res = await fetch("/api/comment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: app.appId,
          url: target.url,
          domPath: target.domPath,
          rect: target.rect,
          nl: commentText,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "comment failed");
      // The edit triggers a rebuild on a NEW port; use the url the worker returns.
      const newUrl: string = data.url ?? app.url;
      setApp({ ...app, url: newUrl, sha: data.sha ?? app.sha });
      setStatus(`Edit applied (sha ${data.sha ?? "?"}). Reloading…`);
      if (iframeRef.current) iframeRef.current.src = `${newUrl}?t=${Date.now()}`;
      setTarget(null);
      setCommentText("");
      setCommentMode(false);
    } catch (e) {
      setStatus(`Comment: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
          <button
            onClick={toggleCommentMode}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              commentMode ? "bg-amber-500 text-white" : "bg-gray-200 text-gray-800"
            }`}
            data-testid="comment-mode-toggle"
          >
            {commentMode ? "Comment mode: ON (click an element)" : "Comment mode"}
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-96 flex-col gap-3 overflow-y-auto border-r p-4">
          <label className="text-sm font-medium">Prompt</label>
          <textarea
            className="h-28 resize-none rounded border p-2 text-sm"
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

          {status && <p className="text-sm text-gray-600">{status}</p>}
          {error && (
            <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>
          )}

          {app && (
            <div className="rounded bg-gray-50 p-2 text-xs text-gray-600">
              <div>appId: {app.appId}</div>
              <div>build: {app.sha.slice(0, 10)}</div>
              <div className="truncate">url: {app.url}</div>
            </div>
          )}

          {target && (
            <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3">
              <p className="text-xs font-medium text-amber-800">
                Grounded comment (M1: location, not yet replayable)
              </p>
              <p className="break-all text-xs text-gray-600">
                <span className="font-mono">{target.domPath}</span>
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
        </aside>

        <main className="min-h-0 flex-1 bg-gray-100">
          {app ? (
            <iframe
              ref={iframeRef}
              src={app.url}
              className="h-full w-full border-0 bg-white"
              data-testid="app-iframe"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-gray-400">
              Build an app to explore it here.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
