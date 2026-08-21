/**
 * @author jackice
 * @date 2026-05-15
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { formatAnnotationFeedback, type Annotation } from "./feedback-format.js";
import { startAnnotationServer } from "./server.js";

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

  // Open the annotation UI in the system browser.
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

}
