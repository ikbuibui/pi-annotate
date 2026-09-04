import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { BUILTIN_FEEDBACK_FORMATS, feedbackTemplateError, type StoredFeedbackFormat } from "./feedback-format.js";

export type DiffStyle = "unified" | "side-by-side";
export interface Preferences {
  diffStyle: DiffStyle;
  ignoreWhitespace: boolean;
  feedbackFormat: string;
  feedbackFormats: StoredFeedbackFormat[];
}

const builtInIds = new Set(BUILTIN_FEEDBACK_FORMATS.map(({ id }) => id));
const builtInNames = new Set(BUILTIN_FEEDBACK_FORMATS.map(({ name }) => name.toLowerCase()));

export function preferenceFile(): string {
  return resolve(process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi", "agent"), "pi-annotate", "preferences.json");
}

export function validFeedbackFormats(value: unknown): value is StoredFeedbackFormat[] {
  if (!Array.isArray(value) || value.length > 20) return false;
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.every((format) => {
    if (!format || typeof format !== "object" || Array.isArray(format)) return false;
    const { id, name, template, contextLines } = format as Partial<StoredFeedbackFormat>;
    const normalizedName = typeof name === "string" ? name.trim().toLowerCase() : "";
    if (typeof id !== "string" || !/^custom:[a-z0-9-]{1,64}$/i.test(id) || ids.has(id)) return false;
    if (typeof name !== "string" || name !== name.trim() || !name || name.length > 50 || names.has(normalizedName) || builtInNames.has(normalizedName)) return false;
    if (feedbackTemplateError(template) || (contextLines !== undefined && (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100))) return false;
    ids.add(id);
    names.add(normalizedName);
    return true;
  });
}

export function loadPreferences(file = preferenceFile()): Preferences {
  try {
    const saved = JSON.parse(readFileSync(file, "utf-8"));
    const feedbackFormats = validFeedbackFormats(saved?.feedbackFormats) ? saved.feedbackFormats : [];
    const available = new Set([...builtInIds, ...feedbackFormats.map(({ id }) => id)]);
    return {
      diffStyle: saved?.diffStyle === "unified" ? "unified" : "side-by-side",
      ignoreWhitespace: typeof saved?.ignoreWhitespace === "boolean" ? saved.ignoreWhitespace : true,
      feedbackFormat: typeof saved?.feedbackFormat === "string" && available.has(saved.feedbackFormat) ? saved.feedbackFormat : "detailed",
      feedbackFormats,
    };
  } catch {
    return { diffStyle: "side-by-side", ignoreWhitespace: true, feedbackFormat: "detailed", feedbackFormats: [] };
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
