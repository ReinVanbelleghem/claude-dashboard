import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventDraft, Proposal } from "../shared/calendar.ts";
import { createGoogleEvent } from "./google.ts";
import { createMacEvent } from "./macCalendar.ts";
import { DATA_DIR } from "./paths.ts";

const STORE_PATH = join(DATA_DIR, "calendar-proposals.json");

let proposals: Proposal[] | null = null;

function all(): Proposal[] {
  if (proposals) return proposals;
  try {
    proposals = existsSync(STORE_PATH) ? (JSON.parse(readFileSync(STORE_PATH, "utf8")) as Proposal[]) : [];
  } catch {
    proposals = [];
  }
  return proposals;
}

function keep(next: Proposal[]) {
  proposals = next;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(next, null, 2));
}

export const listProposals = (): Proposal[] => all();

/** A meeting someone suggested, held as a draft on the calendar until it is approved or discarded. */
export function addProposal(draft: EventDraft, now = Date.now()): Proposal {
  const proposal: Proposal = { ...draft, id: randomBytes(6).toString("hex"), createdAt: now };
  keep([...all(), proposal]);
  return proposal;
}

export function updateProposal(id: string, patch: Partial<EventDraft>): Proposal | null {
  const current = all().find((p) => p.id === id);
  if (!current) return null;
  const next = { ...current, ...patch, id, createdAt: current.createdAt };
  keep(all().map((p) => (p.id === id ? next : p)));
  return next;
}

export function discardProposal(id: string): boolean {
  const before = all().length;
  keep(all().filter((p) => p.id !== id));
  return all().length < before;
}

/** Turn a draft into a real event. It stays a draft if creating it fails. */
export async function approveProposal(id: string): Promise<{ viaGoogle: boolean } | null> {
  const proposal = all().find((p) => p.id === id);
  if (!proposal) return null;
  const { id: _id, createdAt: _createdAt, ...draft } = proposal;
  if (draft.google) await createGoogleEvent(draft);
  else await createMacEvent(draft);
  discardProposal(id);
  return { viaGoogle: draft.google !== undefined };
}
