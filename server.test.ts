import assert from "node:assert/strict";
import test from "node:test";
import { formatAnnotationFeedback, renderMarkdown } from "./server.ts";

test("renders Markdown with annotation source offsets", () => {
  const html = renderMarkdown("Before\n# Heading\n\n- parent\n  - child\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~~js\nalert(1)\n~~~\n\n<script>x</script>");

  assert.match(html, /<h1 class="md-block" data-offset-start="7" data-offset-end="17">Heading<\/h1>/);
  assert.match(html, /<li class="md-block"[^>]*>parent\s*<ul>/);
  assert.match(html, /<table class="md-block"/);
  assert.match(html, /<div class="md-block"[^>]*><pre><code class="language-js">/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(renderMarkdown("```js\nconst answer = 42;\n```"), /<span class="hljs-keyword">const<\/span>/);
});

test("formats selected and overall annotation feedback", () => {
  const selection = formatAnnotationFeedback([{
    id: "selection", type: "suggestion", scope: "selection", text: "Add an example", originalText: "Details", range: { startOffset: 0, endOffset: 7, textPreview: "Details" }, createdAt: 0,
  }], "response");
  const overall = formatAnnotationFeedback([{
    id: "overall", type: "issue", scope: "overall", text: "Missing summary", originalText: "", range: null, createdAt: 0,
  }], "response");

  assert.match(selection, /> Original text: "Details"/);
  assert.match(selection, /Please revise according to the suggestions above\./);
  assert.match(overall, /> Applies to: Overall response/);
  assert.match(overall, /Please address the issues above\./);
});
