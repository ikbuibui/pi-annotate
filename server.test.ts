import assert from "node:assert/strict";
import test from "node:test";
import { formatAnnotationFeedback } from "./feedback-format.ts";
import { getAnnotationCandidates, getInitialAnnotationCandidateIndex } from "./message-tree.ts";
import { renderMarkdown } from "./server.ts";

test("renders Markdown with annotation source offsets", () => {
  const html = renderMarkdown("Before\n# Heading\n\n- parent\n  - child\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~~js\nalert(1)\n~~~\n\n<script>x</script>");

  assert.match(html, /<h1 class="md-block" data-offset-start="7" data-offset-end="17">Heading<\/h1>/);
  assert.match(html, /<li class="md-block"[^>]*>parent\s*<ul>/);
  assert.match(html, /<table class="md-block"/);
  assert.match(html, /<div class="md-block"[^>]*><pre><code class="language-js">/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(renderMarkdown("```js\nconst answer = 42;\n```"), /<span class="hljs-keyword">const<\/span>/);
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
  assert.match(overall, /> Applies to: Overall response/);
  assert.match(overall, /Please address the issues above\./);
});
