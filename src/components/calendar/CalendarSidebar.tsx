import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useSortable, type Sortable } from "../../useSortable.ts";
import type { CalendarInfo, CalendarPerson, OtherCalendar } from "../../api.ts";
import { CheckIcon, PinIcon, SearchIcon, XIcon } from "../Icons.tsx";

const MAX_RESULTS = 7;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Box({ color, on }: { color: string; on: boolean }) {
  return (
    <i className={`cal-box ${on ? "on" : ""}`} style={{ "--ev": color } as CSSProperties}>
      {on && <CheckIcon />}
    </i>
  );
}

/**
 * The calendar's side list: your own calendars, and other people's and rooms'
 * calendars to lay beside them. A search result shows straight away and leaves
 * again when unticked; pinning keeps it in the list to switch on and off.
 */
export function CalendarSidebar({
  calendars,
  hidden,
  onToggleCalendar,
  canCompare,
  hasClient,
  onSetUpGoogle,
  people,
  pinned,
  passing,
  problems,
  onShow,
  onToggle,
  onPin,
  onMoveCalendar,
  onReorderPinned,
}: {
  onMoveCalendar: (from: number, to: number) => void;
  /** The pinned list in its new order: people first, then rooms. */
  onReorderPinned: (next: OtherCalendar[]) => void;
  calendars: CalendarInfo[];
  hidden: string[];
  onToggleCalendar: (id: string) => void;
  /** A Google account is connected, so other calendars can be fetched. */
  canCompare: boolean;
  hasClient: boolean;
  onSetUpGoogle: () => void;
  people: CalendarPerson[];
  pinned: OtherCalendar[];
  /** Shown from a search but not pinned; they leave the list when unticked. */
  passing: OtherCalendar[];
  problems: Record<string, string>;
  onShow: (person: { email: string; name: string; room: boolean }) => void;
  onToggle: (email: string) => void;
  onPin: (email: string) => void;
}) {
  const [query, setQuery] = useState("");
  const ownList = useRef<HTMLDivElement>(null);
  const pinnedList = useRef<HTMLDivElement>(null);
  const roomList = useRef<HTMLDivElement>(null);
  const isRoom = (o: OtherCalendar) => o.room ?? people.some((p) => p.room && p.email.toLowerCase() === o.email.toLowerCase());
  const pinnedPeople = pinned.filter((o) => !isRoom(o));
  const pinnedRooms = pinned.filter(isRoom);
  const reordered = (list: OtherCalendar[], from: number, to: number) => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  };
  const ownSort = useSortable({ count: calendars.length, listRef: ownList, itemSelector: ".cal-side-row", onMove: onMoveCalendar });
  const pinnedSort = useSortable({
    count: pinnedPeople.length,
    listRef: pinnedList,
    itemSelector: ".cal-side-row",
    onMove: (from, to) => onReorderPinned([...reordered(pinnedPeople, from, to), ...pinnedRooms]),
  });
  const roomSort = useSortable({
    count: pinnedRooms.length,
    listRef: roomList,
    itemSelector: ".cal-side-row",
    onMove: (from, to) => onReorderPinned([...pinnedPeople, ...reordered(pinnedRooms, from, to)]),
  });
  const sorting = (sort: Sortable, i: number) => ({
    className: `cal-side-row sortable ${sort.active === i ? "dragging" : ""}`,
    style: sort.itemStyle(i),
  });
  const text = query.trim().toLowerCase();
  const listed = useMemo(() => new Set([...pinned, ...passing].map((o) => o.email.toLowerCase())), [pinned, passing]);

  const results = useMemo(() => {
    if (text === "") return [];
    return people.filter((p) => !listed.has(p.email.toLowerCase()) && (p.name.toLowerCase().includes(text) || p.email.toLowerCase().includes(text))).slice(0, MAX_RESULTS);
  }, [people, listed, text]);

  const typedEmail = EMAIL.test(query.trim()) && !listed.has(text) && !results.some((r) => r.email.toLowerCase() === text) ? query.trim() : null;

  const show = (person: { email: string; name: string; room: boolean }) => {
    onShow(person);
    setQuery("");
  };

  const row = (other: OtherCalendar, sort: Sortable | null, index = -1) => {
    const isPinned = sort !== null;
    return (
    <div key={other.email} {...(sort ? sorting(sort, index) : { className: "cal-side-row" })}>
      <button className="cal-side-main" data-sort-handle title={problems[other.email] ?? other.email} onClick={() => onToggle(other.email)} {...(sort ? sort.handleProps(index) : {})}>
        <Box color={other.color} on={other.shown} />
        <span>{other.name}</span>
        {problems[other.email] && <em>!</em>}
      </button>
      <button className={`cal-side-pin ${isPinned ? "on" : ""}`} aria-label={isPinned ? `Unpin ${other.name}` : `Pin ${other.name}`} title={isPinned ? "Unpin" : "Pin to keep in this list"} onClick={() => onPin(other.email)}>
        <PinIcon filled={isPinned} />
      </button>
    </div>
    );
  };

  return (
    <aside className="panel cal-side">
      <h3>My calendars</h3>
      <div ref={ownList}>
        {calendars.map((c, i) => (
          <div key={c.id} {...sorting(ownSort, i)}>
            <button className="cal-side-main" data-sort-handle title={c.account} onClick={() => onToggleCalendar(c.id)} {...ownSort.handleProps(i)}>
              <Box color={c.color ?? "var(--accent)"} on={!hidden.includes(c.id)} />
              <span>{c.title}</span>
            </button>
          </div>
        ))}
      </div>

      <h3>Other calendars</h3>
      {!canCompare && hasClient && <p className="cal-side-note">Connect a Google account in the ⋯ menu to lay colleagues' and rooms' calendars beside yours.</p>}
      {!canCompare && !hasClient && (
        <p className="cal-side-note">
          Colleagues' and rooms' calendars come from Google, which needs a one-time setup.{" "}
          <button className="link-btn inline" onClick={onSetUpGoogle}>Set up Google</button>
        </p>
      )}
      {canCompare && (
        <>
          <label className="cal-side-search">
            <SearchIcon />
            <input value={query} placeholder="Search people and rooms" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              if (e.key !== "Enter") return;
              if (results[0]) show(results[0]);
              else if (typedEmail) show({ email: typedEmail, name: typedEmail, room: false });
            }} />
            {query && <button aria-label="Clear search" onClick={() => setQuery("")}><XIcon /></button>}
          </label>
          {text !== "" && (
            <div className="cal-side-results">
              {results.map((p) => (
                <button key={p.email} title={p.email} onClick={() => show(p)}>
                  <span>{p.name}</span>
                  {p.room && <em>room</em>}
                </button>
              ))}
              {typedEmail && (
                <button onClick={() => show({ email: typedEmail, name: typedEmail, room: false })}>
                  <span>Show {typedEmail}</span>
                </button>
              )}
              {results.length === 0 && !typedEmail && <p className="cal-side-note">Nobody by that name on your events. Type a full email address to look someone up.</p>}
            </div>
          )}
          {passing.map((o) => row(o, null))}
          {pinnedPeople.length > 0 && <div className="cal-side-group">People</div>}
          <div ref={pinnedList}>{pinnedPeople.map((o, i) => row(o, pinnedSort, i))}</div>
          {pinnedRooms.length > 0 && <div className="cal-side-group">Rooms</div>}
          <div ref={roomList}>{pinnedRooms.map((o, i) => row(o, roomSort, i))}</div>
          {pinned.length === 0 && passing.length === 0 && text === "" && <p className="cal-side-note">Search for a colleague or a room to compare calendars. Pin the ones you look at often.</p>}
        </>
      )}
    </aside>
  );
}
