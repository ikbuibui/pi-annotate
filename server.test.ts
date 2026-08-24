import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { formatAnnotationFeedback } from "./feedback-format.js";
import { getAnnotationCandidates, getInitialAnnotationCandidateIndex } from "./message-tree.js";
import { renderMarkdown, startAnnotationServer } from "./server.js";
import { changedFilesMarkdown, createTurnPatch, renderTurnFileDiffHtml } from "./diff/render.js";
import { findStoredTurnChanges } from "./diff/session.js";
import { TurnChangeTracker } from "./diff/tracker.js";
import { loadAnnotationThemes, parseBrowserTheme } from "./theme.js";
import type { TurnFileChange } from "./diff/types.js";

function change(path: string, original: string, modified: string): TurnFileChange {
  return {
    path,
    snapshot: {
      encoding: "gzip+base64",
      original: gzipSync(original).toString("base64"),
      modified: gzipSync(modified).toString("base64"),
    },
  };
}

test("renders Markdown with annotation source offsets", () => {
  const html = renderMarkdown("Before\n# Heading\n\n- parent\n  - child\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~~js\nalert(1)\n~~~\n\n<script>x</script>");

  assert.match(html, /<h1 class="md-block" data-offset-start="7" data-offset-end="17">Heading<\/h1>/);
  assert.match(html, /<li class="md-block"[^>]*>parent\s*<ul>/);
  assert.match(html, /<table class="md-block"/);
  assert.match(html, /<div class="md-block"[^>]*><pre><code class="language-js">/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(renderMarkdown("```js\nconst answer = 42;\n```"), /<span class="hljs-keyword">const<\/span>/);
});

test("loads valid user theme palettes", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-annotate-themes-"));
  try {
    writeFileSync(join(directory, "nord.json"), JSON.stringify({
      name: "Nord",
      colors: { "bg-primary": "#2e3440", accent: "rgb(136, 192, 208)" },
    }));
    writeFileSync(join(directory, "invalid.json"), JSON.stringify({ name: "bad", colors: { unknown: "red" } }));

    assert.deepEqual(loadAnnotationThemes(directory), [{
      name: "Nord",
      colors: { "bg-primary": "#2e3440", accent: "rgb(136, 192, 208)" },
    }]);
    assert.equal(parseBrowserTheme('{"name":"dark","colors":{"accent":"#ffffff"}}'), null);
    assert.equal(parseBrowserTheme('{"name":"unsafe","colors":{"accent":"url(https://example.com)"}}'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waits for an explicit exit decision", async () => {
  const server = await startAnnotationServer({
    markdown: "",
    htmlContent: "__ANNOTATE_DATA__",
    mode: "annotate",
  });

  try {
    const response = await fetch(`${server.url}/api/exit`, { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    assert.deepEqual(await server.waitForDecision(), { action: "exit" });
  } finally {
    server.stop();
  }
});

test("builds an annotation tree from messages only", () => {
  const candidates = getAnnotationCandidates([{ entry: {
    id: "root", parentId: null, type: "message", message: { role: "user", content: "First\nprompt" },
  }, children: [{ entry: {
    id: "settings", parentId: "root", type: "custom",
  }, children: [{ entry: {
    id: "answer", parentId: "settings", type: "message", message: { role: "assistant", content: [{ type: "text", text: "First answer" }] },
  }, children: [
    { entry: { id: "main", parentId: "answer", type: "message", message: { role: "user", content: "Main branch" } }, label: "chosen", children: [
      { entry: { id: "leaf", parentId: "main", type: "message", message: { role: "toolResult", content: "ignored" } }, children: [] },
    ] },
    { entry: { id: "other", parentId: "answer", type: "message", message: { role: "user", content: "Alternate branch" } }, children: [] },
  ] }] }] }], "leaf");

  assert.deepEqual(candidates.map(({ id, prefix, active, label }) => ({ id, prefix, active, label })), [
    { id: "root", prefix: "", active: true, label: undefined },
    { id: "answer", prefix: "", active: true, label: undefined },
    { id: "main", prefix: "├─ ", active: true, label: "chosen" },
    { id: "other", prefix: "└─ ", active: false, label: undefined },
  ]);
  assert.equal(candidates[0].preview, "First prompt");
  assert.equal(getInitialAnnotationCandidateIndex(candidates), 2);
});

test("loads only snapshot-backed stored turn changes", () => {
  const snapshot = change("new.ts", "", "new\n").snapshot;
  const entries = [{
    id: "changes",
    type: "custom",
    customType: "pi-annotate-turn-changes",
    data: { assistantEntryId: "assistant", changes: [{ path: "new.ts", snapshot }] },
  }, {
    id: "legacy",
    type: "custom",
    customType: "pi-annotate-turn-changes",
    data: { assistantEntryId: "legacy", changes: [{ path: "old.ts", patch: "old patch" }] },
  }];
  assert.deepEqual(findStoredTurnChanges(entries, "assistant"), { assistantEntryId: "assistant", changes: [{ path: "new.ts", snapshot }] });
  assert.equal(findStoredTurnChanges(entries, "legacy"), null);
});

test("tracks one aggregate patch per changed file", () => {
  const tracker = new TurnChangeTracker();
  tracker.capture("edit", "/project/app.ts", "src/app.ts", "before\n");
  tracker.capture("write", "/project/app.ts", "src/app.ts", "intermediate\n");
  tracker.capture("create", "/project/new.ts", "src/new.ts", "");
  tracker.capture("failed", "/project/failed.ts", "src/failed.ts", "before\n");
  tracker.markSucceeded("edit");
  tracker.markSucceeded("write");
  tracker.markSucceeded("create");
  const changes = tracker.finalize((path) => ({
    "/project/app.ts": "after\n",
    "/project/new.ts": "new\n",
    "/project/failed.ts": "after\n",
  })[path] ?? null);

  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map(({ path }) => path), ["src/app.ts", "src/new.ts"]);
  assert.match(renderTurnFileDiffHtml(changes[0], "unified", false), /data-lang="ts"[\s\S]*before[\s\S]*after/);
  assert.match(renderTurnFileDiffHtml(changes[1], "unified", false), />new</);
  assert.doesNotMatch(createTurnPatch("space.ts", "value \n", "value\n", true), /@@/);
  assert.deepEqual(tracker.finalize(() => null), []);
});

test("renders snapshot contents, not legacy patch text", () => {
  const file = { ...change("new.ts", "", "new\n"), patch: "misleading patch" };
  assert.match(renderTurnFileDiffHtml(file, "unified", false), />new</);
  assert.doesNotMatch(renderTurnFileDiffHtml(file, "unified", false), /misleading patch/);
  assert.match(changedFilesMarkdown([change("new.ts", "", "```\n")]), /````diff/);
  assert.doesNotMatch(renderTurnFileDiffHtml(change("space.ts", "value \n", "value\n"), "unified", true), /@@/);
});

test("aligns side-by-side changed lines by content", () => {
  const html = renderTurnFileDiffHtml(change(
    "example.ts",
    "const alpha = oldValue;\nconst beta = oldValue;\n",
    "const leading = value;\nconst alpha = newValue;\nconst beta = newValue;\n",
  ), "side-by-side", false);
  const rows = (table: string) => [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((row) =>
    row[0].replace(/<[^>]+>|&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
  );
  const [left, right] = html.match(/<table[\s\S]*?<\/table>/g)!;

  assert.deepEqual(rows(left).slice(1), ["", "1 - const alpha = oldValue ;", "2 - const beta = oldValue ;"]);
  assert.deepEqual(rows(right).slice(1), ["1 + const leading = value;", "2 + const alpha = newValue ;", "3 + const beta = newValue ;"]);
});

test("serves independently rendered per-file diffs and assets", async () => {
  const changes = [change("one.ts", "one\n", "ONE\n"), change("two.ts", "two\n", "TWO\n")];
  const server = await startAnnotationServer({
    markdown: "", htmlContent: "", mode: "annotate", changes,
    assets: { "/assets/test.css": { content: "body{}", contentType: "text/css; charset=utf-8" } },
  });
  try {
    const unified = await (await fetch(`${server.url}/api/diffs?style=unified`)).json() as { changes: number; files: Array<{ path: string; html: string }> };
    const sideBySide = await (await fetch(`${server.url}/api/diffs?style=side-by-side`)).json() as { files: Array<{ path: string; html: string }> };
    assert.equal(unified.changes, 2);
    assert.deepEqual(unified.files.map((file) => file.path), ["one.ts", "two.ts"]);
    assert.ok(unified.files.every((file) => /d2h-file/.test(file.html)));
    assert.ok(sideBySide.files.every((file) => /d2h-diff-table/.test(file.html)));
    const asset = await fetch(`${server.url}/assets/test.css`);
    assert.equal(asset.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(await asset.text(), "body{}");
  } finally {
    server.stop();
  }
});

test("loads the Diff2Html UI highlighter before mounting diffs", () => {
  const page = readFileSync("form/annotate.html", "utf8");
  assert.match(page, /<script src="\/assets\/diff2html-ui\.js"><\/script>\s*<script src="\/assets\/diff-viewer\.js"><\/script>/);
  assert.match(page, /id="themeSelect"/);
  assert.match(page, /ANNOTATE_DATA\.themes/);
  assert.match(page, /<div class="panel-header"><span>Annotations<\/span><span class="annotation-badge" id="annBadge">/);
  assert.match(page, /<div class="toolbar-right">\s*<button class="btn-toolbar btn-overall-comment" id="btnOverallComment">Overall comment<\/button>\s*<button class="btn-toolbar btn-feedback"/);
  assert.match(page, /id="btnApprove">Approve without feedback<\/button>/);
  assert.match(page, /class="diff-style-toggle" role="group" aria-label="Diff layout"/);
  assert.match(page, /id="diffUnified" type="button" aria-pressed="true"/);
  const diffCss = readFileSync("form/diff-viewer.css", "utf8");
  const diffViewer = readFileSync("form/diff-viewer.js", "utf8");
  assert.match(diffCss, /\.d2h-code-side-emptyplaceholder, #diffViewer \.d2h-emptyplaceholder \{ background:var\(--bg-secondary\);/);
  assert.match(diffCss, /\.is-collapsed > \.d2h-file-diff/);
  assert.match(diffCss, /\.diff-style-toggle \{ display:inline-flex; \}/);
  assert.match(diffCss, /label \{ display:inline-flex; align-items:center; gap:5px;/);
  assert.match(diffCss, /\.d2h-tag\.d2h-changed-tag \{ background:var\(--bg-tertiary\); color:var\(--text-primary\); border-color:var\(--border\); \}/);
  assert.match(diffViewer, /setAttribute\('aria-pressed', String\(style === 'unified'\)\)/);
  assert.match(diffViewer, /className = 'diff-collapse-toggle'/);
  assert.match(diffViewer, /setCollapsed\(false\);/);
  assert.match(diffViewer, /aria-expanded/);
  assert.match(diffViewer, /new window\.Diff2HtmlUI\(viewer\)\.highlightCode\(\)/);
});

test("resolves multiline diff selections on one compatible side", () => {
  const context: { window: { AnnotationDiffViewer?: { resolveSelectionRows(rows: unknown[]): unknown } } } = { window: {} };
  vm.runInNewContext(readFileSync("form/diff-viewer.js", "utf8"), context);
  const resolve = context.window.AnnotationDiffViewer!.resolveSelectionRows;
  assert.deepEqual(JSON.parse(JSON.stringify(resolve([
    { path: "src/app.ts", originalLine: 7, currentLine: 8 },
    { path: "src/app.ts", originalLine: 8, currentLine: 9 },
    { path: "src/app.ts", currentLine: 12 },
  ]))), { path: "src/app.ts", side: "current", startLine: 8, endLine: 12 });
  assert.equal(resolve([
    { path: "src/app.ts", originalLine: 7 },
    { path: "src/app.ts", currentLine: 8 },
  ]), null);
  assert.equal(resolve([
    { path: "src/app.ts", currentLine: 8 },
    { path: "src/other.ts", currentLine: 9 },
  ]), null);
});

test("formats selected and overall annotation feedback", () => {
  const selection = formatAnnotationFeedback([{
    id: "selection", type: "suggestion", scope: "selection", text: "Add an example", originalText: "Details", range: { startOffset: 0, endOffset: 7, textPreview: "Details" }, createdAt: 0,
  }], "response");
  const overall = formatAnnotationFeedback([{
    id: "overall", type: "issue", scope: "overall", text: "Missing summary", originalText: "", range: null, createdAt: 0,
  }], "response");

  assert.equal(selection, `## Annotation Feedback

The following feedback was provided for response:

- **suggestion**: Suggestion
  > Original text: "Details"
  Add an example

Please revise according to the suggestions above.`);
  const diff = formatAnnotationFeedback([{
    id: "diff", type: "issue", scope: "selection", text: "Wrong value", originalText: "value", range: { startOffset: 0, endOffset: 5, textPreview: "value", diff: { path: "src/app.ts", side: "current", startLine: 8, endLine: 8 } }, createdAt: 0,
  }], "response");
  assert.match(diff, /> src\/app.ts:8 \(current\)/);
  const multiline = formatAnnotationFeedback([{ ...{
    id: "multiline", type: "issue" as const, scope: "selection" as const, text: "Wrong range", originalText: "values", createdAt: 0,
  }, range: { startOffset: 0, endOffset: 6, textPreview: "values", diff: { path: "src/app.ts", side: "current" as const, startLine: 8, endLine: 12 } } }], "response");
  assert.match(multiline, /> src\/app.ts:8-12 \(current\)/);
  assert.match(overall, /> Applies to: Overall response/);
  assert.match(overall, /Please address the issues above\./);
});
