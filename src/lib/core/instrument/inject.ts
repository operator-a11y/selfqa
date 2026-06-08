/**
 * Comment-capture instrumentation (SPEC §5, §10.5).
 *
 * A SelfQA UI shows a generated app in a CROSS-ORIGIN iframe, so the parent
 * cannot read the iframe's DOM. Because the agent owns both sides, we inject a
 * tiny client overlay INTO the generated app: in "comment mode" it intercepts a
 * click, computes the element's DOM path (preferring data-testid) + bounding
 * rect, and postMessage()s that grounded context up to the parent.
 *
 * This is the M1 grounded-IN-LOCATION capture (URL + DOM path + region); pixel
 * screenshots arrive with Playwright at M3+ (SPEC §10.5). Pure string work.
 */
import type { GeneratedApp } from "../codegen/build-agent";

/**
 * The overlay is a Next client component written verbatim into the generated
 * app. Authored WITHOUT template literals so it embeds cleanly as a string.
 */
const OVERLAY_SOURCE = [
  '"use client";',
  "",
  'import { useEffect } from "react";',
  "",
  "function domPath(el: Element): string {",
  "  const parts: string[] = [];",
  "  let node: Element | null = el;",
  "  while (node && node.nodeType === 1 && parts.length < 20) {",
  '    const tid = node.getAttribute("data-testid");',
  "    if (tid) {",
  '      parts.unshift("[data-testid=" + JSON.stringify(tid) + "]");',
  "      break;",
  "    }",
  "    let sel = node.tagName.toLowerCase();",
  "    const parent = node.parentElement;",
  "    if (parent) {",
  "      const current: Element = node;",
  "      const sibs = Array.from(parent.children).filter(",
  "        (c) => c.tagName === current.tagName,",
  "      );",
  "      if (sibs.length > 1) {",
  '        sel += ":nth-of-type(" + (sibs.indexOf(current) + 1) + ")";',
  "      }",
  "    }",
  "    parts.unshift(sel);",
  "    node = node.parentElement;",
  "  }",
  '  return parts.join(" > ");',
  "}",
  "",
  "export default function SelfQAOverlay(): null {",
  "  useEffect(() => {",
  "    let commentMode = false;",
  "    function onMessage(e: MessageEvent) {",
  "      const data = e.data;",
  '      if (data && data.type === "selfqa:comment-mode") {',
  "        commentMode = Boolean(data.on);",
  '        document.documentElement.style.cursor = commentMode ? "crosshair" : "";',
  "      }",
  "    }",
  "    function onClick(e: MouseEvent) {",
  "      if (!commentMode) return;",
  "      e.preventDefault();",
  "      e.stopPropagation();",
  "      const target = e.target as Element;",
  "      const rect = target.getBoundingClientRect();",
  "      window.parent.postMessage(",
  "        {",
  '          type: "selfqa:comment-target",',
  "          url: window.location.href,",
  "          domPath: domPath(target),",
  "          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },",
  "        },",
  '        "*",',
  "      );",
  "    }",
  '    window.addEventListener("message", onMessage);',
  '    document.addEventListener("click", onClick, true);',
  "    return () => {",
  '      window.removeEventListener("message", onMessage);',
  '      document.removeEventListener("click", onClick, true);',
  "    };",
  "  }, []);",
  "  return null;",
  "}",
  "",
].join("\n");

const OVERLAY_PATH = "src/components/SelfQAOverlay.tsx";
const LAYOUT_PATH = "src/app/layout.tsx";

/** Inject the overlay component + render it from the root layout. */
export function instrument(app: GeneratedApp): GeneratedApp {
  const files = [...app.files];

  if (!files.some((f) => f.path === OVERLAY_PATH)) {
    files.push({ path: OVERLAY_PATH, content: OVERLAY_SOURCE });
  }

  const idx = files.findIndex((f) => f.path === LAYOUT_PATH);
  if (idx === -1) {
    console.warn(
      `[instrument] ${LAYOUT_PATH} not found; comment overlay added but not rendered`,
    );
    return { ...app, files };
  }

  let layout = files[idx].content;
  if (!layout.includes("SelfQAOverlay")) {
    layout = 'import SelfQAOverlay from "@/components/SelfQAOverlay";\n' + layout;
    if (layout.includes("</body>")) {
      layout = layout.replace("</body>", "<SelfQAOverlay /></body>");
    } else {
      console.warn(
        "[instrument] no </body> in layout; overlay imported but not rendered",
      );
    }
    files[idx] = { path: LAYOUT_PATH, content: layout };
  }

  return { ...app, files };
}
