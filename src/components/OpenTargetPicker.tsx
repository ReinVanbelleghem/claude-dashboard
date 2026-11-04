import { DrawerOpenIcon, FullPageIcon, TileWindowIcon } from "./Icons.tsx";
import { Select } from "./Select.tsx";

export type OpenTarget = "drawer" | "page" | "tile";

const OPTIONS = [
  { value: "drawer", label: "Side drawer", hint: "Keeps you on the list", icon: <DrawerOpenIcon /> },
  { value: "page", label: "Full page", hint: "Room for the transcript, git and review", icon: <FullPageIcon /> },
  { value: "tile", label: "Floating tile", hint: "A movable, resizable window", icon: <TileWindowIcon /> },
];

/**
 * Where a session opens. The three destinations read faster as a little picture
 * each than as three sentences, so this is the shared Select with icons on.
 */
export function OpenTargetPicker({ value, onChange }: { value: OpenTarget; onChange: (v: OpenTarget) => void }) {
  return <Select value={value} options={OPTIONS} onChange={(v) => onChange(v as OpenTarget)} />;
}
