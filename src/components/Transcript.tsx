import { useState } from "react";
import type { SessionDetail } from "../api.ts";
import { Markdown } from "./Markdown.tsx";

export type TurnRow = SessionDetail["turns"][number];

/** Replies run long; clamp each one and let the reader open the ones they want. */
const CLAMP_CHARS = 1400;

/**
 * A slash command reaches the transcript as the expanded envelope Claude Code
 * sends, not as the "/foo bar" the user typed:
 *
 *   <command-message>code-review</command-message>
 *   <command-name>/code-review</command-name>
 *   <command-args>my code to check if all is good</command-args>
 *
 * Rendering that verbatim is noise, so pull it apart and show a chip instead.
 * Anything outside the envelope is returned as the remaining body.
 */
type Command = { name: string; args: string | null };

function parseCommand(text: string): { command: Command | null; body: string } {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (!name) return { command: null, body: text };
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const body = text
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, "$1")
    .trim();
  return {
    command: {
      name: name[1].trim().replace(/^\/?/, "/"),
      args: args?.[1].trim() || null,
    },
    body,
  };
}

function CommandChip({ command }: { command: Command }) {
  return (
    <div className="cmd">
      <span className="cmd-slash">/</span>
      <span className="cmd-name">{command.name.replace(/^\//, "")}</span>
      {command.args && <span className="cmd-args">{command.args}</span>}
    </div>
  );
}

export function Turn({ turn }: { turn: TurnRow }) {
  const [open, setOpen] = useState(false);
  const { command, body } = turn.role === "user" ? parseCommand(turn.text) : { command: null, body: turn.text };
  const long = body.length > CLAMP_CHARS;
  const shown = long && !open ? `${body.slice(0, CLAMP_CHARS)}…` : body;

  return (
    <div className={`turn ${turn.role}`}>
      <div className="turn-head">
        <span className="turn-who">{turn.role === "user" ? "You" : "Claude"}</span>
        {turn.ts && <time>{new Date(turn.ts).toLocaleString()}</time>}
      </div>
      {command && <CommandChip command={command} />}
      {shown && (turn.role === "user" ? <div className="turn-plain">{shown}</div> : <Markdown text={shown} />)}
      {long && (
        <button className="link-btn" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show more (${Math.round(body.length / 1000)}k chars)`}
        </button>
      )}
    </div>
  );
}

export function Transcript({ turns }: { turns: TurnRow[] }) {
  const [onlyPrompts, setOnlyPrompts] = useState(false);
  const shown = onlyPrompts ? turns.filter((t) => t.role === "user") : turns;

  return (
    <>
      <div className="panel-head">
        <h2>Transcript ({shown.length})</h2>
        <div className="seg">
          <button className={onlyPrompts ? "" : "active"} onClick={() => setOnlyPrompts(false)}>
            Conversation
          </button>
          <button className={onlyPrompts ? "active" : ""} onClick={() => setOnlyPrompts(true)}>
            My prompts only
          </button>
        </div>
      </div>
      <p className="hint">
        What you typed and what Claude replied — tool calls, tool results, thinking and images are
        excluded.
      </p>
      {shown.length === 0 ? (
        <div className="empty">Nothing recorded.</div>
      ) : (
        shown.map((t) => <Turn key={t.uuid} turn={t} />)
      )}
    </>
  );
}
