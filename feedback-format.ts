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

export type FeedbackFormatter = (annotations: Annotation[], source: readonly AnnotationSource[]) => string;

function formatItem(annotation: Annotation, overallLabel = "Overall response"): string {
  const tag = annotation.type === "comment" ? "Comment" : annotation.type === "suggestion" ? "Suggestion" : annotation.type === "issue" ? "Issue" : "Praise";
  const target = annotation.scope === "overall" ? `> Applies to: ${overallLabel}`
    : annotation.range?.diff ? `> ${annotation.range.diff.path}:${annotation.range.diff.startLine}${annotation.range.diff.endLine !== annotation.range.diff.startLine ? `-${annotation.range.diff.endLine}` : ""} (${annotation.range.diff.side})`
    : `> Original text: "${annotation.originalText || "(none)"}"`;
  return `- **${annotation.type}**: ${tag}\n  ${target}\n  ${annotation.text}`;
}

function feedbackEnding(annotations: Annotation[]): string {
  return annotations.some((annotation) => annotation.type === "issue")
    ? "Please address the issues above."
    : annotations.some((annotation) => annotation.type === "suggestion")
      ? "Please revise according to the suggestions above."
      : "Please consider the feedback above.";
}

export const formatAnnotationFeedback: FeedbackFormatter = (annotations, source) => {
  if (!annotations.length) return "";
  const groups = source.flatMap((document) => {
    const items = annotations.filter((annotation) => annotation.documentId === document.id);
    return items.length ? `### ${document.title}\n\n${items.map((annotation) => formatItem(annotation, `Overall comment for ${document.title}`)).join("\n\n")}` : [];
  });
  const fullReview = annotations.filter((annotation) => annotation.scope === "overall" && annotation.documentId === null);
  if (fullReview.length) groups.push(`### Full review\n\n${fullReview.map((annotation) => formatItem(annotation, "Full review")).join("\n\n")}`);
  return `## Annotation Feedback\n\nThe following feedback was provided:\n\n${groups.join("\n\n")}\n\n${feedbackEnding(annotations)}`;
};
