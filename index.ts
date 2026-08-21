/**
 * @author jackice
 * @date 2026-05-15
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { formatAnnotationFeedback, startAnnotationServer, type Annotation } from "./server.js";

// ── Types ──────────────────────────────────────────────────────────────

interface GlimpseWindow {
  on(event: "closed", handler: () => void): void;
  close(): void;
}

// ── Glimpse Integration ────────────────────────────────────────────────

let glimpseOpen: ((html: string, opts: Record<string, unknown>) => GlimpseWindow) | null | undefined;

function findGlimpseMjs(): string | null {
  // Search upward from this module for node_modules/glimpseui/src/glimpse.mjs.
  // Avoid createRequire().resolve(): omp intercepts createRequire and only checks
  // registered modules, so filesystem package resolution fails.
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = resolve(dir, "node_modules", "glimpseui", "src", "glimpse.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Global npm directory (the installation method recommended in README)
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
    const entry = resolve(globalRoot, "glimpseui", "src", "glimpse.mjs");
    if (existsSync(entry)) return entry;
  } catch {
    // npm root -g failed
  }
  // Global Bun directory (used by bun add -g)
  try {
    const bunRoot = resolve(os.homedir(), ".bun", "install", "global", "node_modules");
    const entry = resolve(bunRoot, "glimpseui", "src", "glimpse.mjs");
    if (existsSync(entry)) return entry;
  } catch {
    // homedir failed
  }
  return null;
}

async function getGlimpseOpen(): Promise<typeof glimpseOpen> {
  if (glimpseOpen !== undefined) return glimpseOpen;
  const resolved = findGlimpseMjs();
  if (resolved) {
    try {
      // Import via file URL for compatibility with both pi and omp loaders
      glimpseOpen = (await import(pathToFileURL(resolved).href)).open;
      return glimpseOpen;
    } catch {
      // import failed
    }
  }
  glimpseOpen = null;
  return glimpseOpen;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openInGlimpse(
  open: (html: string, opts: Record<string, unknown>) => GlimpseWindow,
  url: string,
  title?: string,
): GlimpseWindow {
  const safeTitle = escapeHtml(title || "Annotation");
  const shellHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${safeTitle}</title></head>
<body style="margin:0; background:#1a1a2e;">
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
  return open(shellHTML, { width: 900, height: 750, title: title || "Annotation" });
}

async function openUrl(pi: ExtensionAPI, url: string): Promise<void> {
  const platform = os.platform();
  let result: { code: number; stderr?: string };
  if (platform === "darwin") {
    result = await pi.exec("open", [url]);
  } else if (platform === "win32") {
    result = await pi.exec("cmd", ["/c", "start", "", url]);
  } else {
    result = await pi.exec("xdg-open", [url]);
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function getLastAssistantMessageText(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && "message" in entry) {
      const msg = entry.message;
      if (msg.role === "assistant") {
        const parts = msg.content.filter((c) => c.type === "text");
        const text = parts.map((c) => c.text).join("").trim();
        if (text) return text;
      }
    }
  }
  return null;
}

// ── Shared annotation flow ─────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readAnnotateHtml(): Promise<string> {
  const htmlPath = resolve(__dirname, "form", "annotate.html");
  return readFileSync(htmlPath, "utf-8");
}

async function openAnnotationServer(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: {
    markdown: string;
    mode: "annotate" | "annotate-last";
    sourceInfo: string;
  },
): Promise<void> {
  const htmlContent = await readAnnotateHtml();

  const server = await startAnnotationServer({
    markdown: options.markdown,
    htmlContent,
    mode: options.mode,
    sourceInfo: options.sourceInfo,
    gate: false,
  });



  let glimpseWin: GlimpseWindow | null = null;

  // Prefer Glimpse on macOS, then fall back to the browser
  if (os.platform() === "darwin") {
    const glimpseOpenFn = await getGlimpseOpen();
    if (glimpseOpenFn) {
      try {
        glimpseWin = openInGlimpse(glimpseOpenFn, server.url, `Annotate: ${options.sourceInfo}`);
        ctx.ui.notify("Annotation window opened. Close it when done.", "info");

        // Resolve immediately when the Glimpse window closes instead of relying on HTTP
        let windowClosed = false;
        glimpseWin.on("closed", () => {
          windowClosed = true;
          server.resolveDecision({ action: "exit" });
        });

        // Wait for a decision
        const decision = await server.waitForDecision();

        // Silently handle exits caused by closing the window
        if (decision.action === "exit" && windowClosed) {
          server.stop();
          return;
        }

        handleAnnotationDecision(pi, ctx, decision, options.sourceInfo, options.markdown);
        server.stop();
        return;
      } catch (err) {
        ctx.ui.notify(`Glimpse failed; falling back to browser: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    }
  }

  // Browser fallback
  try {
    await openUrl(pi, server.url);
    const decision = await server.waitForDecision();
    handleAnnotationDecision(pi, ctx, decision, options.sourceInfo, options.markdown);
    server.stop();
  } catch (err) {
    ctx.ui.notify(`Failed to open annotation: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function handleAnnotationDecision(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  decision: { action: "feedback" | "approve" | "exit"; feedback?: string; annotations?: Annotation[] },
  sourceInfo: string,
  originalMarkdown: string,
): void {
  switch (decision.action) {
    case "feedback": {
      let feedbackText = decision.feedback;
      // Format structured annotations when no feedback text was provided
      if (!feedbackText && decision.annotations && decision.annotations.length > 0) {
        feedbackText = formatAnnotationFeedback(decision.annotations, sourceInfo);
      }
      // Fall back to a default feedback message
      if (!feedbackText) {
        feedbackText = `## Annotation Feedback\n\nThe following feedback was provided for ${sourceInfo}. Please revise according to the suggestions above.`;
      }
      pi.sendUserMessage(feedbackText, { deliverAs: "followUp" });
      break;
    }
    case "approve":
      ctx.ui.notify(`${sourceInfo} approved`, "success");
      break;
    case "exit":
      // Close silently
      break;
  }
}

// ── Extension Entry ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Command: /annotate-last ──────────────────────────────────────────

  pi.registerCommand("annotate-last", {
    description: "Annotate the last assistant message in the current session",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const text = getLastAssistantMessageText(ctx);
      if (!text) {
        ctx.ui.notify("No assistant message found", "error");
        return;
      }

      ctx.ui.notify("Opening annotation for the last assistant message...", "info");

      return openAnnotationServer(pi, ctx, {
        markdown: text,
        mode: "annotate-last",
        sourceInfo: "last assistant message",
      });
    },
  });

  // ── Command: /annotate <file> ────────────────────────────────────────

  pi.registerCommand("annotate", {
    description: "Annotate a markdown document",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const filePath = args.trim().replace(/^@/, "");


        if (!filePath) {
          ctx.ui.notify("Usage: /annotate <file.md>", "error");
          return;
        }

        const absolutePath = resolve(ctx.cwd, filePath);


        if (!existsSync(absolutePath)) {
          ctx.ui.notify(`File not found: ${absolutePath}`, "error");
          return;
        }

        ctx.ui.notify(`Opening annotation for ${filePath}...`, "info");

        const content = readFileSync(absolutePath, "utf-8");

        return openAnnotationServer(pi, ctx, {
          markdown: content,
          mode: "annotate",
          sourceInfo: filePath,
        });
      } catch (err) {
        ctx.ui.notify(`Annotation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ── Hook: turn_end auto-detection ───────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    // Only process assistant messages
    if (event.message.role !== "assistant") return;

    const parts = event.message.content.filter((c) => c.type === "text");
    const text = parts.map((c) => c.text).join("");
    if (!text) return;

    // Match file paths under docs/superpowers/
    const pattern = /docs\/superpowers\/(specs|plans)\/[^\s,.;:()!?]+\.md/g;
    const matches = text.match(pattern);
    if (!matches || matches.length === 0) return;

    let foundPath: string | null = null;
    for (const match of matches) {
      const absolutePath = resolve(ctx.cwd, match);
      if (existsSync(absolutePath)) {
        foundPath = absolutePath;
        break;
      }
    }

    if (!foundPath) return;

    ctx.ui.notify("New document detected; opening annotation...", "info");

    const content = readFileSync(foundPath, "utf-8");
    const htmlContent = await readAnnotateHtml();

    try {
      const server = await startAnnotationServer({
        markdown: content,
        htmlContent,
        mode: "annotate",
        sourceInfo: foundPath,
        gate: false,
      });

      // Prefer Glimpse on macOS
      if (os.platform() === "darwin") {
        const glimpseOpenFn = await getGlimpseOpen();
        if (glimpseOpenFn) {
          try {
            const glimpseWin = openInGlimpse(glimpseOpenFn, server.url, `Annotate: ${foundPath}`);
            let windowClosed = false;
            glimpseWin.on("closed", () => {
              windowClosed = true;
              server.resolveDecision({ action: "exit" });
            });
            const decision = await server.waitForDecision();
            if (decision.action === "exit" && windowClosed) {
              server.stop();
              return;
            }
            if (!(decision.action === "exit" && windowClosed)) {
              handleAnnotationDecision(pi, ctx, decision, foundPath, content);
            }
            server.stop();
            return;
          } catch {
            // Fall back to the browser
          }
        }
      }

      await openUrl(pi, server.url);
      const decision = await server.waitForDecision();
      handleAnnotationDecision(pi, ctx, decision, foundPath, content);
      server.stop();
    } catch (err) {
      console.error(`Automatic annotation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
