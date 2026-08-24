import type { DiffSnapshot, TurnChanges, TurnFileChange } from "./types.js";

export interface SessionEntryLike {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
}

export const CHANGE_ENTRY_TYPE = "pi-annotate-turn-changes";

function isSnapshot(value: unknown): value is DiffSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<DiffSnapshot>;
  return snapshot.encoding === "gzip+base64" && typeof snapshot.original === "string" && typeof snapshot.modified === "string";
}

function changeEntry(data: unknown, assistantEntryId: string): TurnChanges | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Partial<TurnChanges>;
  if (record.assistantEntryId !== assistantEntryId || !Array.isArray(record.changes)) return null;
  const changes = record.changes.filter((change): change is TurnFileChange =>
    !!change && typeof change.path === "string" && isSnapshot(change.snapshot),
  );
  return changes.length === record.changes.length ? { assistantEntryId, changes } : null;
}

export function findStoredTurnChanges(entries: SessionEntryLike[], assistantEntryId: string): TurnChanges | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === CHANGE_ENTRY_TYPE) {
      const changes = changeEntry(entry.data, assistantEntryId);
      if (changes) return changes;
    }
  }
  return null;
}
