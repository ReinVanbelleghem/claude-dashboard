import { StatusMark } from "./StatusMark.tsx";
import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { CalendarEvent } from "../../api.ts";
import { whenText } from "./dates.ts";

const SHOW_DELAY_MS = 280;
const GAP_PX = 8;
const EDGE_PX = 8;

type Hover = { event: CalendarEvent; anchor: DOMRect };

function EventHoverCard({ event, anchor }: Hover) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const { width, height } = card.getBoundingClientRect();
    const fitsRight = anchor.right + GAP_PX + width <= window.innerWidth - EDGE_PX;
    const left = fitsRight ? anchor.right + GAP_PX : Math.max(EDGE_PX, anchor.left - GAP_PX - width);
    const top = Math.min(Math.max(anchor.top, EDGE_PX), window.innerHeight - height - EDGE_PX);
    setPlace({ top, left });
  }, [anchor]);

  const guests = event.attendees.filter((a) => !a.room).length;
  const style = { top: place?.top ?? 0, left: place?.left ?? 0, visibility: place ? "visible" : "hidden", "--ev": event.color ?? "var(--accent)" } as CSSProperties;

  return createPortal(
    <div className="cal-hover" ref={ref} role="tooltip" style={style}>
      <b>
        <StatusMark status={event.status} />
        {event.title}
      </b>
      <span>{whenText(event)}</span>
      <span className="cal-hover-cal">
        <i className="cal-dot" />
        {event.calendar}
        {event.account && event.account !== event.calendar ? ` · ${event.account}` : ""}
      </span>
      {event.location && <span>{event.location}</span>}
      {guests > 0 && <span>{guests} {guests === 1 ? "guest" : "guests"}</span>}
    </div>,
    document.body,
  );
}

/** A small card with an event's name, time and place, shown after resting the pointer on it. */
export function useEventHover() {
  const [hover, setHover] = useState<Hover | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const hide = () => {
    window.clearTimeout(timer.current);
    setHover(null);
  };

  const bind = (event: CalendarEvent) => ({
    onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => {
      const element = e.currentTarget;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setHover({ event, anchor: element.getBoundingClientRect() }), SHOW_DELAY_MS);
    },
    onPointerLeave: hide,
  });

  return { bind, hide, card: hover ? <EventHoverCard {...hover} /> : null };
}
