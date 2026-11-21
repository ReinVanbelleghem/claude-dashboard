import { useRef, useState, type ReactNode } from "react";
import {
  imageOfIcon,
  INITIALS_ICON,
  isProjectGlyph,
  markColorValue,
  markKey,
  monogram,
  PROJECT_GLYPHS,
  PROJECT_ICON_SIZE,
  type ProjectGlyph,
} from "../../shared/projectMarks.ts";
import { TASK_COLORS, type TaskColor } from "../../shared/tasks.ts";
import { workspaceApi } from "../api.ts";
import { useProjectMark } from "../projectMarks.ts";
import { UploadIcon } from "./Icons.tsx";
import { FolderIcon } from "./Icons.tsx";
import { useProjectList } from "../projectList.ts";
import { Popover } from "./Popover.tsx";

const GLYPHS: Record<ProjectGlyph, ReactNode> = {
  server: (
    <>
      <rect width="20" height="8" x="2" y="2" rx="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </>
  ),
  window: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M2 8h20M6 4v4M10 4v4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </>
  ),
  phone: (
    <>
      <rect width="14" height="20" x="5" y="2" rx="2" />
      <path d="M12 18h.01" />
    </>
  ),
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  box: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </>
  ),
  book: <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />,
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  rocket: (
    <>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </>
  ),
  bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
    </>
  ),
  chip: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
    </>
  ),
  flask: (
    <>
      <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" />
      <path d="M8.5 2h7M7 16h10" />
    </>
  ),
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  chart: <path d="M3 3v18h18M18 17V9M13 17V5M8 17v-3" />,
  truck: (
    <>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </>
  ),
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  terminal: <path d="m4 17 6-6-6-6M12 19h8" />,
  layers: (
    <>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </>
  ),
  bot: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </>
  ),
};

function Glyph({ name }: { name: ProjectGlyph }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}

/**
 * The small square a project wears wherever it is named. `projectKey` may be a
 * project key or a bare repository key; a project that is not on the sidebar
 * still gets its initials on a colour that stays put.
 */
export function ProjectMark({
  projectKey,
  name,
  icon,
  color,
  size = 16,
  className = "",
}: {
  projectKey: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  size?: number;
  className?: string;
}) {
  const stored = useProjectMark(projectKey);
  const shownIcon = icon !== undefined ? icon : (stored?.icon ?? null);
  const shownColor = color !== undefined ? color : (stored?.color ?? null);
  const image = imageOfIcon(shownIcon);
  const style = { "--mark": markColorValue(markKey(projectKey), shownColor), "--mark-size": `${size}px` } as React.CSSProperties;
  if (image) {
    return (
      <span className={`project-mark image ${className}`} style={style} aria-hidden="true">
        <img src={`/api/project-icon/${image}`} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className={`project-mark ${className}`} style={style} aria-hidden="true">
      {isProjectGlyph(shownIcon) ? <Glyph name={shownIcon} /> : <span className="project-mark-letters">{monogram(stored?.name ?? name)}</span>}
    </span>
  );
}

export const hasOwnMark = (p: { icon: string | null; color: string | null }): boolean => p.icon !== null || p.color !== null;

/** The mark a project wears when it has picked one of its own. */
export function OwnProjectMark({
  project,
  size,
  className,
}: {
  project: { id: number; name: string; icon: string | null; color: string | null };
  size?: number;
  className?: string;
}) {
  return <ProjectMark projectKey={`project:${project.id}`} name={project.name} icon={project.icon} color={project.color} size={size} className={className} />;
}

/**
 * A project's icon wherever one is named: its own mark when it has one, else the
 * mark of the repository its checkouts are of, else a folder.
 */
export function ProjectIcon({
  project,
  size = 16,
}: {
  project: { id: number; name: string; icon: string | null; color: string | null };
  size?: number;
}) {
  const { workspaces } = useProjectList();
  if (hasOwnMark(project)) return <OwnProjectMark project={project} size={size} />;
  const repo = workspaces.find((w) => w.projectId === project.id && w.status !== "archived") ?? workspaces.find((w) => w.projectId === project.id);
  if (repo) return <ProjectMark projectKey={repo.repoKey} name={repo.repoName} size={size} />;
  return (
    <span className="project-mark folder" style={{ "--mark-size": `${size}px` } as React.CSSProperties} aria-hidden="true">
      <FolderIcon />
    </span>
  );
}

const COLOR_NAMES = Object.keys(TASK_COLORS) as TaskColor[];

/** A picked file, cover-fitted onto a small square and handed back as a PNG data URL. */
async function squarePng(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight) || PROJECT_ICON_SIZE;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PROJECT_ICON_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot draw the image");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      img,
      ((img.naturalWidth || side) - side) / 2,
      ((img.naturalHeight || side) - side) / 2,
      side,
      side,
      0,
      0,
      PROJECT_ICON_SIZE,
      PROJECT_ICON_SIZE,
    );
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The panel that picks a project's mark: a colour, a glyph, its initials or an image of your own. */
export function ProjectMarkPicker({
  anchor,
  projectKey,
  goal,
  name,
  onClose,
}: {
  anchor: HTMLElement;
  projectKey?: string;
  goal?: { id: number; icon: string | null; color: string | null };
  name: string;
  onClose: () => void;
}) {
  const repoMark = useProjectMark(goal ? null : projectKey);
  const stored = goal ?? repoMark;
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (err: Error) => setError(err.message);
  const key = goal ? `project:${goal.id}` : markKey(projectKey ?? "");
  const mark = (change: { icon?: string | null; color?: string | null }) =>
    goal ? workspaceApi.markGoal(goal.id, change) : workspaceApi.markProject(key, change);
  const following = goal !== undefined && !hasOwnMark(goal);
  const currentColor = following ? null : markColorValue(key, stored?.color);
  const initialsOn = !following && (stored?.icon === INITIALS_ICON || stored?.icon === null);
  const image = imageOfIcon(stored?.icon);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const png = await squarePng(file);
      await (goal ? workspaceApi.imageGoal(goal.id, png) : workspaceApi.imageProject(key, png));
    } catch (err) {
      fail(err instanceof Error ? err : new Error("That image could not be read"));
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} className="project-mark-picker" role="dialog" align="start">
      {goal && (
        <button
          className={`project-mark-follow${following ? " on" : ""}`}
          onClick={() => void mark({ icon: null, color: null }).catch(fail)}
        >
          Follow repository
        </button>
      )}
      <div className="svc-menu-heading">Colour</div>
      <div className="project-menu-colors" role="group" aria-label="Colour">
        {COLOR_NAMES.map((c) => (
          <button
            key={c}
            className={`project-menu-color${currentColor === TASK_COLORS[c] ? " on" : ""}`}
            title={c}
            aria-label={c}
            style={{ background: TASK_COLORS[c] }}
            onClick={() => void mark({ color: c }).catch(fail)}
          />
        ))}
      </div>
      <div className="svc-menu-heading">Icon</div>
      <div className={`project-mark-grid${following ? " neutral" : ""}`} role="group" aria-label="Icon">
        <button
          className={`project-mark-choice${goal ? (initialsOn ? " on" : "") : !stored?.icon ? " on" : ""}`}
          title="Initials"
          aria-label="Initials"
          onClick={() => void mark({ icon: goal ? INITIALS_ICON : null }).catch(fail)}
        >
          <ProjectMark projectKey={key} name={name} icon={null} color={stored?.color} size={20} />
        </button>
        {PROJECT_GLYPHS.map((g) => (
          <button
            key={g}
            className={`project-mark-choice${stored?.icon === g ? " on" : ""}`}
            title={g}
            aria-label={g}
            onClick={() => void mark({ icon: g }).catch(fail)}
          >
            <ProjectMark projectKey={key} name={name} icon={g} color={stored?.color} size={20} />
          </button>
        ))}
      </div>
      <div className="project-mark-upload">
        {image && <ProjectMark projectKey={key} name={name} icon={stored?.icon} color={stored?.color} size={24} />}
        <button className="icon-btn" onClick={() => fileRef.current?.click()}>
          <UploadIcon />
          {image ? "Replace image…" : "Upload image…"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {error && <p className="project-mark-error">{error}</p>}
    </Popover>
  );
}
