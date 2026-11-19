import type { EventStatus } from "../../../shared/calendar.ts";
import { BuildingIcon, CalendarOffIcon, HeadphonesIcon, HomeIcon, PinIcon } from "../Icons.tsx";

/** The round mark Google puts in front of time away, focus time and where you work that day. */
export function StatusMark({ status }: { status: EventStatus | undefined }) {
  if (!status) return null;
  return <i className={`cal-status-mark ${status.kind}`}>{icon(status)}</i>;
}

function icon(status: EventStatus) {
  if (status.kind === "outOfOffice") return <CalendarOffIcon />;
  if (status.kind === "focusTime") return <HeadphonesIcon />;
  if (status.location?.type === "office") return <BuildingIcon />;
  if (status.location?.type === "custom") return <PinIcon />;
  return <HomeIcon />;
}
