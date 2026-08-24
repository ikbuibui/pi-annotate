/**
 * @author jackice
 * @date 2026-05-15
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { formatFeedback, type Annotation, type AnnotationDocument, type AnnotationSource, type FeedbackFormatter } from "./feedback-format.js";
import { startAnnotationServer } from "./server.js";
import { CombinedAutocompleteProvider, Editor, truncateToWidth, type EditorTheme, type KeybindingsManager } from "@earendil-works/pi-tui";
import { getAnnotationCandidates, getInitialAnnotationCandidateIndex, type AnnotationCandidate } from "./message-tree.js";
import { CHANGE_ENTRY_TYPE, findStoredTurnChanges } from "./diff/session.js";
import { TurnChangeTracker } from "./diff/tracker.js";
import type { TurnFileChange } from "./diff/types.js";
import { loadAnnotationThemes } from "./theme.js";
import { ReviewGate, handleReviewTerminalInput } from "./review-gate.js";

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

function messageDocument(candidate: AnnotationCandidate): AnnotationDocument {
  return {
    id: `message:${candidate.id}`,
    kind: "message",
    title: `${candidate.role} message ${candidate.id}`,
    sourceInfo: `${candidate.role} message ${candidate.id}`,
    markdown: candidate.text,
  };
}

interface TreeTheme {
  fg(color: "accent" | "success" | "muted" | "dim" | "warning" | "border", text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

export interface AnnotationTreeSelection {
  candidates: AnnotationCandidate[];
  addFiles: boolean;
}

export class AnnotationTreeSelector {
  private focusedId: string;
  private markedIds = new Set<string>();
  private search = "";
  private searchMode = false;

  constructor(
    private readonly candidates: AnnotationCandidate[],
    private readonly theme: TreeTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly maxVisible: number,
    private readonly onSelect: (selection: AnnotationTreeSelection) => void,
    private readonly onCancel: () => void,
  ) {
    this.focusedId = candidates[getInitialAnnotationCandidateIndex(candidates)]?.id ?? "";
  }

  private filtered(): AnnotationCandidate[] {
    const terms = this.search.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length ? this.candidates.filter((candidate) => {
      const text = `${candidate.role} ${candidate.label ?? ""} ${candidate.text}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    }) : this.candidates;
  }

  private focusedIndex(candidates = this.filtered()): number {
    const index = candidates.findIndex((candidate) => candidate.id === this.focusedId);
    return index < 0 ? 0 : index;
  }

  private move(amount: number): void {
    const candidates = this.filtered();
    const candidate = candidates[Math.max(0, Math.min(candidates.length - 1, this.focusedIndex(candidates) + amount))];
    if (candidate) this.focusedId = candidate.id;
  }

  private toggleMark(): void {
    if (!this.focusedId) return;
    if (this.markedIds.has(this.focusedId)) this.markedIds.delete(this.focusedId);
    else this.markedIds.add(this.focusedId);
  }

  private refocusFiltered(): void {
    const candidates = this.filtered();
    if (!candidates.some((candidate) => candidate.id === this.focusedId)) this.focusedId = candidates[0]?.id ?? "";
  }

  private selectedCandidates(): AnnotationCandidate[] {
    return this.markedIds.size
      ? this.candidates.filter((candidate) => this.markedIds.has(candidate.id))
      : this.filtered().filter((candidate) => candidate.id === this.focusedId);
  }

  private select(addFiles = false): void {
    const candidates = addFiles && !this.markedIds.size ? [] : this.selectedCandidates();
    if (candidates.length || addFiles) this.onSelect({ candidates, addFiles });
  }

  invalidate(): void {}

  render(width: number): string[] {
    const candidates = this.filtered();
    const focusedIndex = this.focusedIndex(candidates);
    const start = Math.max(0, Math.min(focusedIndex - Math.floor(this.maxVisible / 2), candidates.length - this.maxVisible));
    const end = Math.min(start + this.maxVisible, candidates.length);
    const border = this.theme.fg("border", "─".repeat(width));
    const lines = [border, truncateToWidth(this.theme.fg("accent", this.theme.bold("  Annotation Tree")), width),
      truncateToWidth(this.theme.fg("muted", this.searchMode ? `  Search: ${this.search}` : "  / search · space mark · f add files"), width), border];
    if (!candidates.length) lines.push(truncateToWidth(this.theme.fg("muted", "  No messages found"), width));
    for (let index = start; index < end; index++) {
      const candidate = candidates[index];
      const focused = candidate.id === this.focusedId;
      const role = this.theme.fg(candidate.role === "user" ? "accent" : "success", `${candidate.role}: `);
      const active = candidate.active ? this.theme.fg("accent", "• ") : "  ";
      const label = candidate.label ? this.theme.fg("warning", `[${candidate.label}] `) : "";
      let line = `${focused ? this.theme.fg("accent", "› ") : "  "}${this.markedIds.has(candidate.id) ? this.theme.fg("success", "[✓] ") : "[ ] "}${this.theme.fg("dim", candidate.prefix)}${active}${label}${role}${candidate.preview}`;
      if (focused) line = this.theme.bg("selectedBg", this.theme.bold(line));
      lines.push(truncateToWidth(line, width));
    }
    lines.push(border);
    lines.push(truncateToWidth(this.theme.fg("muted", `  (${candidates.length ? focusedIndex + 1 : 0}/${candidates.length})  ↑↓ move · space mark · f add files · enter Open review · esc cancel`), width));
    lines.push(border);
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) this.move(-1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.move(1);
    else if (this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.editor.cursorLeft")) this.move(-this.maxVisible);
    else if (this.keybindings.matches(data, "tui.select.pageDown") || this.keybindings.matches(data, "tui.editor.cursorRight")) this.move(this.maxVisible);
    else if (this.keybindings.matches(data, "tui.select.confirm")) this.select();
    else if (data.toLowerCase() === "f" && !this.searchMode) this.select(true);
    else if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.searchMode) { this.search = ""; this.searchMode = false; this.refocusFiltered(); }
      else this.onCancel();
    } else if (data === "/" && !this.searchMode) this.searchMode = true;
    else if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") && this.searchMode) {
      this.search = this.search.slice(0, -1);
      this.refocusFiltered();
    } else if (data === " " && !this.searchMode) this.toggleMark();
    else if (this.searchMode && ![...data].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      this.search += data;
      this.refocusFiltered();
    }
  }
}

export function parseAnnotationPaths(args: string): string[] {
  const paths: string[] = [];
  let token = "";
  let quote = "";
  let escaped = false;
  const push = () => { if (token) paths.push(token.replace(/^@/, "")); token = ""; };
  for (const char of args.trim()) {
    if (escaped) { token += char; escaped = false; }
    else if (char === "\\") escaped = true;
    else if (quote) { if (char === quote) quote = ""; else token += char; }
    else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) push();
    else token += char;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("Unterminated quoted path");
  push();
  return paths;
}

export function readAnnotationDocuments(cwd: string, args: string): AnnotationDocument[] {
  const seen = new Set<string>();
  return parseAnnotationPaths(args).flatMap((path) => {
    const absolutePath = resolve(cwd, path);
    if (seen.has(absolutePath)) return [];
    seen.add(absolutePath);
    let markdown: string;
    try {
      markdown = readFileSync(absolutePath, "utf-8");
    } catch (err) {
      throw new Error(`Cannot read ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [{ id: `file:${absolutePath}`, kind: "file", title: path, sourceInfo: path, markdown }];
  });
}

async function promptAnnotationFiles(ctx: ExtensionCommandContext): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    const editor = new Editor(tui, editorTheme);
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], ctx.cwd));
    editor.onSubmit = (value) => done(value.trim() || null);
    return {
      get focused() { return editor.focused; },
      set focused(value: boolean) { editor.focused = value; },
      render: (width: number) => [
        truncateToWidth(theme.fg("accent", theme.bold("  Add files")), width),
        truncateToWidth(theme.fg("muted", "  Enter paths (quotes supported; Tab completes)"), width),
        ...editor.render(width),
      ],
      invalidate: () => editor.invalidate(),
      handleInput: (data: string) => {
        if (keybindings.matches(data, "tui.select.cancel") && !editor.isShowingAutocomplete()) done(null);
        else editor.handleInput(data);
        tui.requestRender();
      },
    };
  });
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
    documents: AnnotationDocument[];
    mode: "annotate" | "annotate-last";
    notificationTarget?: string;
  },
  reviewGate: ReviewGate,
): Promise<void> {
  const htmlContent = await readAnnotateHtml();
  const assets = readAnnotateAssets();

  const server = await startAnnotationServer({
    documents: options.documents,
    htmlContent,
    mode: options.mode,
    gate: false,
    themes: loadAnnotationThemes(),
    assets,
  });

  // Open the annotation UI in the system browser.
  reviewGate.start();
  const unsubscribe = ctx.mode === "tui"
    ? ctx.ui.onTerminalInput((data) => handleReviewTerminalInput(reviewGate, data, () => {
      ctx.ui.notify("Finish or close the annotation review before sending another prompt.", "warning");
    }))
    : () => {};
  try {
    await openUrl(pi, server.url);
    ctx.ui.notify(
      [
        `Annotation review opened for: ${options.notificationTarget ?? options.documents.map((document) => document.title).join(", ")}`,
        "Terminal submission is disabled until review completes.",
        "Send feedback, approve, or close the tab to continue.",
      ].join("\n"),
      "info",
    );
    const decision = await server.waitForDecision();
    handleAnnotationDecision(pi, ctx, decision, options.documents.map(({ id, title, sourceInfo }) => ({ id, title, sourceInfo })));
  } catch (err) {
    ctx.ui.notify(`Failed to open annotation: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    server.stop();
    unsubscribe();
    reviewGate.finish();
  }
}

export function handleAnnotationDecision(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  decision: { action: "feedback" | "approve" | "exit"; feedback?: string; annotations?: Annotation[] },
  sources: AnnotationSource[],
  formatter: FeedbackFormatter = formatFeedback,
): void {
  const sourceInfo = sources.map((source) => source.sourceInfo).join(", ");
  switch (decision.action) {
    case "feedback": {
      let feedbackText = decision.feedback;
      // Format structured annotations when no feedback text was provided
      if (!feedbackText && decision.annotations && decision.annotations.length > 0) {
        feedbackText = formatter(decision.annotations, sources);
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
  const reviewGate = new ReviewGate();

  pi.on("input", (event, ctx) => {
    const result = reviewGate.handleInput(event);
    if (result.action === "handled") {
      ctx.ui.notify("Finish or close the annotation review before sending another prompt.", "warning");
    }
    return result;
  });

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
        documents: [{
          id: `message:${assistant.id}`,
          kind: "message",
          title: "Last assistant message",
          sourceInfo: "last assistant message",
          markdown: assistant.text,
          changes: turnChangesFor(ctx, assistant.id),
        }],
        mode: "annotate-last",
        notificationTarget: "last assistant message",
      }, reviewGate);
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

          let selection: AnnotationTreeSelection | null | undefined;
          if (ctx.mode === "tui") {
            selection = await ctx.ui.custom<AnnotationTreeSelection | null>((tui, theme, keybindings, done) => {
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
            const candidate = candidates[options.indexOf(choice ?? "")];
            selection = candidate ? { candidates: [candidate], addFiles: false } : null;
          }
          if (!selection || (!selection.candidates.length && !selection.addFiles)) return;

          const documents = selection.candidates.map((candidate) => ({
            ...messageDocument(candidate),
            changes: candidate.role === "assistant" ? turnChangesFor(ctx, candidate.id) : [],
          }));
          if (selection.addFiles) {
            for (;;) {
              const paths = await promptAnnotationFiles(ctx);
              if (paths === null) return;
              try {
                documents.push(...readAnnotationDocuments(ctx.cwd, paths));
                break;
              } catch (err) {
                ctx.ui.notify(`Cannot add files: ${err instanceof Error ? err.message : String(err)}`, "error");
              }
            }
          }
          if (!documents.length) return;
          const preview = selection.candidates[0]?.preview;
          return openAnnotationServer(pi, ctx, {
            documents,
            mode: "annotate",
            notificationTarget: preview
              ? `${documents.length} source${documents.length === 1 ? "" : "s"}: “${preview.length > 80 ? `${preview.slice(0, 80)}…` : preview}”`
              : `file${documents.length === 1 ? "" : "s"}: ${documents.map((document) => document.title).join(", ")}`,
          }, reviewGate);
        }

        const documents = readAnnotationDocuments(ctx.cwd, args);
        if (!documents.length) throw new Error("No file paths provided");
        return openAnnotationServer(pi, ctx, {
          documents,
          mode: "annotate",
          notificationTarget: `file${documents.length === 1 ? "" : "s"}: ${documents.map((document) => document.title).join(", ")}`,
        }, reviewGate);
      } catch (err) {
        ctx.ui.notify(`Annotation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

}
