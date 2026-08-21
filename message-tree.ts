interface MessageTreeNode {
  entry: {
    id: string;
    type: string;
    message?: {
      role: string;
      content?: string | Array<{ type: string; text?: string }>;
    };
  };
  children: MessageTreeNode[];
  label?: string;
}

export interface AnnotationCandidate {
  id: string;
  role: "user" | "assistant";
  text: string;
  label: string;
}

function messageText(node: MessageTreeNode): AnnotationCandidate["text"] | null {
  if (node.entry.type !== "message" || !node.entry.message) return null;

  const { role, content } = node.entry.message;
  if ((role !== "user" && role !== "assistant") || !content) return null;

  const text = (typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("")
  ).trim();
  return text || null;
}

export function getAnnotationCandidates(tree: MessageTreeNode[]): AnnotationCandidate[] {
  const candidates: AnnotationCandidate[] = [];

  const visit = (nodes: MessageTreeNode[], prefix = "") => {
    nodes.forEach((node, index) => {
      const isLast = index === nodes.length - 1;
      const text = messageText(node);
      if (text) {
        const role = node.entry.message!.role as AnnotationCandidate["role"];
        const preview = text.replace(/\s+/g, " ").slice(0, 80);
        candidates.push({
          id: node.entry.id,
          role,
          text,
          label: `${prefix}${isLast ? "└─" : "├─"} ${role} [${node.entry.id}]: ${preview}`,
        });
      }
      visit(node.children, `${prefix}${isLast ? "   " : "│  "}`);
    });
  };

  visit(tree);
  return candidates;
}
