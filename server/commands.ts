import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HOME } from "./paths.ts";

/**
 * Slash commands read off the disk, for when no session has reported the real
 * list yet: user skills under ~/.claude/skills, user commands under
 * ~/.claude/commands, and the skills and commands of every installed plugin,
 * namespaced the way the CLI names them (`plugin:skill`). Close to what a session
 * reports, minus the CLI's own built-ins.
 */
export type Command = { name: string; description: string; argumentHint?: string };

export function scanCommands(): Command[] {
  const out = new Map<string, Command>();
  const add = (c: Command) => {
    if (c.name && !out.has(c.name)) out.set(c.name, c);
  };

  for (const c of skillsIn(join(CLAUDE_HOME, "skills"))) add(c);
  for (const c of commandsIn(join(CLAUDE_HOME, "commands"))) add(c);

  for (const { name, path } of installedPlugins()) {
    for (const c of skillsIn(join(path, "skills"))) add({ ...c, name: `${name}:${c.name}` });
    for (const c of commandsIn(join(path, "commands"))) add({ ...c, name: `${name}:${c.name}` });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function skillsIn(dir: string): Command[] {
  if (!existsSync(dir)) return [];
  const out: Command[] = [];
  for (const entry of safeList(dir)) {
    const file = join(dir, entry, "SKILL.md");
    if (!existsSync(file)) continue;
    const fm = frontmatter(file);
    out.push({ name: fm.name || entry, description: fm.description, argumentHint: fm.argumentHint });
  }
  return out;
}

function commandsIn(dir: string): Command[] {
  if (!existsSync(dir)) return [];
  const out: Command[] = [];
  for (const entry of safeList(dir)) {
    if (!entry.endsWith(".md")) continue;
    const fm = frontmatter(join(dir, entry));
    out.push({ name: entry.slice(0, -3), description: fm.description, argumentHint: fm.argumentHint });
  }
  return out;
}

function installedPlugins(): { name: string; path: string }[] {
  try {
    const raw = JSON.parse(readFileSync(join(CLAUDE_HOME, "plugins", "installed_plugins.json"), "utf8")) as {
      plugins?: Record<string, { installPath?: string }[]>;
    };
    const seen = new Set<string>();
    const out: { name: string; path: string }[] = [];
    for (const [key, installs] of Object.entries(raw.plugins ?? {})) {
      const name = key.split("@")[0] ?? key;
      for (const i of installs) {
        if (!i.installPath || seen.has(i.installPath)) continue;
        seen.add(i.installPath);
        out.push({ name, path: i.installPath });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

/** `name`, `description` and `argument-hint` from a Markdown file's YAML frontmatter. */
function frontmatter(file: string): { name: string; description: string; argumentHint?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8").slice(0, 4096);
  } catch {
    return { name: "", description: "" };
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: "", description: "" };
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1]!.toLowerCase();
      const v = kv[2]!.trim();
      // A `>` or `|` starts a block scalar whose lines follow, indented.
      fields[key] = /^[>|][-+]?$/.test(v) ? "" : v.replace(/^["']|["']$/g, "");
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key] ?? ""} ${line.trim()}`.trim();
    }
  }
  const description = (fields.description ?? "").replace(/\s+/g, " ").trim();
  return {
    name: fields.name ?? "",
    description: description.length > 160 ? `${description.slice(0, 157)}…` : description,
    argumentHint: fields["argument-hint"] || undefined,
  };
}
