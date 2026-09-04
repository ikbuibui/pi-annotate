# Feedback format options

## Detailed Markdown (default)

`formatFeedback` in `feedback-format.ts` produces the default Markdown follow-up:

```md
## Annotation Feedback

The following feedback was provided for docs/example.md:

- **suggestion**: Suggestion
  > Original text: "Communication uses a RESTful API"
  Add a concrete request/response example.

Please revise according to the suggestions above.
```

Each item includes the annotation type, reviewer text, and either an overall-response marker or the selected-text preview. The ending is `address` when any issue exists, otherwise `revise` when any suggestion exists, otherwise `consider`.

The model receives this one follow-up message in the existing pi session. It does **not** receive the full annotated document again. Selection offsets, timestamps, IDs, and text beyond the 80-character preview are currently omitted from the follow-up.

## Alternatives

| Format | Contents | Trade-off |
| --- | --- | --- |
| Compact Markdown | One line per annotation: type, quoted excerpt, request | Lowest token use; less readable for complex feedback. |
| Structured JSON or XML | Explicit source, IDs, ranges, types, excerpts, and requests | Easy for a model to parse consistently; noisier and less natural in a chat follow-up. |
| Bounded source excerpts | Current format plus a fixed-size excerpt around each selection | Gives local context; costs more tokens and needs careful truncation. |
| Whole document | Current feedback plus the complete annotated document | Most context; expensive and redundant when the file is readable. |
| Hybrid | Markdown requests plus stable IDs, ranges, and bounded excerpts | Best default for future file revisions; modestly larger payload. |

## Recommended next format

Use the hybrid format when evidence shows the current previews are insufficient: keep readable Markdown, add each annotation's stable ID and source range, include a bounded source excerpt, and state the requested action explicitly. Keep the document itself out of the message; the agent can read the named file when it needs wider context.

## Browser customization

The bottom toolbar's **Feedback** selector includes Detailed Markdown, Compact Markdown, and Action list. **Formats…** copies a built-in or edits the selected custom format. The dialog shows all available template blocks/placeholders, a per-format context setting, and an exact preview using current annotations (or sample annotations when the review is empty). Context is measured in complete lines before and after a selection, from 0–100; `0` keeps only the selected text.

Named templates and the active selection are stored in `~/.pi/agent/pi-annotate/preferences.json` or `$PI_CODING_AGENT_DIR/pi-annotate/preferences.json`. Templates must contain `{{#annotations}}…{{/annotations}}`. They can optionally nest annotation loops inside `{{#sources}}…{{/sources}}` and `{{#fullReview}}…{{/fullReview}}` blocks.

```text
## Review: {{annotationCount}} notes

{{#annotations}}
- **{{label}}** on {{target}}: {{text}}
  {{location}}
  {{context}}
{{/annotations}}
```

Inside an annotation loop, `{{context}}` contains the selection and configured surrounding lines. The global `{{contextLines}}` placeholder contains the configured number.

The server renders both previews and submitted messages, so the preview is the exact outgoing follow-up. Unknown placeholders, malformed blocks, duplicate names/IDs, context outside 0–100 lines, more than 20 custom formats, and templates over 20,000 characters are rejected.

## Code customization

`formatFeedback(annotations, sources, overrides)` keeps feedback formatting independent of annotation collection and delivery. Override only the callbacks you need:

```ts
import { formatFeedback } from "./feedback-format.js";

const feedback = formatFeedback(annotations, sources, {
  heading: "# Review notes",
  formatItem: ({ annotation, target }) => `[${annotation.type}] ${target}: ${annotation.text}`,
  formatEnding: () => "End of review.",
});
```

The item callback receives the complete annotation, its optional source, and its target label. The source-heading, full-review-heading, and ending callbacks are equally replaceable, so this function is suited to Markdown or compact text without changing the UI or delivery code.

To replace the entire output—for example, with JSON or XML—implement `FeedbackFormatter` directly and pass it to `handleAnnotationDecision`:

```ts
const jsonFormatter: FeedbackFormatter = (annotations, sources) =>
  JSON.stringify({ annotations, sources });
```

## Document auto-detection

`/annotate <file>` does not auto-detect files. It resolves the supplied path from pi's current working directory, verifies it exists, and opens that file.

Separate from the command, a `turn_end` hook scans assistant **text** for paths matching `docs/superpowers/(specs|plans)/*.md`. For the first matching path that exists relative to the current working directory, it opens the annotation UI.

This is not a filesystem watcher. It neither proves that a document was newly created or modified nor opens every matching file; it reacts only to paths mentioned in an assistant response and selects the first existing match.
