import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Availability, CalendarPerson } from "../../api.ts";
import { BuildingIcon, XIcon } from "../Icons.tsx";

const MAX_SUGGESTIONS = 6;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AVAILABILITY_LABEL: Record<Availability, string> = { free: "Free", busy: "Busy", unknown: "" };
const AVAILABILITY_RANK: Record<Availability, number> = { free: 0, unknown: 1, busy: 2 };

/**
 * Pick people or rooms by typing a few letters. Suggestions come from who has
 * been on your events before; each choice shows whether it is free at the
 * chosen time once Google has answered.
 */
export function PeoplePicker({
  people,
  selected,
  onChange,
  availability,
  placeholder,
  colors = {},
  allowAnyEmail = false,
  rankByAvailability = false,
}: {
  people: CalendarPerson[];
  selected: string[];
  onChange: (emails: string[]) => void;
  availability: Record<string, Availability>;
  placeholder: string;
  /** The colour each person or room has in the sidebar, by address; their chip takes it. */
  colors?: Record<string, string>;
  /** Let a typed address be added even when nobody by that address is known. */
  allowAnyEmail?: boolean;
  /** Put free choices first, for rooms where any free one will do. */
  rankByAvailability?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const byEmail = useMemo(() => new Map(people.map((p) => [p.email.toLowerCase(), p])), [people]);

  const suggestions = useMemo(() => {
    const text = query.trim().toLowerCase();
    const taken = new Set(selected.map((e) => e.toLowerCase()));
    const matches = people.filter((p) => !taken.has(p.email.toLowerCase()) && (text === "" || p.name.toLowerCase().includes(text) || p.email.toLowerCase().includes(text)));
    const ranked = rankByAvailability
      ? [...matches].sort((a, b) => AVAILABILITY_RANK[availability[a.email] ?? "unknown"] - AVAILABILITY_RANK[availability[b.email] ?? "unknown"])
      : matches;
    return ranked.slice(0, MAX_SUGGESTIONS);
  }, [people, selected, query, availability, rankByAvailability]);

  const add = (email: string) => {
    onChange([...selected, email]);
    setQuery("");
    setCursor(0);
  };

  const typed = query.trim();
  const canAddTyped = allowAnyEmail && EMAIL.test(typed) && !selected.includes(typed);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (suggestions.length ? (c + step + suggestions.length) % suggestions.length : 0));
    } else if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      const pick = suggestions[cursor];
      if (typed === "") return;
      if (pick) {
        e.preventDefault();
        add(pick.email);
      } else if (canAddTyped) {
        e.preventDefault();
        add(typed);
      } else if (e.key === "Enter") {
        e.preventDefault();
      }
    } else if (e.key === "Backspace" && query === "" && selected.length) {
      onChange(selected.slice(0, -1));
    }
  };

  const open = focused && (suggestions.length > 0 || canAddTyped) && (typed !== "" || rankByAvailability);

  return (
    <div className="cal-people">
      <div className="cal-people-box search">
        {selected.map((email) => {
          const state = availability[email] ?? "unknown";
          const person = byEmail.get(email.toLowerCase());
          const tint = colors[email.toLowerCase()];
          return (
            <span
              className={`cal-person ${state}`}
              key={email}
              title={AVAILABILITY_LABEL[state] ? `${AVAILABILITY_LABEL[state]} at this time` : undefined}
              style={tint ? ({ "--ev": tint } as CSSProperties) : undefined}
            >
              {person?.room ? <BuildingIcon /> : <i />}
              {person?.name ?? email}
              {state === "busy" && <em>busy</em>}
              <button type="button" aria-label={`Remove ${email}`} onClick={() => onChange(selected.filter((e) => e !== email))}><XIcon /></button>
            </span>
          );
        })}
        <input
          value={query}
          placeholder={selected.length ? "" : placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>
      {open && (
        <div className="cal-people-list" role="listbox">
          {suggestions.map((p, i) => {
            const state = availability[p.email] ?? "unknown";
            return (
              <button
                type="button"
                role="option"
                aria-selected={i === cursor}
                className={i === cursor ? "on" : ""}
                key={p.email}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(p.email)}
              >
                {p.room && <BuildingIcon />}
                <span>{p.name}</span>
                {!p.room && p.name !== p.email && <small>{p.email}</small>}
                {AVAILABILITY_LABEL[state] && <em className={state}>{AVAILABILITY_LABEL[state]}</em>}
              </button>
            );
          })}
          {suggestions.length === 0 && canAddTyped && (
            <button type="button" className="on" onMouseDown={(e) => e.preventDefault()} onClick={() => add(typed)}>
              <span>Invite {typed}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
