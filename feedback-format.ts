export interface Annotation {
  id: string;
  type: "comment" | "suggestion" | "issue" | "praise";
  text: string;
  scope: "selection" | "overall";
  originalText: string;
  range: {
    startOffset: number;
    endOffset: number;
    textPreview: string;
    diff?: { path: string; side: "original" | "current"; startLine: number; endLine: number };
  } | null;
  createdAt: number;
}

export type FeedbackFormatter = (annotations: Annotation[], sourceInfo: string) => string;

export const formatAnnotationFeedback: FeedbackFormatter = (annotations, sourceInfo) => {
  if (!annotations.length) return "";
  const items = annotations.map((a) => {
    const tag = a.type === "comment" ? "Comment" : a.type === "suggestion" ? "Suggestion" : a.type === "issue" ? "Issue" : "Praise";
    const target = a.scope === "overall" ? "> Applies to: Overall response"
      : a.range?.diff ? `> ${a.range.diff.path}:${a.range.diff.startLine}${a.range.diff.endLine !== a.range.diff.startLine ? `-${a.range.diff.endLine}` : ""} (${a.range.diff.side})`
      : `> Original text: "${a.originalText || "(none)"}"`;
    return `- **${a.type}**: ${tag}\n  ${target}\n  ${a.text}`;
  }).join("\n\n");
  const ending = annotations.some((a) => a.type === "issue")
    ? "Please address the issues above."
    : annotations.some((a) => a.type === "suggestion")
      ? "Please revise according to the suggestions above."
      : "Please consider the feedback above.";
  return `## Annotation Feedback\n\nThe following feedback was provided for ${sourceInfo}:\n\n${items}\n\n${ending}`;
};
