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
