import { useEffect, useState, type PointerEvent, type ReactNode } from "react";
import { artifactApi, type Artifact } from "../api.ts";
import { artifactSlugOf } from "../../shared/artifacts.ts";
import { ArtifactIcon, ExternalIcon } from "./Icons.tsx";

type Found = { artifact: Artifact; href: string };

/** Looks an artifact up by the key sessions are opened with; null while loading, false once it is known to be gone. */
export function useArtifact(key: string): Found | null | false {
  const [found, setFound] = useState<Found | null | false>(null);
  useEffect(() => {
    let stale = false;
    setFound(null);
    artifactApi
      .list()
      .then((r) => {
        if (stale) return;
        const artifact = r.artifacts.find((a) => a.slug === artifactSlugOf(key));
        setFound(artifact && !artifact.missing ? { artifact, href: artifactApi.url(artifact.slug, r.port) } : false);
      })
      .catch(() => !stale && setFound(false));
    return () => {
      stale = true;
    };
  }, [key]);
  return found;
}

/** The page itself, sandboxed to an opaque origin so its scripts cannot reach the dashboard. */
function ArtifactFrame({ found }: { found: Found }) {
  return <iframe className="art-frame" src={found.href} title={found.artifact.title} sandbox="allow-scripts allow-popups" />;
}

/** An artifact where a session would be: the header a drawer or tile expects, then the page. */
export function ArtifactPanel({
  id,
  onHeadPointerDown,
  headStart,
}: {
  id: string;
  onHeadPointerDown?: (e: PointerEvent) => void;
  headStart?: ReactNode;
}) {
  const found = useArtifact(id);
  return (
    <>
      <div className="drawer-head term-head kind-artifact" onPointerDown={onHeadPointerDown}>
        {headStart}
        <h3>
          <ArtifactIcon /> {found ? found.artifact.title : "Artifact"}
        </h3>
        <div className="drawer-actions">
          {found && (
            <a className="icon-btn tiny" href={found.href} target="_blank" rel="noreferrer" title="Open in a browser tab">
              <ExternalIcon /> Open in tab
            </a>
          )}
        </div>
      </div>
      {found && <p className="term-sub">{found.artifact.entry}</p>}
      {found === false && <div className="empty">This artifact is no longer on disk.</div>}
      {found && <ArtifactFrame found={found} />}
    </>
  );
}

/** An artifact on a page of its own, filling the window the way a session's conversation does. */
export function ArtifactPage({ id, onBack }: { id: string; onBack: () => void }) {
  const found = useArtifact(id);
  return (
    <div className="page session-chat">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack}>
          ← Back
        </button>
        <div>
          <h1>{found ? found.artifact.title : "Artifact"}</h1>
          <p className="page-sub">{found ? found.artifact.entry : ""}</p>
        </div>
        <span style={{ flex: 1 }} />
        {found && (
          <a className="icon-btn" href={found.href} target="_blank" rel="noreferrer">
            <ExternalIcon /> Open in tab
          </a>
        )}
      </div>
      {found === false && <div className="empty">This artifact is no longer on disk.</div>}
      <div className="session-cols">
        <div className="session-main">{found && <div className="panel art-page"><ArtifactFrame found={found} /></div>}</div>
      </div>
    </div>
  );
}
