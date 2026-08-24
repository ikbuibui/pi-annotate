/**
 * @author jackice
 * @date 2026-05-15
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { formatAnnotationFeedback, type Annotation } from "./feedback-format.js";
import { startAnnotationServer } from "./server.js";
import { truncateToWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import { getAnnotationCandidates, getInitialAnnotationCandidateIndex, type AnnotationCandidate } from "./message-tree.js";
import { CHANGE_ENTRY_TYPE, findStoredTurnChanges } from "./diff/session.js";
import { TurnChangeTracker } from "./diff/tracker.js";
import type { TurnFileChange } from "./diff/types.js";
import { loadAnnotationThemes } from "./theme.js";

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

function getLastAssistantMessage(ctx: ExtensionContext): { id: string; text: string } | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && "message" in entry) {
      const msg = entry.message;
      if (msg.role === "assistant") {
        const parts = msg.content.filter((c) => c.type === "text");
        const text = parts.map((c) => c.text).join("").trim();
        if (text) return { id: entry.id, text };
      }
    }
  }
  return null;
}

function turnChangesFor(ctx: ExtensionContext, assistantEntryId: string): TurnFileChange[] {
  return findStoredTurnChanges(ctx.sessionManager.getBranch(), assistantEntryId)?.changes ?? [];
}

interface TreeTheme {
  fg(color: "accent" | "success" | "muted" | "dim" | "warning" | "border", text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

class AnnotationTreeSelector {
  private selectedIndex: number;
  private search = "";

  constructor(
    private readonly candidates: AnnotationCandidate[],
    private readonly theme: TreeTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly maxVisible: number,
    private readonly onSelect: (candidate: AnnotationCandidate) => void,
    private readonly onCancel: () => void,
  ) {
    this.selectedIndex = getInitialAnnotationCandidateIndex(candidates);
  }

  private filtered(): AnnotationCandidate[] {
    const terms = this.search.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length
      ? this.candidates.filter((candidate) => {
        const text = `${candidate.role} ${candidate.label ?? ""} ${candidate.text}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      : this.candidates;
  }

  private move(amount: number): void {
    const candidates = this.filtered();
    this.selectedIndex = Math.max(0, Math.min(candidates.length - 1, this.selectedIndex + amount));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const candidates = this.filtered();
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), candidates.length - this.maxVisible));
    const end = Math.min(start + this.maxVisible, candidates.length);
    const border = this.theme.fg("border", "─".repeat(width));
    const lines = [
      border,
      truncateToWidth(this.theme.fg("accent", this.theme.bold("  Annotation Tree")), width),
      truncateToWidth(this.theme.fg("muted", `  Type to search${this.search ? `: ${this.search}` : ""}`), width),
      border,
    ];

    if (!candidates.length) {
      lines.push(truncateToWidth(this.theme.fg("muted", "  No messages found"), width));
    }

    for (let index = start; index < end; index++) {
      const candidate = candidates[index];
      const selected = index === this.selectedIndex;
      const role = this.theme.fg(candidate.role === "user" ? "accent" : "success", `${candidate.role}: `);
      const active = candidate.active ? this.theme.fg("accent", "• ") : "  ";
      const label = candidate.label ? this.theme.fg("warning", `[${candidate.label}] `) : "";
      let line = `${selected ? this.theme.fg("accent", "› ") : "  "}${this.theme.fg("dim", candidate.prefix)}${active}${label}${role}${candidate.preview}`;
      if (selected) line = this.theme.bg("selectedBg", this.theme.bold(line));
      lines.push(truncateToWidth(line, width));
    }

    lines.push(border);
    lines.push(truncateToWidth(this.theme.fg("muted", `  (${candidates.length ? this.selectedIndex + 1 : 0}/${candidates.length})  ↑↓ move · ←→ page · enter annotate · esc cancel`), width));
    lines.push(border);
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.move(-1);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.move(1);
    } else if (this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.editor.cursorLeft")) {
      this.move(-this.maxVisible);
    } else if (this.keybindings.matches(data, "tui.select.pageDown") || this.keybindings.matches(data, "tui.editor.cursorRight")) {
      this.move(this.maxVisible);
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const candidate = this.filtered()[this.selectedIndex];
      if (candidate) this.onSelect(candidate);
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search) {
        this.search = "";
        this.selectedIndex = getInitialAnnotationCandidateIndex(this.candidates);
      } else {
        this.onCancel();
      }
    } else if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") && this.search) {
      this.search = this.search.slice(0, -1);
      this.selectedIndex = 0;
    } else if (![...data].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      this.search += data;
      this.selectedIndex = 0;
    }
  }
}

// ── Shared annotation flow ─────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

async function readAnnotateHtml(): Promise<string> {
  return readFileSync(resolve(__dirname, "form", "annotate.html"), "utf-8");
}

function readAnnotateAssets() {
  const form = (name: string) => readFileSync(resolve(__dirname, "form", name), "utf-8");
  return {
    "/assets/diff2html-ui.js": { content: readFileSync(require.resolve("diff2html/bundles/js/diff2html-ui-slim.min.js"), "utf-8"), contentType: "text/javascript; charset=utf-8" },
    "/assets/diff-viewer.js": { content: form("diff-viewer.js"), contentType: "text/javascript; charset=utf-8" },
    "/assets/diff-viewer.css": { content: form("diff-viewer.css"), contentType: "text/css; charset=utf-8" },
    "/assets/diff2html.css": { content: form("diff2html.css"), contentType: "text/css; charset=utf-8" },
  };
}

async function openAnnotationServer(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: {
    markdown: string;
    mode: "annotate" | "annotate-last";
    sourceInfo: string;
    notificationTarget?: string;
    changes?: TurnFileChange[];
  },
): Promise<void> {
  const htmlContent = await readAnnotateHtml();
  const assets = readAnnotateAssets();

  const server = await startAnnotationServer({
    markdown: options.markdown,
    htmlContent,
    mode: options.mode,
    sourceInfo: options.sourceInfo,
    gate: false,
    changes: options.changes,
    themes: loadAnnotationThemes(),
    assets,
  });

  // Open the annotation UI in the system browser.
  try {
    await openUrl(pi, server.url);
    ctx.ui.notify(
      [
        `Annotation review opened for: ${options.notificationTarget ?? options.sourceInfo}`,
        "Terminal input is paused until the review is completed.",
        "Send feedback, approve, or close the tab to continue.",
      ].join("\n"),
      "info",
    );
    const decision = await server.waitForDecision();
    handleAnnotationDecision(pi, ctx, decision, options.sourceInfo, options.markdown);
  } catch (err) {
    ctx.ui.notify(`Failed to open annotation: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    server.stop();
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
  const turnChanges = new TurnChangeTracker();

  pi.on("before_agent_start", () => turnChanges.reset());

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    const absolutePath = resolve(ctx.cwd, input.path.replace(/^@/, ""));
    let before = "";
    try {
      before = readFileSync(absolutePath, "utf-8");
    } catch {
      // A write may create a new file.
    }
    turnChanges.capture(event.toolCallId, absolutePath, relative(ctx.cwd, absolutePath) || input.path, before);
  });

  pi.on("tool_result", (event) => {
    if (!event.isError) turnChanges.markSucceeded(event.toolCallId);
  });

  pi.on("agent_settled", (_event, ctx) => {
    const assistant = getLastAssistantMessage(ctx);
    try {
      if (!assistant) return;
      const changes = turnChanges.finalize((absolutePath) => {
        try {
          return readFileSync(absolutePath, "utf-8");
        } catch {
          return null;
        }
      });
      if (changes.length) pi.appendEntry(CHANGE_ENTRY_TYPE, { assistantEntryId: assistant.id, changes });
    } finally {
      turnChanges.reset();
    }
  });

  // ── Command: /annotate-last ──────────────────────────────────────────

  pi.registerCommand("annotate-last", {
    description: "Annotate the last assistant message in the current session",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const assistant = getLastAssistantMessage(ctx);
      if (!assistant) {
        ctx.ui.notify("No assistant message found", "error");
        return;
      }

      return openAnnotationServer(pi, ctx, {
        markdown: assistant.text,
        changes: turnChangesFor(ctx, assistant.id),
        mode: "annotate-last",
        sourceInfo: "last assistant message",
        notificationTarget: "last assistant message",
      });
    },
  });

  // ── Command: /annotate <file> ────────────────────────────────────────

  pi.registerCommand("annotate", {
    description: "Annotate a session message or markdown document",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const filePath = args.trim().replace(/^@/, "");

        if (!filePath) {
          const candidates = getAnnotationCandidates(
            ctx.sessionManager.getTree(),
            ctx.sessionManager.getLeafId(),
          );
          if (!candidates.length) {
            ctx.ui.notify("No messages found", "error");
            return;
          }

          let selected: AnnotationCandidate | null | undefined;
          if (ctx.mode === "tui") {
            selected = await ctx.ui.custom<AnnotationCandidate | null>((tui, theme, keybindings, done) => {
              const selector = new AnnotationTreeSelector(
                candidates,
                theme,
                keybindings,
                Math.max(5, Math.floor(tui.terminal.rows / 2)),
                done,
                () => done(null),
              );
              return {
                render: (width) => selector.render(width),
                invalidate: () => selector.invalidate(),
                handleInput: (data) => {
                  selector.handleInput(data);
                  tui.requestRender();
                },
              };
            });
          } else {
            const options = candidates.map((candidate) => `${candidate.prefix}${candidate.role}: ${candidate.preview} [${candidate.id}]`);
            const choice = await ctx.ui.select("Select a message to annotate", options);
            selected = candidates[options.indexOf(choice ?? "")];
          }
          if (!selected) return;

          const preview = selected.preview.length > 80 ? `${selected.preview.slice(0, 80)}…` : selected.preview;
          return openAnnotationServer(pi, ctx, {
            markdown: selected.text,
            changes: selected.role === "assistant" ? turnChangesFor(ctx, selected.id) : [],
            mode: "annotate",
            sourceInfo: `${selected.role} message ${selected.id}`,
            notificationTarget: `${selected.role} message: “${preview}”`,
          });
        }

        const absolutePath = resolve(ctx.cwd, filePath);

        if (!existsSync(absolutePath)) {
          ctx.ui.notify(`File not found: ${absolutePath}`, "error");
          return;
        }

        const content = readFileSync(absolutePath, "utf-8");

        return openAnnotationServer(pi, ctx, {
          markdown: content,
          mode: "annotate",
          sourceInfo: filePath,
          notificationTarget: `file: ${filePath}`,
        });
      } catch (err) {
        ctx.ui.notify(`Annotation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

}
