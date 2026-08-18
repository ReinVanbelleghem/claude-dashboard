import { useState } from "react";
import {
  accentColor,
  accentInkColor,
  chipSurface,
  faviconFor,
  lookOf,
  surfacesFor,
  toSavedTheme,
  prefersReducedMotion,
  type Appearance,
  type StoredTheme,
  type ThemeLook,
  type ThemeName,
} from "../appearance.ts";
import { ThemeStudio } from "./ThemeStudio.tsx";
import { PencilIcon } from "./Icons.tsx";
import { useIconPhase } from "../useIconPhase.ts";

export type { StoredTheme } from "../appearance.ts";

/**
 * Appearance, reduced to two things: which saved theme is on, and the button that
 * opens the builder.
 *
 * It used to be five stacked grids — palette cards, accent dots, glyphs, icon
 * colours — which meant every colour decision was made in a different row with no
 * preview of the result. All of that now lives in the studio, where the choices sit
 * next to what they do; this panel is the shelf you pick a finished theme off.
 */
export function AppearancePanel({
  appearance,
  onChange,
  themes = [],
  onThemes,
}: {
  appearance: Appearance;
  onChange: (patch: Partial<Appearance>) => void;
  /** Saved themes, newest first. Absent while settings.json is still loading. */
  themes?: StoredTheme[];
  onThemes?: (next: StoredTheme[]) => void;
}) {
  const a = appearance;
  const [studio, setStudio] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const reduced = prefersReducedMotion();
  const phase = useIconPhase(a.motion);

  // Read once per render, so legacy entries and current ones behave identically.
  const saved = themes.map(toSavedTheme);
  /** Active when every colour-bearing field matches — the mode is not one of them. */
  const activeName = saved.find((t) => sameLook(t.look, lookOf(a)))?.name ?? null;

  return (
    <div className="panel">
      <h2>Appearance</h2>
      <p className="hint">
        Applied as you click, and remembered per browser as well as in settings.json.
      </p>

      <div className="set-group">
        <div className="theme-hero">
          <div
            className="theme-hero-preview"
            style={{ background: chipSurface(a), borderColor: accentColor(a) }}
          >
            <img src={faviconFor(a, false, phase)} alt="" width={20} height={20} />
          </div>
          <div className="theme-hero-text">
            <strong>{activeName ?? "Unsaved look"}</strong>
            <span className="set-help">
              {a.theme === "dark" ? "Dark" : "Light"} · hue {Math.round(a.customPalette[a.theme].hue)}° ·{" "}
              {a.accent === "custom" ? "custom accent" : `${a.accent} accent`}
              {reduced ? " · reduced motion" : ""}
            </span>
          </div>
          <div className="theme-hero-actions">
            {/* Both doors stay open: New starts from the current look with an empty
                name so saving adds an entry, Edit updates the one that is on. */}
            <button
              className="icon-btn primary"
              onClick={() => {
                setEditing(null);
                setStudio(true);
              }}
            >
              New theme
            </button>
            {activeName && (
              <button
                className="icon-btn"
                onClick={() => {
                  setEditing(activeName);
                  setStudio(true);
                }}
              >
                Edit “{activeName}”
              </button>
            )}
          </div>
        </div>

        {/* Two cards rather than a two-word toggle: a theme carries both columns, and
            the only way to judge the one you are not in is to see it. Each card paints
            itself in its own mode, so this is the switch and the showcase at once. */}
        <div className="mode-cards" role="group" aria-label="Dark or light">
          {(["dark", "light"] as const).map((mode) => (
            <ModeCard
              key={mode}
              appearance={a}
              mode={mode}
              on={a.theme === mode}
              phase={phase}
              onPick={() => onChange({ theme: mode })}
            />
          ))}
        </div>
      </div>

      <div className="set-group">
        <h3 className="set-h">Saved themes</h3>
        <p className="set-help">
          Each theme covers both modes, so applying one keeps whichever of Dark or Light you
          are in. Stored in settings.json, so a look survives a reload and is there in any
          browser that opens this dashboard.
        </p>
        {themes.length === 0 ? (
          <div className="empty">Nothing saved yet — open the studio and name a look.</div>
        ) : (
          <div className="saved-themes">
            {saved.map((t) => (
              <div key={t.name} className="saved-theme">
                <button
                  className={`saved-theme-apply ${t.name === activeName ? "on" : ""}`}
                  title={`Apply ${t.name}`}
                  aria-pressed={t.name === activeName}
                  // The look only — applying a theme must not flip dark/light.
                  onClick={() => onChange(t.look)}
                >
                  <span
                    className="saved-theme-chip"
                    style={{
                      background: chipSurface({ ...t.look, theme: a.theme }),
                      borderColor: accentColor({ ...t.look, theme: a.theme }),
                    }}
                  />
                  <span className="saved-theme-name">{t.name}</span>
                  <span className="saved-theme-meta">
                    hue {Math.round(t.look.customPalette[a.theme].hue)}° ·{" "}
                    {t.look.accent === "custom" ? "custom accent" : `${t.look.accent} accent`}
                  </span>
                </button>
                <button
                  className="icon-btn tiny"
                  title={`Edit ${t.name}`}
                  aria-label={`Edit ${t.name}`}
                  onClick={() => {
                    onChange(t.look);
                    setEditing(t.name);
                    setStudio(true);
                  }}
                >
                  <PencilIcon />
                </button>
                <button
                  className="icon-btn tiny danger"
                  title={`Delete ${t.name}`}
                  aria-label={`Delete ${t.name}`}
                  disabled={!onThemes}
                  onClick={() => onThemes?.(saved.filter((x) => x.name !== t.name))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {studio && (
        <ThemeStudio
          appearance={a}
          onChange={onChange}
          themes={themes}
          onThemes={onThemes}
          editing={editing}
          onClose={() => {
            setStudio(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * One mode of the current theme, drawn in that mode's own colours: the tile, a panel
 * with both text steps, and the accent carrying a label. Clicking it switches.
 */
function ModeCard({
  appearance,
  mode,
  on,
  phase,
  onPick,
}: {
  appearance: Appearance;
  mode: ThemeName;
  on: boolean;
  phase?: number;
  onPick: () => void;
}) {
  const m: Appearance = { ...appearance, theme: mode };
  const s = surfacesFor(appearance, mode);
  const accent = accentColor(m);
  const ink = accentInkColor(m);
  return (
    <button
      className={`mode-card ${on ? "on" : ""}`}
      aria-pressed={on}
      onClick={onPick}
      style={{ background: s["surface-0"], borderColor: on ? accent : s.border }}
    >
      <span className="mode-card-top">
        <img src={faviconFor(m, false, phase)} alt="" width={18} height={18} />
        <span style={{ color: s["text-primary"] }}>{mode === "dark" ? "Dark" : "Light"}</span>
        {on && <span className="mode-card-now" style={{ color: accent }}>current</span>}
      </span>
      <span
        className="mode-card-panel"
        style={{ background: s["surface-1"], borderColor: s.border }}
      >
        <span className="mode-card-line" style={{ color: s["text-primary"] }}>
          Session on main
        </span>
        <span className="mode-card-sub" style={{ color: s["text-muted"] }}>
          11:04 · 3.2k tokens
        </span>
        <span className="mode-card-row">
          <span className="mode-card-btn" style={{ background: accent, color: ink }}>
            Approve
          </span>
          <span
            className="mode-card-chip"
            style={{ background: s["surface-2"], color: s["text-secondary"], borderColor: s["border-strong"] }}
          >
            chip
          </span>
        </span>
      </span>
    </button>
  );
}

/** Compares only what a theme actually carries, so unrelated state cannot unmatch it. */
function sameLook(x: ThemeLook, y: ThemeLook): boolean {
  const keys = [
    "palette",
    "accent",
    "accentInk",
    "favicon",
    "faviconColor",
    "unsafeContrast",
  ] as const;
  if (keys.some((k) => x[k] !== y[k])) return false;
  return (
    JSON.stringify([x.customPalette, x.customAccent, x.customIconColor, x.customAccentInk]) ===
    JSON.stringify([y.customPalette, y.customAccent, y.customIconColor, y.customAccentInk])
  );
}
