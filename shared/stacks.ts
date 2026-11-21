import type { PrSummary } from "./pr.ts";

/**
 * A stack: the chain of branches a change is split over, bottom first. Each
 * layer is compared with the one below it rather than with trunk, so a layer
 * shows only what its own pull request introduces.
 */
export type StackLayer = {
  branch: string;
  /** The ref git can read for this branch: the local branch, else its remote copy, else null. */
  ref: string | null;
  /** The branch this layer builds on: the layer below, or trunk for the bottom one. */
  baseBranch: string;
  baseRef: string | null;
  pr: PrSummary | null;
  /** The checkout that has this branch out, when there is one. */
  checkout: string | null;
  current: boolean;
  /** Commits this layer adds on top of its base. */
  commits: number;
  /** The base has moved on since this layer was cut from it. */
  needsRebase: boolean;
};

export type WorkspaceStack = {
  repo: { owner: string; repo: string } | null;
  trunk: string | null;
  /** Bottom first. One layer when the branch is not part of a stack; empty on trunk. */
  layers: StackLayer[];
  /** Why the pull requests could not be read, when they could not. The local layer still shows. */
  error: string | null;
  fetchedAt: number;
};

/** The two refs a layer's own changes lie between. */
export type DiffRange = { base: string; head: string };

export const rangeOfLayer = (l: Pick<StackLayer, "ref" | "baseRef">): DiffRange | null =>
  l.ref && l.baseRef ? { base: l.baseRef, head: l.ref } : null;
