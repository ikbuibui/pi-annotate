import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type DiffStyle = "unified" | "side-by-side";
export interface Preferences { diffStyle: DiffStyle; ignoreWhitespace: boolean; }

export function preferenceFile(): string {
  return resolve(process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi", "agent"), "pi-annotate", "preferences.json");
}

export function loadPreferences(file = preferenceFile()): Preferences {
  try {
    const saved = JSON.parse(readFileSync(file, "utf-8"));
    return {
      diffStyle: saved?.diffStyle === "unified" ? "unified" : "side-by-side",
      ignoreWhitespace: typeof saved?.ignoreWhitespace === "boolean" ? saved.ignoreWhitespace : true,
    };
  } catch {
    return { diffStyle: "side-by-side", ignoreWhitespace: true };
  }
}

export function savePreferences(update: Partial<Preferences>, file = preferenceFile()): Preferences {
  const preferences = { ...loadPreferences(file), ...update };
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(preferences) + "\n", { mode: 0o600 });
  renameSync(temp, file);
  return preferences;
}
