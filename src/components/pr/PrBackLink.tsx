import { useEffect, useState } from "react";
import { api, type SessionPrRun } from "../../api.ts";
import { GitIcon } from "../Icons.tsx";
import { prHash } from "./prState.ts";

export function PrBackLink({ sessionId, agentKey }: { sessionId: string; agentKey?: string | null }) {
  const [run, setRun] = useState<SessionPrRun | null>(null);

  useEffect(() => {
    let stale = false;
    setRun(null);
    api
      .sessionPrRun(sessionId, agentKey ?? null)
      .then((r) => !stale && setRun(r.run))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [sessionId, agentKey]);

  if (!run) return null;
  return (
    <a className="pr-back-link" href={prHash(run.pr, `/runs/${run.id}`)} title={`Back to the pull request: ${run.title}`}>
      <GitIcon />
      {run.pr.repo}#{run.pr.number}
    </a>
  );
}
