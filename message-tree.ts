interface MessageTreeNode {
  entry: {
    id: string;
    parentId?: string | null;
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
  preview: string;
  prefix: string;
  label?: string;
  active: boolean;
}

interface CandidateNode extends Omit<AnnotationCandidate, "prefix"> {
  children: CandidateNode[];
}

function messageText(node: MessageTreeNode): string | null {
  if (node.entry.type !== "message" || !node.entry.message) return null;

  const { role, content } = node.entry.message;
  if ((role !== "user" && role !== "assistant") || !content) return null;

  const text = (typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("")
  ).trim();
  return text || null;
}

function activeEntryIds(tree: MessageTreeNode[], leafId?: string | null): Set<string> {
  const entries = new Map<string, MessageTreeNode["entry"]>();
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop()!;
    entries.set(node.entry.id, node.entry);
    stack.push(...node.children);
  }

  const active = new Set<string>();
  for (let id = leafId ?? null; id; id = entries.get(id)?.parentId ?? null) active.add(id);
  return active;
}

export function getAnnotationCandidates(
  tree: MessageTreeNode[],
  currentLeafId?: string | null,
): AnnotationCandidate[] {
  const activeIds = activeEntryIds(tree, currentLeafId);

  const prune = (nodes: MessageTreeNode[]): CandidateNode[] => nodes.flatMap((node) => {
    const children = prune(node.children);
    const text = messageText(node);
    if (!text) return children;

    return [{
      id: node.entry.id,
      role: node.entry.message!.role as AnnotationCandidate["role"],
      text,
      preview: text.replace(/\s+/g, " ").slice(0, 200),
      label: node.label,
      active: activeIds.has(node.entry.id),
      children,
    }];
  });

  const hasActive = (node: CandidateNode): boolean => node.active || node.children.some(hasActive);

  const flatten = (nodes: CandidateNode[], ancestors: boolean[] = []): AnnotationCandidate[] => {
    nodes.sort((a, b) => Number(hasActive(b)) - Number(hasActive(a)));

    return nodes.flatMap((node, index) => {
      const branches = nodes.length > 1;
      const isLast = index === nodes.length - 1;
      const prefix = ancestors.map((last) => last ? "   " : "│  ").join("") + (branches ? isLast ? "└─ " : "├─ " : "");
      const nextAncestors = branches ? [...ancestors, isLast] : ancestors;
      const { children, ...candidate } = node;
      return [{ ...candidate, prefix }, ...flatten(children, nextAncestors)];
    });
  };

  return flatten(prune(tree));
}

export function getInitialAnnotationCandidateIndex(candidates: AnnotationCandidate[]): number {
  for (let index = candidates.length - 1; index >= 0; index--) {
    if (candidates[index].active) return index;
  }
  return candidates.length - 1;
}
