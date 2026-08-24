import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { formatFeedback, type FeedbackFormatter } from "./feedback-format.js";
import { AnnotationTreeSelector, handleAnnotationDecision, parseAnnotationPaths, readAnnotationDocuments, type AnnotationTreeSelection } from "./index.js";
import { getAnnotationCandidates, getInitialAnnotationCandidateIndex } from "./message-tree.js";
import { ReviewGate, handleReviewTerminalInput } from "./review-gate.js";
import { renderMarkdown, startAnnotationServer } from "./server.js";
import { changedFilesMarkdown, createTurnPatch, renderTurnFileDiffHtml } from "./diff/render.js";
import { findStoredTurnChanges } from "./diff/session.js";
import { TurnChangeTracker } from "./diff/tracker.js";
import { loadAnnotationThemes, parseBrowserTheme } from "./theme.js";
import type { TurnFileChange } from "./diff/types.js";

function document(id: string, markdown = "", changes: TurnFileChange[] = []) {
  return { id, kind: "file" as const, title: id, sourceInfo: id, markdown, changes };
}

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

test("blocks non-extension prompts only while review is open", () => {
  const gate = new ReviewGate();
  assert.deepEqual(gate.handleInput({ source: "interactive" }), { action: "continue" });

  gate.start();
  assert.deepEqual(gate.handleInput({ source: "interactive" }), { action: "handled" });
  assert.deepEqual(gate.handleInput({ source: "rpc" }), { action: "handled" });
  assert.deepEqual(gate.handleInput({ source: "extension" }), { action: "continue" });
  gate.finish();
  assert.deepEqual(gate.handleInput({ source: "interactive" }), { action: "continue" });
});

test("blocks only Return while review is open", () => {
  const gate = new ReviewGate();
  let notifications = 0;
  const handle = (data: string) => handleReviewTerminalInput(gate, data, () => { notifications++; });

  assert.equal(handle("\r"), undefined);
  gate.start();
  assert.equal(handle("x"), undefined);
  assert.deepEqual(handle("\r"), { consume: true });
  assert.equal(notifications, 1);
});

test("review decisions do not replay blocked prompts", () => {
  for (const [decision, expected] of [
    [{ action: "feedback" as const, feedback: "annotation feedback" }, ["annotation feedback"]],
    [{ action: "approve" as const }, []],
    [{ action: "exit" as const }, []],
  ] as const) {
    const sent: string[] = [];
    const pi = { sendUserMessage: (content: string) => sent.push(content) };
    const ctx = { ui: { notify: () => {} } };

    handleAnnotationDecision(pi as never, ctx as never, decision, [{ id: "response", title: "response", sourceInfo: "response" }]);
    assert.deepEqual(sent, expected);
  }
});

test("sends one grouped follow-up for a multi-document review", () => {
  const sent: string[] = [];
  const pi = { sendUserMessage: (content: string) => sent.push(content) };
  handleAnnotationDecision(pi as never, { ui: { notify: () => {} } } as never, {
    action: "feedback",
    annotations: [
      { id: "second", type: "issue", scope: "selection", documentId: "second", text: "Fix this", originalText: "bad", range: { startOffset: 0, endOffset: 3, textPreview: "bad" }, createdAt: 0 },
      { id: "first", type: "comment", scope: "overall", documentId: "first", text: "Looks good", originalText: "", range: null, createdAt: 0 },
    ],
  }, [{ id: "first", title: "First", sourceInfo: "first" }, { id: "second", title: "Second", sourceInfo: "second" }]);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].indexOf("### First") < sent[0].indexOf("### Second"));
});

test("renders Markdown with annotation source offsets", () => {
  const html = renderMarkdown("Before\n# Heading\n\n- parent\n  - child\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~~js\nalert(1)\n~~~\n\n<script>x</script>");

  assert.match(html, /<h1 class="md-block" data-offset-start="7" data-offset-end="17">Heading<\/h1>/);
  assert.match(html, /<li class="md-block"[^>]*>parent\s*<ul>/);
  assert.match(html, /<table class="md-block"/);
  assert.match(html, /<div class="md-block"[^>]*><pre><code class="language-js">/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(renderMarkdown("```js\nconst answer = 42;\n```"), /<span class="hljs-keyword">const<\/span>/);
});

test("highlights recognized code files while preserving Markdown files", async () => {
  const server = await startAnnotationServer({
    documents: [
      document("app.ts", "const answer = 42;"),
      document("CVec.hpp", "#include <vector>"),
      document("page.html", "<script>alert(1)</script>"),
      document("README.md", "# Heading"),
    ],
    htmlContent: "", mode: "annotate",
  });
  try {
    const { documents } = await (await fetch(`${server.url}/api/plan`)).json() as { documents: Array<{ id: string; html: string }> };
    assert.match(documents[0].html, /data-offset-start="0" data-offset-end="18"/);
    assert.match(documents[0].html, /class="hljs language-typescript"/);
    assert.match(documents[0].html, /hljs-keyword">const/);
    assert.match(documents[1].html, /class="hljs language-cpp"/);
    assert.match(documents[2].html, /&lt;<span class="hljs-name">script<\/span>&gt;/);
    assert.doesNotMatch(documents[2].html, /<script>/);
    assert.match(documents[3].html, /<h1 class="md-block"[^>]*>Heading<\/h1>/);
  } finally { server.stop(); }
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
    documents: [document("empty")],
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

test("serves ordered documents and document-scoped diffs", async () => {
  const server = await startAnnotationServer({
    documents: [document("first", "# First"), document("second", "# Second", [change("two.ts", "old\n", "new\n")])],
    htmlContent: "", mode: "annotate",
  });
  try {
    const plan = await (await fetch(`${server.url}/api/plan`)).json() as { documents: Array<{ id: string; html: string }> };
    assert.deepEqual(plan.documents.map((entry) => entry.id), ["first", "second"]);
    assert.equal("plan" in plan, false);
    assert.equal("html" in plan, false);
    assert.equal("sourceInfo" in plan, false);
    assert.match(plan.documents[1].html, /Second/);
    const diffs = await (await fetch(`${server.url}/api/diffs?documentId=second`)).json() as { files: Array<{ documentId: string; path: string }> };
    assert.deepEqual(diffs.files.map((file) => [file.documentId, file.path]), [["second", "two.ts"]]);
    assert.equal((await fetch(`${server.url}/api/diffs`)).status, 400);
    assert.equal((await fetch(`${server.url}/api/diffs?documentId=missing`)).status, 400);
  } finally { server.stop(); }
});

test("persists diff preferences across review servers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-annotate-"));
  const preferencePath = join(directory, "preferences.json");
  const options = { documents: [document("one")], htmlContent: "", mode: "annotate" as const, preferencePath };
  try {
    const first = await startAnnotationServer(options);
    try {
      assert.deepEqual(await (await fetch(`${first.url}/api/preferences`)).json(), { diffStyle: "side-by-side", ignoreWhitespace: true });
      assert.equal((await fetch(`${first.url}/api/preferences`, { method: "PUT", body: JSON.stringify({ diffStyle: "invalid" }) })).status, 400);
      assert.equal((await fetch(`${first.url}/api/preferences`, { method: "PUT", body: JSON.stringify({ ignoreWhitespace: "invalid" }) })).status, 400);
      assert.equal((await fetch(`${first.url}/api/preferences`, { method: "PUT", body: JSON.stringify({ diffStyle: "unified", ignoreWhitespace: false }) })).status, 200);
    } finally { first.stop(); }

    const second = await startAnnotationServer(options);
    try {
      assert.deepEqual(await (await fetch(`${second.url}/api/preferences`)).json(), { diffStyle: "unified", ignoreWhitespace: false });
    } finally { second.stop(); }

    writeFileSync(preferencePath, JSON.stringify({ diffStyle: "unified" }));
    const third = await startAnnotationServer(options);
    try {
      assert.deepEqual(await (await fetch(`${third.url}/api/preferences`)).json(), { diffStyle: "unified", ignoreWhitespace: true });
    } finally { third.stop(); }

    writeFileSync(preferencePath, "not json");
    const fourth = await startAnnotationServer(options);
    try {
      assert.deepEqual(await (await fetch(`${fourth.url}/api/preferences`)).json(), { diffStyle: "side-by-side", ignoreWhitespace: true });
    } finally { fourth.stop(); }
  } finally {
    rmSync(directory, { recursive: true, force: true });
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

  assert.equal(rows(left).length, rows(right).length);
  assert.deepEqual(rows(left).slice(1), ["", "1 - const alpha = oldValue ;", "2 - const beta = oldValue ;"]);
  assert.deepEqual(rows(right).slice(1), ["1 + const leading = value;", "2 + const alpha = newValue ;", "3 + const beta = newValue ;"]);
});

test("serves independently rendered per-file diffs and assets", async () => {
  const changes = [change("one.ts", "one\n", "ONE\n"), change("two.ts", "two\n", "TWO\n")];
  const server = await startAnnotationServer({
    documents: [document("one", "", changes)], htmlContent: "", mode: "annotate",
    assets: { "/assets/test.css": { content: "body{}", contentType: "text/css; charset=utf-8" } },
  });
  try {
    const defaultStyle = await (await fetch(`${server.url}/api/diffs?documentId=one`)).json() as { changes: number; files: Array<{ path: string; html: string }> };
    const unified = await (await fetch(`${server.url}/api/diffs?documentId=one&style=unified`)).json() as { files: Array<{ path: string; html: string }> };
    assert.equal(defaultStyle.changes, 2);
    assert.deepEqual(defaultStyle.files.map((file) => file.path), ["one.ts", "two.ts"]);
    assert.ok(defaultStyle.files.every((file) => /d2h-file-side-diff/.test(file.html)));
    assert.ok(unified.files.every((file) => /d2h-file-diff/.test(file.html)));
    assert.ok(unified.files.every((file) => !/d2h-file-side-diff/.test(file.html)));
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
  assert.match(page, /id="btnFullReviewComment">Full review comment<\/button>/);
  assert.match(page, /Overall comment for this section/);
  assert.match(page, /annotation-document/);
  assert.match(page, /startDocument !== endDocument/);
  assert.match(page, /documentId: range \? range\.documentId : documentId/);
  assert.match(page, /\.diff-viewer tr\[data-diff-path\]/);
  assert.match(page, /annotationSource\.kind === 'message'/);
  assert.match(page, /annotation-document--' \+ annotationSource\.kind/);
  assert.match(page, /\.annotation-document \{ margin-bottom: 32px; border: 1px solid var\(--border-light\);/);
  assert.match(page, /source-badge--' \+ annotationSource\.kind/);
  assert.match(page, /isMessage \? 'Message' : 'File'/);
  assert.match(page, /document-collapse-toggle/);
  assert.match(page, /id="sourceInfo" type="button" aria-expanded="false" aria-controls="sourceMenu"/);
  assert.match(page, /id="sourceMenu" aria-label="Review sources" hidden/);
  assert.match(page, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
  assert.match(page, /sourceNavigation\.contains\(event\.target\)/);
  assert.match(page, /event\.key === 'Escape' && !sourceMenu\.hidden/);
  assert.match(page, /singleDocument \? 'Overall comment' : 'Overall comment for this section'/);
  assert.match(page, /btnFullReviewComment.*singleDocument \? 'none'/);
  assert.match(page, /id="btnApprove">Approve without feedback<\/button>/);
  assert.match(page, /class="diff-style-toggle" role="group" aria-label="Diff layout"/);
  assert.match(page, /id="diffUnified" type="button" aria-pressed="false"/);
  assert.match(page, /id="diffSideBySide" type="button" aria-pressed="true"/);
  assert.match(page, /id="diffIgnoreWhitespace" type="checkbox" checked/);
  const diffCss = readFileSync("form/diff-viewer.css", "utf8");
  const diffViewer = readFileSync("form/diff-viewer.js", "utf8");
  assert.match(diffCss, /\.diff-viewer \.d2h-code-side-emptyplaceholder, \.diff-viewer \.d2h-emptyplaceholder/);
  assert.doesNotMatch(diffCss, /d2h-code-side-emptyplaceholder::after|d2h-files-diff :is|position:static|display:table-cell|padding:0 \.5em|d2h-code-line-ctn \{|--diff-row-height|min-height:var\(/);
  assert.match(diffCss, /\.d2h-diff-table tr \{ position:relative; \}/);
  assert.match(diffCss, /\.d2h-code-linenumber, \.diff-viewer \.d2h-code-side-linenumber \{ top:0; left:0; \}/);
  assert.match(diffCss, /\.is-collapsed > \.d2h-file-diff/);
  assert.match(diffCss, /\.diff-style-toggle \{ display:inline-flex; \}/);
  assert.match(diffCss, /label \{ display:inline-flex; align-items:center; gap:5px;/);
  assert.match(diffCss, /\.d2h-tag\.d2h-changed-tag \{ background:var\(--bg-tertiary\); color:var\(--text-primary\); border-color:var\(--border\); \}/);
  assert.match(diffCss, /\.d2h-code-side-line del, \.diff-viewer \.d2h-code-side-line ins \{ display:inline; margin:0;/);
  assert.match(diffViewer, /fetch\('\/api\/preferences'\)/);
  assert.match(diffViewer, /method: 'PUT'/);
  assert.doesNotMatch(diffViewer, /pi-annotate-(?:diff-style|ignore-whitespace)/);
  assert.match(diffViewer, /setAttribute\('aria-pressed', String\(style === 'unified'\)\)/);
  assert.match(diffViewer, /className = 'diff-collapse-toggle'/);
  assert.match(diffViewer, /setCollapsed\(collapsedFiles\.get\(key\) \?\? false\);/);
  assert.match(diffViewer, /aria-expanded/);
  assert.match(diffViewer, /new window\.Diff2HtmlUI\(viewer\)\.highlightCode\(\)/);
  assert.match(diffViewer, /const collapsedFiles = new Map\(\)/);
  assert.match(diffViewer, /setCollapsed\(collapsedFiles\.get\(key\) \?\? false\)/);
  assert.doesNotMatch(diffViewer, /alignSideBySideRows/);
});

test("resolves multiline diff selections on one compatible side", () => {
  const context: { window: { AnnotationDiffViewer?: { resolveSelectionRows(rows: unknown[]): unknown; collapseKey(documentId: string, path: string): string } } } = { window: {} };
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
  assert.notEqual(context.window.AnnotationDiffViewer!.collapseKey("first", "app.ts"), context.window.AnnotationDiffViewer!.collapseKey("second", "app.ts"));

});

test("formats annotations by document order and full review", () => {
  const sources = [{ id: "first", title: "First source", sourceInfo: "first" }, { id: "second", title: "Second source", sourceInfo: "second" }];
  const feedback = formatFeedback([
    { id: "second", type: "issue", scope: "selection", documentId: "second", text: "Wrong value", originalText: "value", range: { startOffset: 0, endOffset: 5, textPreview: "value", diff: { documentId: "second", path: "src/app.ts", side: "current", startLine: 8, endLine: 12 } }, createdAt: 0 },
    { id: "first", type: "suggestion", scope: "overall", documentId: "first", text: "Add an example", originalText: "", range: null, createdAt: 0 },
    { id: "full", type: "comment", scope: "overall", documentId: null, text: "Good direction", originalText: "", range: null, createdAt: 0 },
  ], sources);
  assert.ok(feedback.indexOf("### First source") < feedback.indexOf("### Second source"));
  assert.ok(feedback.indexOf("### Second source") < feedback.indexOf("### Full review"));
  assert.match(feedback, /> Applies to: Overall comment for First source/);
  assert.match(feedback, /> src\/app.ts:8-12 \(current\)/);
  assert.match(feedback, /> Applies to: Full review/);
  assert.match(feedback, /Please address the issues above\./);
});

test("allows feedback format customization without changing annotation delivery", () => {
  const formatter: FeedbackFormatter = (annotations, sources) => formatFeedback(annotations, sources, {
    heading: "# Review notes",
    formatItem: ({ annotation, target }) => `[${annotation.type}] ${target}: ${annotation.text}`,
    formatEnding: () => "End of review.",
  });
  const annotation = { id: "item", type: "comment" as const, scope: "overall" as const, documentId: "source", text: "Use a named constant", originalText: "", range: null, createdAt: 0 };
  const expected = "# Review notes\n\nThe following feedback was provided:\n\n### Source\n\n[comment] Overall comment for Source: Use a named constant\n\nEnd of review.";
  assert.equal(formatter([annotation], [{ id: "source", title: "Source", sourceInfo: "src/app.ts" }]), expected);

  const sent: string[] = [];
  handleAnnotationDecision({ sendUserMessage: (content: string) => sent.push(content) } as never, { ui: { notify: () => {} } } as never, { action: "feedback", annotations: [annotation] }, [{ id: "source", title: "Source", sourceInfo: "src/app.ts" }], formatter);
  assert.equal(sent[0], expected);

  const jsonFormatter: FeedbackFormatter = (annotations, sources) => JSON.stringify({ annotations, sources });
  handleAnnotationDecision({ sendUserMessage: (content: string) => sent.push(content) } as never, { ui: { notify: () => {} } } as never, { action: "feedback", annotations: [annotation] }, [{ id: "source", title: "Source", sourceInfo: "src/app.ts" }], jsonFormatter);
  assert.deepEqual(JSON.parse(sent[1]), { annotations: [annotation], sources: [{ id: "source", title: "Source", sourceInfo: "src/app.ts" }] });
});

test("reads all file arguments before producing ordered, deduplicated documents", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-annotate-files-"));
  try {
    writeFileSync(join(directory, "one.md"), "one");
    writeFileSync(join(directory, "two file.md"), "two");
    const documents = readAnnotationDocuments(directory, 'one.md "two file.md" one.md');
    assert.deepEqual(documents.map((entry) => [entry.title, entry.markdown]), [["one.md", "one"], ["two file.md", "two"]]);
    assert.throws(() => readAnnotationDocuments(directory, "one.md missing.md"), /Cannot read/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("tree marks survive filtering and open in tree order", () => {
  const candidates = [
    { id: "first", role: "user" as const, text: "first text", preview: "first", prefix: "", active: false },
    { id: "second", role: "assistant" as const, text: "second text", preview: "second", prefix: "", active: true },
  ];
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
  const keys = { matches: (data: string, binding: string) => ({ "tui.select.up": data === "up", "tui.select.down": data === "down", "tui.select.confirm": data === "enter", "tui.select.cancel": data === "esc", "tui.editor.deleteCharBackward": data === "backspace" }[binding] ?? false) };
  let opened: AnnotationTreeSelection | undefined;
  const selector = new AnnotationTreeSelector(candidates, theme, keys as never, 5, (selected) => { opened = selected; }, () => {});
  selector.handleInput(" "); // mark focused second
  selector.handleInput("up");
  selector.handleInput(" "); // mark first
  selector.handleInput("/");
  selector.handleInput("second");
  selector.handleInput("esc");
  selector.handleInput("enter");
  assert.deepEqual(opened, { candidates: [candidates[0], candidates[1]], addFiles: false });

  const searchSelector = new AnnotationTreeSelector(candidates, theme, keys as never, 5, (selected) => { opened = selected; }, () => {});
  searchSelector.handleInput("/");
  searchSelector.handleInput("first");
  searchSelector.handleInput("enter");
  assert.deepEqual(opened, { candidates: [candidates[0]], addFiles: false });

  const fileSelector = new AnnotationTreeSelector(candidates, theme, keys as never, 5, (selected) => { opened = selected; }, () => {});
  fileSelector.handleInput("f");
  assert.deepEqual(opened, { candidates: [candidates[1]], addFiles: true });
});

test("parses quoted annotation paths", () => {
  assert.deepEqual(parseAnnotationPaths('"docs/my plan.md" @README.md \'a b\' c\\ d'), ["docs/my plan.md", "README.md", "a b", "c d"]);
  assert.throws(() => parseAnnotationPaths('"unterminated'), /Unterminated/);
});

test("completes nested paths and quotes spaces", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-annotate-complete-"));
  try {
    mkdirSync(join(directory, "nested"));
    writeFileSync(join(directory, "first.md"), "");
    writeFileSync(join(directory, "nested", "my file.md"), "");
    const provider = new CombinedAutocompleteProvider([], directory);
    const completion = await provider.getSuggestions(
      ["first.md nested/my"], 0, 18, { signal: new AbortController().signal, force: true },
    );
    assert.deepEqual(completion, { items: [{ value: '"nested/my file.md"', label: "my file.md" }], prefix: "nested/my" });
    const applied = provider.applyCompletion(["first.md nested/my"], 0, 18, completion!.items[0], completion!.prefix);
    assert.deepEqual(applied.lines, ['first.md "nested/my file.md"']);
    assert.deepEqual(parseAnnotationPaths(applied.lines[0]), ["first.md", "nested/my file.md"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
