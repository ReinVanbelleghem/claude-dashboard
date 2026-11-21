import { useEffect, useState } from "react";
import { terminalApi } from "../../api.ts";
import { PlusIcon, TerminalIcon, XIcon } from "../Icons.tsx";
import { TerminalPane, useTerminal } from "../TerminalPane.tsx";
import { terminalIdOf } from "../../../shared/terminals.ts";

function DockTerminal({ id }: { id: string }) {
  const terminal = useTerminal(id);
  if (terminal === false) return <div className="empty">This terminal has ended.</div>;
  if (!terminal) return null;
  return <TerminalPane key={terminal.session} session={terminal.session} />;
}

/** The workspace's terminals along the bottom of the page, one at a time, the way an editor's panel holds them. */
export function TerminalDock({
  terminals,
  onNew,
  onHide,
}: {
  /** The workspace's shells: the key each is opened by, and what it is called. */
  terminals: { id: string; title: string }[];
  onNew: () => void;
  onHide: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const shown = terminals.find((t) => t.id === picked) ?? terminals[terminals.length - 1] ?? null;
  useEffect(() => {
    if (picked && !terminals.some((t) => t.id === picked)) setPicked(null);
  }, [terminals, picked]);

  return (
    <div className="wb-dock">
      <div className="wb-dock-tabs">
        <span className="wb-dock-label">
          <TerminalIcon /> Terminal
        </span>
        {terminals.map((t) => (
          <span key={t.id} className={`wb-dock-tab${shown?.id === t.id ? " on" : ""}`}>
            <button onClick={() => setPicked(t.id)}>{t.title}</button>
            <button
              className="wb-tab-close"
              title="End this terminal and whatever is running in it"
              aria-label={`End ${t.title}`}
              onClick={() => void terminalApi.close(terminalIdOf(t.id)).catch(() => {})}
            >
              <XIcon />
            </button>
          </span>
        ))}
        <button className="icon-btn ghost square" title="New terminal in this workspace" aria-label="New terminal" onClick={onNew}>
          <PlusIcon />
        </button>
        <span style={{ flex: 1 }} />
        <button className="icon-btn ghost square" title="Hide the panel" aria-label="Hide the panel" onClick={onHide}>
          <XIcon />
        </button>
      </div>
      <div className="wb-dock-body">
        {shown ? (
          <DockTerminal key={shown.id} id={shown.id} />
        ) : (
          <div className="empty">
            No terminal is open in this workspace.{" "}
            <button className="link-btn inline" onClick={onNew}>
              Start one
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
