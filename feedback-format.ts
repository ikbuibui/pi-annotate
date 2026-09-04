import { gunzipSync } from "node:zlib";
import type { TurnFileChange } from "./diff/types.js";

export interface AnnotationDocument {
  id: string;
  kind: "message" | "file";
  title: string;
  sourceInfo: string;
  markdown: string;
  changes?: TurnFileChange[];
}

export interface AnnotationSource {
  id: string;
  title: string;
  sourceInfo: string;
  markdown?: string;
  changes?: TurnFileChange[];
}

export interface Annotation {
  id: string;
  type: "comment" | "suggestion" | "issue" | "praise";
  text: string;
  scope: "selection" | "overall";
  documentId: string | null;
  originalText: string;
  range: {
    startOffset: number;
    endOffset: number;
    textPreview: string;
    diff?: { documentId: string; path: string; side: "original" | "current"; startLine: number; endLine: number };
  } | null;
  createdAt: number;
}

export type FeedbackFormatter = (annotations: Annotation[], sources: readonly AnnotationSource[]) => string;

export interface FeedbackItemContext {
  annotation: Annotation;
  source?: AnnotationSource;
  target: string;
}

export interface FeedbackFormatOptions {
  heading: string;
  intro: string;
  formatSourceHeading: (source: AnnotationSource) => string;
  formatFullReviewHeading: () => string;
  formatItem: (context: FeedbackItemContext) => string;
  formatEnding: (annotations: Annotation[]) => string;
}

export interface StoredFeedbackFormat {
  id: string;
  name: string;
  template: string;
  contextLines?: number;
}

export interface FeedbackFormatDefinition extends StoredFeedbackFormat {
  description: string;
}

export const FEEDBACK_TEMPLATE_VARIABLES = {
  global: ["annotationCount", "sourceCount", "issueCount", "suggestionCount", "commentCount", "praiseCount", "contextLines", "ending"],
  source: ["sourceTitle", "sourceInfo"],
  annotation: ["id", "type", "label", "text", "scope", "target", "sourceTitle", "sourceInfo", "originalText", "context", "location"],
} as const;

const detailedTemplate = `## Annotation Feedback

The following feedback was provided:

{{#sources}}
### {{sourceTitle}}

{{#annotations}}
- **{{type}}**: {{label}}
  > {{location}}
  {{text}}
{{/annotations}}
{{/sources}}

{{#fullReview}}
### Full review

{{#annotations}}
- **{{type}}**: {{label}}
  > {{location}}
  {{text}}
{{/annotations}}
{{/fullReview}}

{{ending}}`;

export const BUILTIN_FEEDBACK_FORMATS: readonly FeedbackFormatDefinition[] = [{
  id: "detailed",
  name: "Detailed Markdown",
  description: "Grouped feedback with source headings, locations, and a context-aware ending.",
  template: detailedTemplate,
  contextLines: 0,
}, {
  id: "compact",
  name: "Compact Markdown",
  description: "Short, grouped one-line notes for lower token use.",
  template: `## Feedback

{{#sources}}
### {{sourceTitle}}
{{#annotations}}
- [{{label}}] {{text}} — {{location}}
{{/annotations}}
{{/sources}}

{{#fullReview}}
### Full review
{{#annotations}}
- [{{label}}] {{text}}
{{/annotations}}
{{/fullReview}}`,
  contextLines: 0,
}, {
  id: "actions",
  name: "Action list",
  description: "A direct checklist ordered as the annotations were submitted.",
  template: `Please revise the reviewed content as follows:

{{#annotations}}
- {{text}} ({{label}}, {{target}}; {{location}})
{{/annotations}}`,
  contextLines: 0,
}];

function defaultFormatItem({ annotation, target }: FeedbackItemContext): string {
  const tag = annotation.type === "comment" ? "Comment" : annotation.type === "suggestion" ? "Suggestion" : annotation.type === "issue" ? "Issue" : "Praise";
  const location = annotation.scope === "overall" ? `> Applies to: ${target}`
    : annotation.range?.diff ? `> ${annotation.range.diff.path}:${annotation.range.diff.startLine}${annotation.range.diff.endLine !== annotation.range.diff.startLine ? `-${annotation.range.diff.endLine}` : ""} (${annotation.range.diff.side})`
      : `> Original text: "${annotation.originalText || "(none)"}"`;
  return `- **${annotation.type}**: ${tag}\n  ${location}\n  ${annotation.text}`;
}

function defaultFormatEnding(annotations: Annotation[]): string {
  return annotations.some((annotation) => annotation.type === "issue")
    ? "Please address the issues above."
    : annotations.some((annotation) => annotation.type === "suggestion")
      ? "Please revise according to the suggestions above."
      : "Please consider the feedback above.";
}

const defaultFeedbackFormatOptions: FeedbackFormatOptions = {
  heading: "## Annotation Feedback",
  intro: "The following feedback was provided:",
  formatSourceHeading: (source) => `### ${source.title}`,
  formatFullReviewHeading: () => "### Full review",
  formatItem: defaultFormatItem,
  formatEnding: defaultFormatEnding,
};

const blockNames = new Set(["annotations", "sources", "fullReview"]);
const variableNames = new Set<string>(Object.values(FEEDBACK_TEMPLATE_VARIABLES).flat());
const templateToken = /{{\s*([#/])?\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g;

export function feedbackTemplateError(template: unknown): string | null {
  if (typeof template !== "string" || !template.trim()) return "Template is required";
  if (template.length > 20_000) return "Template is too long";
  const stack: string[] = [];
  let annotationsBlock = false;
  for (const match of template.matchAll(templateToken)) {
    const [, marker, name] = match;
    if (marker === "#") {
      if (!blockNames.has(name)) return `Unknown block: ${name}`;
      if ((name === "sources" || name === "fullReview") && stack.length) return `${name} must be a top-level block`;
      if (name === "annotations" && stack.at(-1) === "annotations") return "Annotation blocks cannot be nested";
      stack.push(name);
      if (name === "annotations") annotationsBlock = true;
    } else if (marker === "/") {
      if (stack.pop() !== name) return `Unmatched closing block: ${name}`;
    } else if (!variableNames.has(name)) {
      return `Unknown placeholder: ${name}`;
    }
  }
  if (stack.length) return `Unclosed block: ${stack.at(-1)}`;
  if (!annotationsBlock) return "Template must contain an {{#annotations}} block";
  if (template.replace(templateToken, "").includes("{{") || template.replace(templateToken, "").includes("}}")) return "Invalid template placeholder";
  return null;
}

function renderVariables(template: string, values: Record<string, string>): string {
  return template.replace(templateToken, (token, marker: string | undefined, name: string) => marker ? token : values[name] ?? "");
}

function contextFor(annotation: Annotation, source: AnnotationSource | undefined, contextLines: number): string {
  if (annotation.scope !== "selection" || !annotation.range) return "";
  if (!contextLines) return annotation.originalText;
  if (annotation.range.diff) {
    const diff = annotation.range.diff;
    const change = source?.changes?.find(({ path }) => path === diff.path);
    if (!change) return annotation.originalText;
    try {
      const encoded = diff.side === "original" ? change.snapshot.original : change.snapshot.modified;
      const lines = gunzipSync(Buffer.from(encoded, "base64")).toString("utf8").split(/\r?\n/);
      return lines.slice(Math.max(0, diff.startLine - contextLines - 1), diff.endLine + contextLines).join("\n");
    } catch {
      return annotation.originalText;
    }
  }
  if (!source?.markdown) return annotation.originalText;
  const startLine = (source.markdown.slice(0, annotation.range.startOffset).match(/\n/g) ?? []).length;
  const endLine = (source.markdown.slice(0, Math.max(annotation.range.startOffset, annotation.range.endOffset - 1)).match(/\n/g) ?? []).length;
  return source.markdown.split(/\r?\n/).slice(Math.max(0, startLine - contextLines), endLine + contextLines + 1).join("\n");
}

function annotationValues(annotation: Annotation, source: AnnotationSource | undefined, contextLines: number): Record<string, string> {
  const target = annotation.documentId === null ? "Full review"
    : annotation.scope === "overall" ? `Overall comment for ${source?.title ?? "source"}`
      : source?.title ?? "Source section";
  const location = annotation.scope === "overall" ? `Applies to: ${target}`
    : annotation.range?.diff ? `${annotation.range.diff.path}:${annotation.range.diff.startLine}${annotation.range.diff.endLine !== annotation.range.diff.startLine ? `-${annotation.range.diff.endLine}` : ""} (${annotation.range.diff.side})`
      : `Original text: "${annotation.originalText || "(none)"}"`;
  return {
    id: annotation.id,
    type: annotation.type,
    label: annotation.type[0].toUpperCase() + annotation.type.slice(1),
    text: annotation.text,
    scope: annotation.scope,
    target,
    sourceTitle: source?.title ?? "",
    sourceInfo: source?.sourceInfo ?? "",
    originalText: annotation.originalText,
    context: contextFor(annotation, source, contextLines),
    location,
  };
}

function trimBlock(value: string): string {
  return value.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");
}

function renderAnnotationBlocks(template: string, annotations: Annotation[], sources: readonly AnnotationSource[], contextLines: number, source?: AnnotationSource): string {
  return template.replace(/{{\s*#\s*annotations\s*}}([\s\S]*?){{\s*\/\s*annotations\s*}}/g, (_match, item: string) =>
    annotations.map((annotation) => trimBlock(renderVariables(item, annotationValues(annotation, source ?? sources.find(({ id }) => id === annotation.documentId), contextLines)))).filter(Boolean).join("\n\n"));
}

export function formatFeedbackTemplate(template: string, annotations: Annotation[], sources: readonly AnnotationSource[], contextLines = 0): string {
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100) throw new Error("Context lines must be between 0 and 100");
  const error = feedbackTemplateError(template);
  if (error) throw new Error(error);
  let output = template.replace(/{{\s*#\s*sources\s*}}([\s\S]*?){{\s*\/\s*sources\s*}}/g, (_match, sourceBlock: string) =>
    sources.flatMap((source) => {
      const items = annotations.filter((annotation) => annotation.documentId === source.id);
      return items.length ? [trimBlock(renderVariables(renderAnnotationBlocks(sourceBlock, items, sources, contextLines, source), { sourceTitle: source.title, sourceInfo: source.sourceInfo }))] : [];
    }).join("\n\n"));
  const fullReview = annotations.filter((annotation) => annotation.scope === "overall" && annotation.documentId === null);
  output = output.replace(/{{\s*#\s*fullReview\s*}}([\s\S]*?){{\s*\/\s*fullReview\s*}}/g, (_match, block: string) =>
    fullReview.length ? trimBlock(renderAnnotationBlocks(block, fullReview, sources, contextLines)) : "");
  output = renderAnnotationBlocks(output, annotations, sources, contextLines);
  const counts = (type: Annotation["type"]) => String(annotations.filter((annotation) => annotation.type === type).length);
  return renderVariables(output, {
    annotationCount: String(annotations.length),
    sourceCount: String(sources.length),
    issueCount: counts("issue"),
    suggestionCount: counts("suggestion"),
    commentCount: counts("comment"),
    praiseCount: counts("praise"),
    contextLines: String(contextLines),
    ending: defaultFormatEnding(annotations),
  }).replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

export function formatFeedbackById(formatId: string, annotations: Annotation[], sources: readonly AnnotationSource[], customFormats: readonly StoredFeedbackFormat[] = []): string {
  const format = BUILTIN_FEEDBACK_FORMATS.find(({ id }) => id === formatId) ?? customFormats.find(({ id }) => id === formatId) ?? BUILTIN_FEEDBACK_FORMATS[0];
  return formatFeedbackTemplate(format.template, annotations, sources, format.contextLines ?? 0);
}

export function formatFeedback(annotations: Annotation[], sources: readonly AnnotationSource[], overrides: Partial<FeedbackFormatOptions> = {}): string {
  if (!annotations.length) return "";
  const format = { ...defaultFeedbackFormatOptions, ...overrides };
  const groups = sources.flatMap((source) => {
    const items = annotations.filter((annotation) => annotation.documentId === source.id);
    return items.length
      ? `${format.formatSourceHeading(source)}\n\n${items.map((annotation) => format.formatItem({ annotation, source, target: `Overall comment for ${source.title}` })).join("\n\n")}`
      : [];
  });
  const fullReview = annotations.filter((annotation) => annotation.scope === "overall" && annotation.documentId === null);
  if (fullReview.length) {
    groups.push(`${format.formatFullReviewHeading()}\n\n${fullReview.map((annotation) => format.formatItem({ annotation, target: "Full review" })).join("\n\n")}`);
  }
  return `${format.heading}\n\n${format.intro}\n\n${groups.join("\n\n")}\n\n${format.formatEnding(annotations)}`;
}
