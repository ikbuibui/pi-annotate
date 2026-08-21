# pi-annotate

A visual annotation extension for pi-agent that opens an interactive annotation UI for reviewing context messages and markdown documents. On macOS, uses [Glimpse](https://github.com/hazat/glimpse) to render in a native WKWebView window; falls back to a browser tab on other platforms.

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
- For native macOS window: `npm install -g glimpseui@">=0.8.1"` (optional, falls back to browser if not installed) — Glimpse 0.8.1+ required for native clipboard support (`⌘C`/`⌘V`)

## Features

- **Message Annotation**: Annotate the last assistant message with selected-text or overall-response feedback
- **Document Annotation**: Open any markdown file (specs, plans, design docs) in a visual annotation UI
- **Annotation Types**: Comment, Suggestion, Issue, and Praise — each with distinct color coding
- **Quick Labels**: One-click preset labels for common feedback (needs clarification, missing details, verify assumption, etc.)
- **Floating Toolbar**: Select text to reveal Comment, Suggestion, Issue, Delete, Quick Label, and Looks Good actions
- **Text Feedback Popups**: Comment, Suggestion, and Issue each open a focused text-entry popup
- **Overall Comments**: Add comment feedback for the whole response from the annotation panel
- **Feedback Delivery**: Annotations are sent back to the agent as a structured follow-up message
- **Approve Without Feedback**: When no annotations exist, approve documents directly
- **Theme Toggle**: Switch between dark and light themes with `⌘+Shift+L` (`Ctrl+Shift+L` off macOS)
- **Auto-Close**: Window closes automatically after submitting feedback or approving

## How It Works

```
┌─────────┐     ┌──────────────────────────────────────┐     ┌─────────┐
│  User   │     │     Glimpse / Browser Annotation UI   │     │  Agent  │
│ runs a  ├────►│                                      ├────►│receives │
│ command │     │  select text → add annotation → send  │     │feedback │
└─────────┘     │                                      │     └─────────┘
                └──────────────────────────────────────┘
```

**Lifecycle:**
1. Run `/annotate <file>` or `/annotate-last`
2. Local server starts → Glimpse window opens (macOS) or browser tab (elsewhere)
3. Select text in the document → floating toolbar appears with annotation actions
4. Add overall comments from the sidebar, or select text for Comment, Suggestion, Issue, Quick Label, Delete, or Praise
5. Session ends via:
   - **Send Feedback** → annotations sent back to agent as follow-up message
   - **Approve** → document approved, no feedback sent (available when no annotations exist)
   - **Close window** → session ends without feedback
6. Window closes automatically after sending feedback or approving

## Usage

The extension provides two slash commands:

### `/annotate-last`

Annotate the last assistant message in the current session:

```
/annotate-last
```

Select text in the message, add annotations or quick labels, and send feedback to the agent.

### `/annotate <file>`

Annotate a specific markdown file:

```
/annotate docs/superpowers/specs/my-design.md
/annotate PLAN.md
```

Supports:
- Relative paths (from current working directory)
- Absolute paths
- `@` prefix notation (e.g., `@docs/superpowers/specs/...`)

## Annotation UI

### Floating Toolbar

Select any text to reveal a floating toolbar:

| Button | Action | Description |
|--------|--------|-------------|
| 💬 Comment | Opens text input | Type detailed feedback about the selected text |
| 💡 Suggestion | Opens text input | Propose an improvement for the selected text |
| ⓘ Issue | Opens text input | Describe a problem in the selected text |
| 🗑️ Delete | Creates issue annotation | Suggests removing the selected section |
| ⚡ Quick Label | Opens preset picker | One-click labels for common feedback |
| 👍 Looks Good | Creates praise annotation | Marks the selected text as good |

### Quick Labels

Preset labels for common feedback on specs, plans, and messages:

| Key | Label | Description |
|-----|-------|-------------|
| 1 | ❓ Needs Clarification | The selected section requires further explanation |
| 2 | 📋 Missing Details | Key details or specifics are absent |
| 3 | 🔍 Verify Assumption | Underlying assumption needs to be validated |
| 4 | 🔬 Missing Example | A concrete example would improve understanding |
| 5 | ⚖️ Trade-off Analysis | Pros and cons of this approach should be discussed |
| 6 | 🏗️ Over-engineered | The proposed solution is more complex than needed |
| 7 | 🚫 Out of Scope | This item falls outside the defined scope |
| 8 | ⚠️ Edge Case Missing | Potential edge cases have not been addressed |
| 9 | 📐 Well-structured | The structure and organization are clear |
| 0 | 👍 Good Approach | The proposed approach is sound |

### Annotation Panel

All annotations appear in the right sidebar panel. Use **Overall comment** there to comment on the entire response. Each annotation shows:
- Type badge with color coding (Comment/Suggestion/Issue/Praise)
- Annotation text
- Original selected text preview, or an Overall response marker
- Timestamp
- Edit (✏️) and Delete (🗑️) buttons

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘+Shift+L` | Toggle dark/light theme (`Ctrl` off macOS) |
| `1`-`9`, `0` | Select Quick Label by number (when picker open) |

## File Structure

```
pi-annotate/
├── index.ts              # Extension entry point, commands, Glimpse integration
├── feedback-format.ts    # Model-feedback formatter
├── server.ts              # Annotation HTTP server (API routes)
├── form/
│   └── annotate.html      # Annotation UI (pure HTML/CSS/JS, no build step)
├── package.json
└── README.md
```

## Feedback Format

When you send feedback, the agent receives a structured message like:

```
## Annotation Feedback

The following feedback was provided for docs/superpowers/specs/my-design.md:

- **suggestion**: Consider adding concrete API design details
  > Original text: "Communication uses a RESTful API"

- **issue**: Error handling strategy is missing
  > Original text: "The system will return an error message on failure"

- **comment**: The response should start with a short summary.
  > Applies to: Overall response

Please address the issues above.
```

The ending is context-aware:
- If there are **issues**: "Please address the issues above."
- If there are **suggestions**: "Please revise according to the suggestions above."
- Otherwise: "Please consider the feedback above."

## Limits

- Max 5MB request body for feedback submission
- 2-minute idle timeout auto-closes the server
- Single concurrent annotation session
