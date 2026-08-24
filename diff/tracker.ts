import { gzipSync } from "node:zlib";
import type { TurnFileChange } from "./types.js";

export class TurnChangeTracker {
  private readonly mutations = new Map<string, { displayPath: string; before: string; changed: boolean }>();
  private readonly calls = new Map<string, string>();

  reset(): void {
    this.mutations.clear();
    this.calls.clear();
  }

  capture(toolCallId: string, absolutePath: string, displayPath: string, before: string): void {
    if (!this.mutations.has(absolutePath)) {
      this.mutations.set(absolutePath, { displayPath, before, changed: false });
    }
    this.calls.set(toolCallId, absolutePath);
  }

  markSucceeded(toolCallId: string): void {
    const path = this.calls.get(toolCallId);
    if (path) this.mutations.get(path)!.changed = true;
  }

  finalize(readAfter: (absolutePath: string) => string | null): TurnFileChange[] {
    const changes = [...this.mutations].flatMap(([absolutePath, mutation]) => {
      if (!mutation.changed) return [];
      const after = readAfter(absolutePath);
      return after === null || after === mutation.before ? [] : [{
        path: mutation.displayPath,
        snapshot: {
          encoding: "gzip+base64" as const,
          original: gzipSync(mutation.before).toString("base64"),
          modified: gzipSync(after).toString("base64"),
        },
      }];
    });
    this.reset();
    return changes;
  }
}
