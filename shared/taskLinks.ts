/**
 * Links on a task: where the work lives (a pull request, a Slack thread, a
 * Notion page). Shared by the daemon, which collects them, and the Tasks page,
 * which shows each as the mark of the service it points at.
 */
export type LinkService = "github" | "slack" | "notion" | "gmail" | "google" | "linear" | "figma" | "link";

export type LinkInfo = {
  service: LinkService;
  /** Short enough for a chip: "backend#17928", "Slack", "notion.so". */
  label: string;
  /** What the link is, for the tooltip: "GitHub pull request", "Slack message". */
  kind: string;
};

export const MAX_TASK_LINKS = 10;

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

/** Every http(s) address in a piece of text, without the punctuation a sentence leaves on the end. */
export function extractUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

/** A list of links as stored: real http(s) addresses, no repeats, capped. */
export function cleanLinks(links: unknown): string[] {
  if (!Array.isArray(links)) return [];
  const out: string[] = [];
  for (const raw of links) {
    if (typeof raw !== "string") continue;
    const url = raw.trim();
    if (!/^https?:\/\/\S+$/.test(url) || url.length > 2000 || out.includes(url)) continue;
    out.push(url);
    if (out.length === MAX_TASK_LINKS) break;
  }
  return out;
}

export function linkInfo(url: string): LinkInfo {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "");
    path = u.pathname;
  } catch {
    return { service: "link", label: url.slice(0, 40), kind: "Link" };
  }

  if (host === "github.com" || host.endsWith(".github.com")) {
    const m = path.match(/^\/([^/]+)\/([^/]+)(?:\/(pull|issues|commit|actions|discussions)\/([^/]+))?/);
    if (m?.[3] === "pull") return { service: "github", label: `${m[2]}#${m[4]}`, kind: "GitHub pull request" };
    if (m?.[3] === "issues") return { service: "github", label: `${m[2]}#${m[4]}`, kind: "GitHub issue" };
    if (m?.[3] === "commit") return { service: "github", label: `${m[2]}@${m[4]!.slice(0, 7)}`, kind: "GitHub commit" };
    if (m) return { service: "github", label: m[2]!, kind: "GitHub" };
    return { service: "github", label: "GitHub", kind: "GitHub" };
  }
  if (host.endsWith("slack.com")) {
    return { service: "slack", label: "Slack", kind: path.includes("/archives/") ? "Slack message" : "Slack" };
  }
  if (host.endsWith("notion.so") || host.endsWith("notion.com") || host.endsWith("notion.site")) {
    return { service: "notion", label: "Notion", kind: "Notion page" };
  }
  if (host === "mail.google.com") return { service: "gmail", label: "Gmail", kind: "Email" };
  if (host === "docs.google.com" || host === "drive.google.com" || host === "calendar.google.com" || host === "meet.google.com") {
    const what = host.startsWith("calendar") ? "Calendar" : host.startsWith("meet") ? "Meet" : path.startsWith("/spreadsheets") ? "Sheets" : path.startsWith("/presentation") ? "Slides" : host.startsWith("drive") ? "Drive" : "Docs";
    return { service: "google", label: what, kind: `Google ${what}` };
  }
  if (host === "linear.app") {
    const id = path.match(/\/issue\/([A-Z]+-\d+)/)?.[1];
    return { service: "linear", label: id ?? "Linear", kind: "Linear issue" };
  }
  if (host.endsWith("figma.com")) return { service: "figma", label: "Figma", kind: "Figma file" };
  return { service: "link", label: host, kind: "Link" };
}
