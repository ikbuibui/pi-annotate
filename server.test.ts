import assert from "node:assert/strict";
import test from "node:test";
import { formatAnnotationFeedback } from "./feedback-format.ts";
import { getAnnotationCandidates } from "./message-tree.ts";
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

test("lists user and assistant messages in tree order", () => {
  const candidates = getAnnotationCandidates([{ entry: {
    id: "root", type: "message", message: { role: "user", content: "First\nprompt" },
  }, children: [{ entry: {
    id: "answer", type: "message", message: { role: "assistant", content: [{ type: "text", text: "First answer" }] },
  }, children: [
    { entry: { id: "main", type: "message", message: { role: "user", content: "Main branch" } }, children: [] },
    { entry: { id: "other", type: "message", message: { role: "user", content: "Alternate branch" } }, children: [] },
  ] }] }]);

  assert.deepEqual(candidates.map(({ id, label }) => ({ id, label })), [
    { id: "root", label: "└─ user [root]: First prompt" },
    { id: "answer", label: "   └─ assistant [answer]: First answer" },
    { id: "main", label: "      ├─ user [main]: Main branch" },
    { id: "other", label: "      └─ user [other]: Alternate branch" },
  ]);
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
