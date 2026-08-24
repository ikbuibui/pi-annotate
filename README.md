# pi-annotate

A visual annotation extension for pi-agent that opens an interactive annotation UI in your browser for reviewing context messages and markdown documents.

<p align="center">
  <img src="docs/demo/annotation-ui.png" alt="pi-annotate annotation UI screenshot" width="100%">
  <br>
  <em>Annotation UI: select text to reveal a floating toolbar, annotations appear in the right panel</em>
</p>

## Installation

```bash
pi install npm:@jackice/pi-annotate
```

Or install from a local path:

```bash
pi install /path/to/pi-annotate
```

Restart pi or run `/reload` to load the extension.

**Requirements:**
- pi-agent v0.35.0 or later (extensions API)

## Features

- **Message Annotation**: Mark one or more previous user or assistant messages from the session tree, collapse message sections as needed, or annotate the last assistant message directly
- **Document Annotation**: Open one or more markdown files (specs, plans, design docs) in one ordered visual review
- **Turn File Diffs**: Annotating an assistant response includes unified or side-by-side diffs for files changed with `edit` or `write` in that response's turn
- **Annotation Types**: Comment, Suggestion, Issue, and Praise — each with distinct color coding
- **Quick Labels**: One-click preset labels for common feedback, including needs clarification, missing details, and verify assumption
- **Floating Toolbar**: Select text to reveal Comment, Suggestion, Issue, Quick Label, and Close actions
- **Text Feedback Popups**: Comment, Suggestion, and Issue each open a focused text-entry popup
- **Three Comment Scopes**: Annotate selected text, add an overall comment for one source section, or add a full-review comment
- **Feedback Delivery**: Annotations are sent back to the agent as a structured follow-up message
- **Approve Without Feedback**: When no annotations exist, approve documents directly
- **Themes**: Select built-in or installed browser palettes; `Ctrl+Shift+L` cycles them
- **Submit Confirmation**: Shows confirmation after submitting feedback or approving

## How It Works

```
┌─────────┐     ┌──────────────────────────────────────┐     ┌─────────┐
│  User   │     │        Browser Annotation UI         │     │  Agent  │
│ runs a  ├────►│                                      ├────►│receives │
│ command │     │  select text → add annotation → send │     │feedback │
└─────────┘     │                                      │     └─────────┘
                └──────────────────────────────────────┘
```

**Lifecycle:**
1. Run `/annotate`, `/annotate <file> [file...]`, or `/annotate-last`
2. Local server starts → annotation UI opens in the system browser
3. Select text in the document → floating toolbar appears with annotation actions
4. Add overall comments from the bottom action bar, or select text for Comment, Suggestion, Issue, or a Quick Label (including delete and praise)
5. The review ends via:
   - **Send Feedback** → annotations sent back to agent as follow-up message
   - **Approve without feedback** → document approved, no feedback sent (available when no annotations exist)
   - **Close the review tab** → review ends without feedback
6. Within the chat that opened it, prompt and slash-command submission is blocked until the review ends. This permits one user-started annotation review at a time per chat; it is not a process-wide server limit, so separate chats or pi processes can review concurrently.
7. After sending feedback or approving, the browser tab may remain open, but the review is no longer active.

## Usage

The extension provides two slash commands:

### `/annotate-last`

Annotate the last assistant message in the current session:

```
/annotate-last
```

Select text in the message, add annotations or quick labels, and send feedback to the agent. If the response changed files with `edit` or `write`, a **Files changed** section lets you switch between unified and side-by-side Git-independent diffs. The whitespace toggle ignores leading/trailing whitespace when computing hunks.

### `/annotate <file> [file...]`

Without a file, select any previous user or assistant message from the session tree:

```
/annotate
```

Mark messages with `Space`, then press `f` to add one or more files. The file input supports quoted paths and `Tab` completion; the review opens marked messages in tree order followed by files in typed order.

<p align="center">
  <img src="docs/demo/annotation-tree.png" alt="pi-annotate message tree with marked messages" width="100%">
  <br>
  <em>Message selector: mark one or more chat messages, then open the review or add files</em>
</p>

With files, annotate one or more documents in argument order. Quotes and escapes preserve paths with spaces:

```
/annotate docs/specs/my-design.md
/annotate "docs/my plan.md" README.md
/annotate @PLAN.md @README.md
```

Every path is resolved and read before the browser opens; a missing or unreadable path opens no partial review. Duplicate resolved paths are shown once, at their first position.

File paths support:
- Relative paths (from current working directory)
- Absolute paths
- `@` prefix notation on each path (e.g., `@docs/specs/...`)
- Single quotes, double quotes, and backslash escapes

Turn diffs cover the built-in `edit` and `write` tools. Shell commands and custom tools are not tracked because their filesystem effects cannot be attributed reliably without workspace snapshots.

## Annotation UI

### Floating Toolbar

Select any text to reveal a floating toolbar:

| Button | Action | Description |
|--------|--------|-------------|
| 💬 Comment | Opens text input | Type detailed feedback about the selected text |
| 💡 Suggestion | Opens text input | Propose an improvement for the selected text |
| ⓘ Issue | Opens text input | Describe a problem in the selected text |
| ⚡ Quick Label | Opens preset picker | Add a preset annotation to the selected text |
| ✕ Close | Dismisses toolbar | Discards the selected range for annotation |

### Quick Labels

Preset labels for common feedback on specs, plans, and messages:

Quick labels are chosen from the Quick Label menu; they have no number-key shortcuts.

| Label | Annotation type | Description |
|-------|-----------------|-------------|
| 🗑️ Suggest deletion | Suggestion | Suggests removing the selected section |
| 👍 Looks good | Praise | Marks the selected text as good |
| ❓ Needs Clarification | Suggestion | The selected section requires further explanation |
| 📋 Missing Details | Suggestion | Key details or specifics are absent |
| 🔍 Verify Assumption | Suggestion | Underlying assumption needs to be validated |
| 🔬 Missing Example | Suggestion | A concrete example would improve understanding |
| ⚖️ Trade-off Analysis | Suggestion | Pros and cons of this approach should be discussed |
| 🏗️ Over-engineered | Suggestion | The proposed solution is more complex than needed |
| 🚫 Out of Scope | Suggestion | This item falls outside the defined scope |
| ⚠️ Edge Case Missing | Suggestion | Potential edge cases have not been addressed |
| 📐 Well-structured | Suggestion | The structure and organization are clear |

### Annotation Panel

All annotations appear in the right sidebar panel with their source title. Every message and file is a separate collapsible source card with its content, diffs, and section comment action. In a multi-source review, click **N sources** in the top-left bar to jump to any message or file. Each source section has **Overall comment for this section**; use **Full review comment** in the bottom action bar for feedback that applies across all sources. For a one-source review, only **Overall comment** is shown. Each annotation shows:
- Type badge with color coding (Comment/Suggestion/Issue/Praise)
- Annotation text
- Original selected text preview, or its section/full-review scope
- Timestamp
- Edit (✏️) and Delete (🗑️) buttons

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Shift+L` | Cycle installed browser themes |

### Message selector

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move focus |
| `Space` | Mark or unmark the focused message |
| `Enter` | **Open review** for marked messages, or the focused message when none are marked |
| `f` | Add files after selected messages; `Tab` completes paths |
| `/` | Search messages |
| `Esc` | Clear active search, or cancel |

Marked messages stay marked while searching. Reviews use the displayed tree order, never mark order.

## Custom Browser Themes

Install JSON palette files in `~/.pi/agent/pi-annotate/themes/` (or `$PI_CODING_AGENT_DIR/pi-annotate/themes/`). They are loaded when an annotation page opens and appear in its **Theme** selector.

```json
{
  "name": "Nord",
  "colors": {
    "bg-primary": "#2e3440",
    "bg-secondary": "#3b4252",
    "text-primary": "#eceff4",
    "accent": "#88c0d0",
    "type-issue": "#bf616a"
  }
}
```

`name` must be unique and cannot be `dark` or `light`. `colors` may override any palette token: `bg-primary`, `bg-secondary`, `bg-tertiary`, `bg-hover`, `text-primary`, `text-secondary`, `text-muted`, `border`, `border-light`, `accent`, `accent-hover`, `success`, `danger`, `warning`, and the `type-{comment,suggestion,issue,praise}` / `-bg` / `-border` tokens. Values accept hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, or CSS color keywords. Omitted tokens retain the dark palette's values.

## File Structure

```
pi-annotate/
├── index.ts              # Extension entry point and commands
├── feedback-format.ts    # Model-feedback formatter
├── diff/                 # Git-independent per-turn file diff tracking
├── server.ts              # Annotation HTTP server (API routes)
├── theme.ts               # User theme validation and discovery
├── form/
│   └── annotate.html      # Annotation UI (pure HTML/CSS/JS, no build step)
├── package.json
└── README.md
```

## Feedback Format

When you send feedback, the agent receives a structured message like:

```
## Annotation Feedback

The following feedback was provided for docs/specs/my-design.md:

- **suggestion**: Consider adding concrete API design details
  > Original text: "Communication uses a RESTful API"

- **issue**: Error handling strategy is missing
  > Original text: "The system will return an error message on failure"

### Full review

- **comment**: The response should start with a short summary.
  > Applies to: Full review

Please address the issues above.
```

The ending is context-aware:
- If there are **issues**: "Please address the issues above."
- If there are **suggestions**: "Please revise according to the suggestions above."
- Otherwise: "Please consider the feedback above."

### Customize the format

`formatFeedback` separates formatting from annotation collection and delivery. Pass only the parts you want to change:

```ts
import { formatFeedback } from "./feedback-format.js";

const feedback = formatFeedback(annotations, sources, {
  heading: "# Review notes",
  formatItem: ({ annotation, target }) => `[${annotation.type}] ${target}: ${annotation.text}`,
  formatEnding: () => "End of review.",
});
```

This customizes the built-in grouped text layout while retaining all structured annotation data. For a wholly different format such as JSON or XML, implement `FeedbackFormatter` directly and pass it to `handleAnnotationDecision`.

## Limits

- Max 5MB request body for feedback submission
- Sessions stay open until feedback, approval, exit, or a normal tab close
- Prompt and slash-command submission is blocked in the chat that opened a review until it ends
- One user-started annotation review can be active per chat; separate chats or pi processes can review concurrently
