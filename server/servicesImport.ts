import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blankService,
  DEFAULT_RESTART_MAX,
  normalizeServicePaths,
  type Service,
  type ServicePaths,
} from "../shared/services.ts";

/**
 * A one-time import from an INI-style services file, for anyone moving a stack
 * over from a shell launcher. Opt-in: it only runs when DASHBOARD_SERVICES_IMPORT
 * names the file, on the first boot that finds no services in settings. After that
 * the dashboard owns them and the file is never read again.
 *
 * Format: a [paths] section with backend_main, frontend_main and worktrees_dir, then
 * one [service-key] section per service with label, repo, subdir, setup, layout,
 * includes, disabled, pane = Title | command (repeatable) and restart_on = Pane | pattern.
 */
const LEGACY_CONFIG = process.env.DASHBOARD_SERVICES_IMPORT ?? "";

const trim = (s: string) => s.trim();

/** Split "Title | command", the format both the pane and restart_on lines use. */
function splitPipe(value: string): [string, string] | null {
  const at = value.indexOf(" | ");
  return at === -1 ? null : [trim(value.slice(0, at)), trim(value.slice(at + 3))];
}

type LegacyPaths = { backendMain?: string; frontendMain?: string; worktreesDir?: string };

export function parseLegacyConfig(text: string): { services: Service[]; paths: LegacyPaths } {
  const services: Service[] = [];
  const paths: LegacyPaths = {};
  let section: string | null = null;
  let current: Service | null = null;

  for (const raw of text.split("\n")) {
    const line = trim(raw);
    if (!line || line.startsWith("#")) continue;

    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = trim(header[1]);
      if (section === "paths") {
        current = null;
      } else {
        current = services.find((s) => s.key === section) ?? null;
        if (!current) {
          current = blankService(section);
          services.push(current);
        }
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = trim(line.slice(0, eq));
    const value = trim(line.slice(eq + 1));

    if (section === "paths") {
      if (key === "backend_main") paths.backendMain = value;
      if (key === "frontend_main") paths.frontendMain = value;
      if (key === "worktrees_dir") paths.worktreesDir = value;
      continue;
    }
    if (!current) continue;

    switch (key) {
      case "label":
        current.label = value;
        break;
      case "repo":
        current.repo = value === "frontend" ? "frontend" : "backend";
        break;
      case "subdir":
        current.subdir = value;
        break;
      case "setup":
        current.setup = value;
        break;
      case "layout":
        current.layout = value === "split" || value === "tms-split" ? "split" : "tiled";
        break;
      case "includes":
        current.includes = value.split(",").map(trim).filter(Boolean);
        break;
      case "disabled":
        current.disabled = ["true", "1", "yes"].includes(value.toLowerCase());
        break;
      case "pane": {
        const parts = splitPipe(value);
        current.panes.push(parts ? { title: parts[0], cmd: parts[1] } : { title: value, cmd: "" });
        break;
      }
      case "restart_on": {
        const parts = splitPipe(value);
        current.restartOn.push(parts ? { pane: parts[0], pattern: parts[1] } : { pane: null, pattern: value });
        break;
      }
      case "restart_max": {
        const n = Number(value);
        current.restartMax = Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESTART_MAX;
        break;
      }
    }
  }

  for (const s of services) if (!s.label) s.label = s.key;
  return { services, paths };
}

/**
 * A sentence for the table's second line. The old format had no description, and a
 * service with only a key reads as a riddle, so one is built from what it does have.
 */
function describe(s: Service): string {
  if (s.includes.length) return `${s.includes.join(" + ")} together`;
  const where = s.subdir ? ` (${s.subdir})` : "";
  const ports = s.panes.flatMap((p) => [...p.cmd.matchAll(/(?::|--port[= ])(\d{4,5})\b/g)].map((m) => m[1]));
  if (ports.length) return `${s.panes.length === 1 ? "Runs on" : "Serves"} :${[...new Set(ports)].join(", :")}${where}`;
  return s.panes.length > 1 ? `${s.panes.length} processes${where}` : where.slice(2, -1);
}

export function importLegacyServices(): { services: Service[]; paths: ServicePaths } | null {
  if (!LEGACY_CONFIG || !existsSync(LEGACY_CONFIG)) return null;
  let text: string;
  try {
    text = readFileSync(LEGACY_CONFIG, "utf8");
  } catch {
    return null;
  }
  const { services, paths } = parseLegacyConfig(text);
  if (!services.length) return null;
  for (const s of services) if (!s.description) s.description = describe(s);
  return { services, paths: normalizeServicePaths(paths) };
}

export const legacyConfigPath = LEGACY_CONFIG;
