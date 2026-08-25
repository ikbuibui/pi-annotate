import { matchesKey } from "@earendil-works/pi-tui";

export interface ReviewInputEvent {
  source: "interactive" | "rpc" | "extension";
}

export class ReviewGate {
  private active = false;

  start(): void {
    this.active = true;
  }

  finish(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  handleInput(input: ReviewInputEvent): { action: "continue" | "handled" } {
    return this.active && input.source !== "extension" ? { action: "handled" } : { action: "continue" };
  }
}

export function handleReviewTerminalInput(
  gate: ReviewGate,
  data: string,
  onBlocked: () => void,
  onForceClose?: () => void,
): { consume: true } | undefined {
  if (!gate.isActive()) return;
  if (matchesKey(data, "return")) { onBlocked(); return { consume: true }; }
  if (onForceClose && matchesKey(data, "ctrl+c")) { onForceClose(); return { consume: true }; }
}
