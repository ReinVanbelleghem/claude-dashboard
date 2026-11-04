import { useEffect, useRef, useState } from "react";
import { agentApi, type SlashCommand } from "../api.ts";
import { rankCommands, slashTokenAt } from "./Conversation.tsx";

/**
 * A prompt textarea with the composer's slash menu, for places that have no
 * session yet: a template's first prompt. The commands come from the daemon's
 * record of what the last session reported, which is the same list a new session
 * will see, short of a skill added since.
 */
export function PromptBox({
  value,
  onChange,
  placeholder,
  rows = 5,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    agentApi
      .commands()
      .then((r) => setCommands(r.commands))
      .catch(() => {});
  }, []);

  const token = slashTokenAt(value, caret);
  const open = token !== null && dismissed !== token.start;
  const matches = open && token ? rankCommands(commands, token.word).slice(0, 8) : [];

  useEffect(() => setHighlight(0), [token?.word]);

  const complete = (c: SlashCommand) => {
    if (!token) return;
    const before = value.slice(0, token.start);
    const after = value.slice(caret);
    const next = `${before}/${c.name} ${after}`;
    onChange(next);
    const pos = token.start + c.name.length + 2;
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = pos;
      setCaret(pos);
    });
  };

  return (
    <div className="composer-wrap">
      {matches.length > 0 && (
        <div className="cmd-menu">
          {matches.map((c, n) => (
            <button
              key={c.name}
              type="button"
              className={`cmd-option ${n === highlight ? "active" : ""}`}
              onMouseEnter={() => setHighlight(n)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => complete(c)}
            >
              <span className="cmd-option-name">/{c.name}</span>
              {c.argumentHint && <span className="cmd-option-hint">{c.argumentHint}</span>}
              <span className="cmd-option-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        className={className}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setDismissed(null);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(matches.length - 1, h + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(0, h - 1));
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            complete(matches[highlight] ?? matches[0]!);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (token) setDismissed(token.start);
          }
        }}
      />
    </div>
  );
}
