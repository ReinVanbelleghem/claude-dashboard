import type { PrSummary } from "../shared/pr.ts";
import type { StackLayer, WorkspaceStack } from "../shared/stacks.ts";
import { branchRef, layerState, originRepo, repoStatus, worktrees } from "./git.ts";
import { stackPrs } from "./prs.ts";

/**
 * The stack a checkout's branch belongs to: what GitHub says about the pull
 * requests, joined to what the local repository has of each branch.
 *
 * The pull requests order the stack; git answers everything about a layer's own
 * changes, so a layer can be diffed without leaving the machine.
 */

const stripRemote = (ref: string) => ref.replace(/^origin\//, "");

export async function workspaceStack(cwd: string, refresh = false): Promise<WorkspaceStack> {
  const status = await repoStatus(cwd);
  const trunk = status.base ? stripRemote(status.base) : null;
  const empty = (error: string | null): WorkspaceStack => ({ repo: null, trunk, layers: [], error, fetchedAt: Date.now() });
  if (!status.isRepo || !status.root) return empty("not a git repository");
  const root = status.root;
  const branch = status.branch;
  if (!branch || status.onBase) return empty(null);

  const repo = await originRepo(root);
  let prs: PrSummary[] = [];
  let error: string | null = null;
  if (repo) {
    try {
      prs = await stackPrs(repo.owner, repo.repo, branch, refresh, trunk);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const chain: { branch: string; baseBranch: string; pr: PrSummary | null }[] = prs.map((pr) => ({
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    pr,
  }));
  if (!chain.some((c) => c.branch === branch)) {
    const above = chain.findIndex((c) => c.baseBranch === branch);
    const own = { branch, baseBranch: trunk ?? "", pr: null };
    if (above === -1) chain.push(own);
    else chain.splice(above, 0, own);
  }

  const trees = (await worktrees(root)).worktrees;
  const layers: StackLayer[] = await Promise.all(
    chain.map(async (c): Promise<StackLayer> => {
      const [ref, baseRef] = await Promise.all([
        c.branch === branch ? Promise.resolve(branch) : branchRef(root, c.branch),
        !c.baseBranch ? Promise.resolve(null) : c.baseBranch === trunk && status.base ? Promise.resolve(status.base) : branchRef(root, c.baseBranch),
      ]);
      const state = ref && baseRef ? await layerState(root, baseRef, ref) : { commits: 0, needsRebase: false };
      return {
        branch: c.branch,
        ref,
        baseBranch: c.baseBranch,
        baseRef,
        pr: c.pr,
        checkout: trees.find((t) => t.branch === c.branch && !t.prunable)?.path ?? null,
        current: c.branch === branch,
        commits: state.commits,
        needsRebase: state.needsRebase,
      };
    }),
  );
  return { repo, trunk, layers, error, fetchedAt: Date.now() };
}
