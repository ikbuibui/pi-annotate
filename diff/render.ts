import { createTwoFilesPatch } from "diff";
import { html as renderDiffHtml } from "diff2html";
import { gunzipSync } from "node:zlib";
import type { TurnFileChange } from "./types.js";

export function createTurnPatch(path: string, before: string, after: string, ignoreWhitespace = false): string {
  return createTwoFilesPatch(path, path, before, after, undefined, undefined, { ignoreWhitespace });
}

function snapshotContents(change: TurnFileChange): { original: string; modified: string } {
  return {
    original: gunzipSync(Buffer.from(change.snapshot.original, "base64")).toString("utf8"),
    modified: gunzipSync(Buffer.from(change.snapshot.modified, "base64")).toString("utf8"),
  };
}

export function renderTurnFileDiffHtml(change: TurnFileChange, style: "unified" | "side-by-side", ignoreWhitespace: boolean): string {
  const { original, modified } = snapshotContents(change);
  const patch = createTurnPatch(change.path, original, modified, ignoreWhitespace);
  return renderDiffHtml(patch, { drawFileList: false, outputFormat: style === "unified" ? "line-by-line" : "side-by-side" });
}

export function changedFilesMarkdown(changes: TurnFileChange[]): string {
  if (!changes.length) return "";
  return `\n\n# Files changed\n\n${changes.map((change) => {
    const { original, modified } = snapshotContents(change);
    const patch = createTurnPatch(change.path, original, modified);
    const fence = "`".repeat(Math.max(3, ...[...patch.matchAll(/`+/g)].map((match) => match[0].length + 1)));
    return `## ${change.path}\n\n${fence}diff\n${patch.trim()}\n${fence}`;
  }).join("\n\n")}`;
}
