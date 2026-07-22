import type { HermesAddMcpServerPayload } from "./client";
import { emptyDraft, validateDraft, type McpServerDraft } from "./mcp-servers-view";

export type McpConfigImportSource = "Claude or Cursor" | "Codex" | "JSON";

export type McpConfigImportEntry = {
  name: string;
  payload?: HermesAddMcpServerPayload;
  warnings: string[];
  error?: string;
};

export type McpConfigImportResult = {
  source: McpConfigImportSource;
  entries: McpConfigImportEntry[];
  error?: string;
};

/**
 * Parses the two MCP configuration families people most often already have:
 * Claude/Cursor JSON (`mcpServers`) and Codex TOML (`mcp_servers`). The TOML
 * reader is deliberately narrow. It only reads MCP tables and ignores every
 * unrelated Codex setting rather than trying to be a general TOML parser.
 */
export function parseExternalMcpConfig(raw: string): McpConfigImportResult {
  const text = raw.trim();
  if (!text) return { source: "JSON", entries: [], error: "Paste an MCP configuration first." };

  if (text.startsWith("{")) {
    return parseJsonConfig(text);
  }
  return parseCodexToml(text);
}

function parseJsonConfig(text: string): McpConfigImportResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      source: "JSON",
      entries: [],
      error: "This is not valid JSON. Paste the complete configuration, including braces.",
    };
  }

  const root = recordOf(value);
  const camel = recordOf(root?.mcpServers);
  const snake = recordOf(root?.mcp_servers);
  const servers = camel ?? snake;
  if (!servers) {
    return {
      source: "JSON",
      entries: [],
      error: "No MCP servers were found. Expected an mcpServers or mcp_servers object.",
    };
  }

  return {
    source: camel ? "Claude or Cursor" : "JSON",
    entries: Object.entries(servers).map(([name, config]) => importEntry(name, config)),
  };
}

function parseCodexToml(text: string): McpConfigImportResult {
  const servers: Record<string, Record<string, unknown>> = {};
  let current: { name: string; child?: "env" } | undefined;

  for (const line of logicalTomlLines(text)) {
    const table = /^\[\s*mcp_servers\.(.+?)\s*\]$/.exec(line);
    if (table) {
      const path = splitTomlPath(table[1]);
      const name = path[0];
      if (!name || path.length > 2 || (path[1] && path[1] !== "env")) {
        current = undefined;
        continue;
      }
      servers[name] ??= {};
      current = { name, child: path[1] === "env" ? "env" : undefined };
      continue;
    }

    if (line.startsWith("[")) {
      current = undefined;
      continue;
    }
    if (!current) continue;

    const assignment = splitTomlAssignment(line);
    if (!assignment) continue;
    const [key, valueText] = assignment;
    const parsed = parseTomlValue(valueText);
    if (parsed === undefined) continue;
    if (current.child === "env") {
      const env = recordOf(servers[current.name].env) ?? {};
      env[unquoteToml(key.trim())] = parsed;
      servers[current.name].env = env;
    } else {
      servers[current.name][unquoteToml(key.trim())] = parsed;
    }
  }

  const entries = Object.entries(servers).map(([name, config]) => importEntry(name, config));
  return entries.length > 0
    ? { source: "Codex", entries }
    : {
        source: "Codex",
        entries: [],
        error: "No Codex MCP tables were found. Expected a table like [mcp_servers.example].",
      };
}

/** Joins multiline arrays and inline tables before the narrow MCP parser sees
 * them. This covers the common hand-formatted Codex config style without
 * pulling unrelated TOML settings into the import. */
function logicalTomlLines(text: string): string[] {
  const lines: string[] = [];
  let buffer = "";
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const sourceLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(sourceLine).trim();
    if (!line && !buffer) continue;
    buffer = buffer ? `${buffer} ${line}` : line;

    for (const char of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = quote === char ? undefined : (quote ?? char);
        continue;
      }
      if (quote) continue;
      if (char === "[" || char === "{") depth += 1;
      if (char === "]" || char === "}") depth -= 1;
    }

    if (!quote && depth <= 0) {
      if (buffer.trim()) lines.push(buffer.trim());
      buffer = "";
      depth = 0;
    }
  }
  if (buffer.trim()) lines.push(buffer.trim());
  return lines;
}

function importEntry(name: string, rawConfig: unknown): McpConfigImportEntry {
  const config = recordOf(rawConfig);
  if (!config) return { name, warnings: [], error: "This server configuration is not an object." };

  const warnings: string[] = [];
  const command = stringOf(config.command);
  const url = stringOf(config.url);
  const transport = command ? "stdio" : "http";
  const draft: McpServerDraft = {
    ...emptyDraft(transport),
    name,
    command: command ?? "",
    args: stringArrayOf(config.args),
    env: pairsOf(config.env),
    url: url ?? "",
    headers: pairsOf(config.headers ?? config.http_headers),
    auth: normalizeAuth(config.auth),
  };

  if (!command && !url) {
    return { name, warnings, error: "Add either a command or URL before importing this server." };
  }
  if (command && url) {
    return {
      name,
      warnings,
      error: "This entry has both a command and URL, so June cannot choose a transport safely.",
    };
  }
  if (config.bearer_token_env_var || config.env_http_headers) {
    return {
      name,
      warnings,
      error:
        "This server references HTTP credentials from environment variables. Add it manually so June can store the credential safely.",
    };
  }
  if (config.env_vars) {
    warnings.push(
      "Forwarded environment variable names are not imported. Add any required values after setup.",
    );
  }
  if (config.enabled === false) {
    warnings.push("This server was disabled in the source app. June will add it enabled.");
  }

  const validation = validateDraft(draft);
  if (!validation.ok) {
    return {
      name,
      warnings,
      error: Object.values(validation.errors)[0] ?? "This server could not be imported.",
    };
  }
  return { name, payload: validation.payload, warnings };
}

function normalizeAuth(value: unknown): McpServerDraft["auth"] {
  return value === "oauth" || value === "bearer" ? value : "none";
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function pairsOf(value: unknown): Array<{ key: string; value: string }> {
  const record = recordOf(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, item]) =>
    typeof item === "string" ? [{ key, value: item }] : [],
  );
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = quote === char ? undefined : (quote ?? char);
      continue;
    }
    if (char === "#" && !quote) return line.slice(0, index);
  }
  return line;
}

function splitTomlAssignment(line: string): [string, string] | undefined {
  let quote: '"' | "'" | undefined;
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' || char === "'") quote = quote === char ? undefined : (quote ?? char);
    if (quote) continue;
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (char === "=" && depth === 0) return [line.slice(0, index), line.slice(index + 1)];
  }
  return undefined;
}

function splitTomlPath(path: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const char of path) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote === '"') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = quote === char ? undefined : (quote ?? char);
      current += char;
    } else if (char === "." && !quote) {
      parts.push(unquoteToml(current.trim()));
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(unquoteToml(current.trim()));
  return parts;
}

function unquoteToml(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitTomlList(trimmed.slice(1, -1)).map((item) => parseTomlValue(item));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const result: Record<string, unknown> = {};
    for (const item of splitTomlList(trimmed.slice(1, -1))) {
      const assignment = splitTomlAssignment(item);
      if (!assignment) continue;
      result[unquoteToml(assignment[0])] = parseTomlValue(assignment[1]);
    }
    return result;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

function splitTomlList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let depth = 0;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote === '"') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") quote = quote === char ? undefined : (quote ?? char);
    if (!quote && (char === "[" || char === "{")) depth += 1;
    if (!quote && (char === "]" || char === "}")) depth -= 1;
    if (char === "," && !quote && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
