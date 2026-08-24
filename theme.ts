import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const THEME_COLOR_KEYS = [
  "bg-primary", "bg-secondary", "bg-tertiary", "bg-hover",
  "text-primary", "text-secondary", "text-muted",
  "border", "border-light", "accent", "accent-hover",
  "success", "danger", "warning",
  "type-comment", "type-comment-bg", "type-comment-border",
  "type-suggestion", "type-suggestion-bg", "type-suggestion-border",
  "type-issue", "type-issue-bg", "type-issue-border",
  "type-praise", "type-praise-bg", "type-praise-border",
] as const;

type ThemeColorKey = typeof THEME_COLOR_KEYS[number];

export interface BrowserTheme {
  name: string;
  colors: Partial<Record<ThemeColorKey, string>>;
}

const colorKeys = new Set<string>(THEME_COLOR_KEYS);
const colorValue = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([0-9.%\s,/-]+\)|[a-z]+)$/i;
const themeName = /^[a-z0-9][a-z0-9 _-]{0,31}$/i;

export function annotationThemeDirectory(): string {
  return resolve(process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi", "agent"), "pi-annotate", "themes");
}

export function parseBrowserTheme(source: string): BrowserTheme | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const { name, colors } = parsed as { name?: unknown; colors?: unknown };
  if (typeof name !== "string" || !themeName.test(name) || name === "dark" || name === "light") return null;
  if (!colors || typeof colors !== "object" || Array.isArray(colors)) return null;

  const entries = Object.entries(colors);
  if (!entries.length || entries.some(([key, value]) => !colorKeys.has(key) || typeof value !== "string" || !colorValue.test(value))) return null;
  return { name, colors: Object.fromEntries(entries) as BrowserTheme["colors"] };
}

export function loadAnnotationThemes(directory = annotationThemeDirectory()): BrowserTheme[] {
  try {
    const names = new Set(["dark", "light"]);
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        try {
          const theme = parseBrowserTheme(readFileSync(resolve(directory, entry.name), "utf-8"));
          return theme && !names.has(theme.name) && names.add(theme.name) ? [theme] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
