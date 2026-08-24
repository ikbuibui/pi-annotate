/**
 * @author jackice
 * @date 2026-05-15
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import MarkdownIt, { type RendererRule } from "markdown-it";
import hljs from "highlight.js/lib/common";
import type { Annotation, AnnotationDocument } from "./feedback-format.js";
import { renderTurnFileDiffHtml } from "./diff/render.js";
import { loadPreferences, savePreferences } from "./preferences.js";
import type { BrowserTheme } from "./theme.js";

export type { Annotation } from "./feedback-format.js";

interface AnnotationServerOptions {
  documents: AnnotationDocument[];
  htmlContent: string;
  mode: "annotate" | "annotate-last";
  gate?: boolean;
  themes?: BrowserTheme[];
  assets?: Record<string, { content: string; contentType: string }>;
  preferencePath?: string;
}

interface AnnotationServerHandle {
  url: string;
  stop: () => void;
  waitForDecision: () => Promise<{
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }>;
  resolveDecision: (result: {
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }) => void;
}

const MAX_BODY_SIZE = 5 * 1024 * 1024;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 30000;

class BodyTooLargeError extends Error {
  statusCode = 413;
}

class RequestTimeoutError extends Error {
  statusCode = 408;
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      reject(new RequestTimeoutError("Request timeout"));
    }, REQUEST_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        clearTimeout(timer);
        req.destroy();
        reject(new BodyTooLargeError("Request body too large"));
        return;
      }
      body += chunk.toString("utf-8");
    });

    req.on("end", () => {
      if (timedOut) return;
      clearTimeout(timer);
      if (body.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`Invalid JSON: ${message}`));
      }
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function safeInlineJSON(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function isMarkdownFile(path: string): boolean {
  return /\.(?:md|markdown|mdown|mkd)$/i.test(path);
}

function detectFileLanguage(path: string): string | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const language = ({
    js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", php: "php", java: "java", kt: "kotlin", go: "go", rs: "rust",
    c: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
    cs: "csharp", swift: "swift", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", html: "xml", css: "css",
    sql: "sql", diff: "diff", patch: "diff",
  } as Record<string, string>)[name.split(".").pop() ?? ""] ??
    ({ dockerfile: "dockerfile", makefile: "makefile" } as Record<string, string>)[name];
  return language && hljs.getLanguage(language) ? language : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderCodeFile(code: string, language: string): string {
  const html = language === "unknown" ? escapeHtml(code) : hljs.highlight(code, { language, ignoreIllegals: true }).value;
  return `<div class="md-block code-file" data-offset-start="0" data-offset-end="${code.length}"><pre><code class="hljs language-${language}">${html}</code></pre></div>`;
}

function renderDocument(document: AnnotationDocument): AnnotationDocument & { html: string; language?: string } {
  if (document.kind !== "file" || isMarkdownFile(document.title)) return { ...document, html: renderMarkdown(document.markdown) };
  const language = detectFileLanguage(document.title) ?? "unknown";
  return { ...document, language, html: renderCodeFile(document.markdown, language) };
}

const markdownRenderer = new MarkdownIt({
  html: false,
  highlight(code, language) {
    return language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : "";
  },
});
const defaultFenceRenderer = markdownRenderer.renderer.rules.fence as RendererRule;
const defaultImageRenderer = markdownRenderer.renderer.rules.image as RendererRule;

markdownRenderer.renderer.rules.fence = (tokens, idx, options, env, renderer) => {
  const offsets = tokens[idx].meta?.annotationOffsets;
  const html = defaultFenceRenderer(tokens, idx, options, env, renderer);
  if (!Array.isArray(offsets)) return html;
  return `<div class="md-block" data-offset-start="${offsets[0]}" data-offset-end="${offsets[1]}">${html}</div>`;
};

markdownRenderer.renderer.rules.link_open = (tokens, idx, options, _env, renderer) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener");
  return renderer.renderToken(tokens, idx, options);
};

markdownRenderer.renderer.rules.image = (tokens, idx, options, env, renderer) => {
  tokens[idx].attrSet("loading", "lazy");
  return defaultImageRenderer(tokens, idx, options, env, renderer);
};

function sourceLineOffsets(markdown: string): number[] {
  const offsets = [0];
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === "\r") {
      if (markdown[i + 1] === "\n") i++;
      offsets.push(i + 1);
    } else if (markdown[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

export function renderMarkdown(markdown: string): string {
  const env = {};
  const tokens = markdownRenderer.parse(markdown, env);
  const lineOffsets = sourceLineOffsets(markdown);
  let listDepth = 0;

  for (const token of tokens) {
    if (token.type === "bullet_list_close" || token.type === "ordered_list_close") listDepth--;

    const annotatable = token.type === "list_item_open" || (listDepth === 0 && (
      token.type === "paragraph_open" || token.type === "heading_open" ||
      token.type === "table_open" || token.type === "hr" ||
      token.type === "fence" || token.type === "code_block"
    ));

    if (annotatable && token.map) {
      const start = lineOffsets[token.map[0]] ?? markdown.length;
      const end = lineOffsets[token.map[1]] ?? markdown.length;
      if (token.type === "fence") {
        token.meta = { ...token.meta, annotationOffsets: [start, end] };
      } else {
        token.attrJoin("class", "md-block");
        token.attrSet("data-offset-start", start);
        token.attrSet("data-offset-end", end);
      }
    }

    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") listDepth++;
  }

  return markdownRenderer.renderer.render(tokens, markdownRenderer.options, env);
}

export async function startAnnotationServer(
  options: AnnotationServerOptions
): Promise<AnnotationServerHandle> {
  const { documents, htmlContent, mode, gate, themes = [], assets = {}, preferencePath } = options;
  if (!documents.length) throw new Error("At least one annotation document is required");
  const renderedDocuments = documents.map(renderDocument);
  const languages = ["unknown", ...hljs.listLanguages().sort()];
  const sessionToken = randomUUID();

  let resolved = false;
  let resolveDecision!: (result: {
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }) => void;
  const decisionPromise = new Promise<{
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }>((resolve) => {
    resolveDecision = resolve;
  });

  const resolveOnce = (
    result: {
      action: "feedback" | "approve" | "exit";
      feedback?: string;
      annotations?: Annotation[];
    }
  ): void => {
    if (resolved) return;
    resolved = true;
    resolveDecision(result);
  };

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = requestUrl(req);

      if (method === "GET" && url.pathname === "/") {
        const inlineData = safeInlineJSON({
          sessionToken,
          mode,
          gate: gate ?? false,
          themes,
          startedAt: Date.now(),
        });
        const html = htmlContent.replace("__ANNOTATE_DATA__", inlineData);
        sendHtml(res, html);
        return;
      }

      const asset = assets[url.pathname];
      if (method === "GET" && asset) {
        res.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "no-store" });
        res.end(asset.content);
        return;
      }

      if (method === "GET" && url.pathname === "/api/preferences") {
        sendJson(res, 200, loadPreferences(preferencePath));
        return;
      }

      if (method === "PUT" && url.pathname === "/api/preferences") {
        const payload = await parseJsonBody(req);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          sendJson(res, 400, { ok: false, error: "Preferences must be an object" });
          return;
        }
        const { diffStyle, ignoreWhitespace } = payload as { diffStyle?: unknown; ignoreWhitespace?: unknown };
        if ((diffStyle !== undefined && diffStyle !== "unified" && diffStyle !== "side-by-side")
          || (ignoreWhitespace !== undefined && typeof ignoreWhitespace !== "boolean")
          || (diffStyle === undefined && ignoreWhitespace === undefined)) {
          sendJson(res, 400, { ok: false, error: "Invalid preferences" });
          return;
        }
        sendJson(res, 200, { ok: true, ...savePreferences({
          ...(diffStyle === undefined ? {} : { diffStyle }),
          ...(ignoreWhitespace === undefined ? {} : { ignoreWhitespace }),
        }, preferencePath) });
        return;
      }

      if (method === "GET" && url.pathname === "/api/diffs") {
        const style = url.searchParams.get("style") === "unified" ? "unified" : "side-by-side";
        const ignoreWhitespace = url.searchParams.get("ignoreWhitespace") === "true";
        const documentId = url.searchParams.get("documentId");
        const selected = documents.filter((document) => document.id === documentId);
        if (!documentId || !selected.length) {
          sendJson(res, 400, { ok: false, error: "A valid documentId is required" });
          return;
        }
        const files = selected.flatMap((document) => (document.changes ?? []).map((change) => ({
          documentId: document.id,
          path: change.path,
          html: renderTurnFileDiffHtml(change, style, ignoreWhitespace),
        })));
        sendJson(res, 200, { changes: files.length, files });
        return;
      }

      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/plan") {
        sendJson(res, 200, {
          documents: renderedDocuments.map(({ changes, ...document }) => ({ ...document, hasChanges: Boolean(changes?.length) })),
          languages,
          mode,
          gate: gate ?? false,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/render-code") {
        const documentId = url.searchParams.get("documentId");
        const language = url.searchParams.get("language");
        const document = documents.find((candidate) => candidate.id === documentId);
        if (!document || document.kind !== "file" || !language || !languages.includes(language)) {
          sendJson(res, 400, { ok: false, error: "A valid file documentId and language are required" });
          return;
        }
        sendJson(res, 200, { html: renderCodeFile(document.markdown, language), language });
        return;
      }

      if (method === "POST" && url.pathname === "/api/feedback") {
        let body: unknown;
        try {
          body = await parseJsonBody(req);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            sendJson(res, 413, { ok: false, error: "Request body too large" });
            return;
          }
          if (err instanceof RequestTimeoutError) {
            sendJson(res, 408, { ok: false, error: "Request timeout" });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { ok: false, error: message });
          return;
        }

        const payload = body as Record<string, unknown>;
        const feedback = typeof payload.feedback === "string" ? payload.feedback : "";
        const annotations = Array.isArray(payload.annotations) ? payload.annotations as Annotation[] : [];

        resolveOnce({
          action: "feedback",
          feedback,
          annotations,
        });

        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/approve") {
        // Body is ignored for approve
        try {
          await parseJsonBody(req);
        } catch {
          // Ignore parse errors — body is optional
        }

        resolveOnce({ action: "approve" });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/exit") {
        // Body is ignored for exit
        try {
          await parseJsonBody(req);
        } catch {
          // Ignore parse errors — body is optional
        }

        resolveOnce({ action: "exit" });
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: message });
    }
  });

  let port = 0;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      server.removeAllListeners("error");
      port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address && typeof address === "object") {
            resolve(address.port);
          } else {
            reject(new Error("Failed to get server address"));
          }
        });
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  const url = `http://127.0.0.1:${port}`;

  const handle: AnnotationServerHandle = {
    url,
    stop: () => {
      server.close();
    },
    waitForDecision: () => decisionPromise,
    resolveDecision: resolveOnce,
  };

  return handle;
}
