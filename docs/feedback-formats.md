# Feedback format options

## Current format (active)

`formatAnnotationFeedback` in `feedback-format.ts` is the single formatter used when the annotation UI sends feedback. It preserves the existing Markdown follow-up:

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

The formatter is already isolated behind `FeedbackFormatter`, so adding that second formatter can be a small, opt-in change without changing the UI or delivery path.

## Document auto-detection

`/annotate <file>` does not auto-detect files. It resolves the supplied path from pi's current working directory, verifies it exists, and opens that file.

Separate from the command, a `turn_end` hook scans assistant **text** for paths matching `docs/superpowers/(specs|plans)/*.md`. For the first matching path that exists relative to the current working directory, it opens the annotation UI.

This is not a filesystem watcher. It neither proves that a document was newly created or modified nor opens every matching file; it reacts only to paths mentioned in an assistant response and selects the first existing match.
