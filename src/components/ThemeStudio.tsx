import { useEffect, useState } from "react";
import {
  accentColor,
  accentInkColor,
  ACCENTS,
  accentHex,
  FAVICONS,
  faviconFor,
  iconPng,
  lookOf,
  SEEDS,
  seedFor,
  toSavedTheme,
  type Appearance,
  type StoredTheme,
  type ThemeName,
} from "../appearance.ts";
import {
  accentWorst,
  buildSurfaces,
  contrast,
  CUSTOM_RANGES,
  DEFAULT_CUSTOM_PALETTE,
  inkOn,
  INKS,
  TEXT_FLOORS,
  type CustomPalette,
} from "../palette.ts";
import { ColorPicker, ColorWell } from "./ColorPicker.tsx";
import { useIconPhase } from "../useIconPhase.ts";



const SLIDERS: { key: keyof CustomPalette; label: string; help: string; fmt: (v: number) => string }[] = [
  { key: "hue", label: "Hue", help: "The tint every surface carries", fmt: (v) => `${Math.round(v)}°` },
  { key: "depth", label: "Depth", help: "How dark the page itself is", fmt: (v) => v.toFixed(2) },
  { key: "tint", label: "Tint", help: "Neutral grey through to fully saturated", fmt: (v) => v.toFixed(3) },
  { key: "contrast", label: "Contrast", help: "Gap between the surface and text steps", fmt: (v) => `${v.toFixed(2)}×` },
  { key: "gamma", label: "Gamma", help: "How far panels lift off the page", fmt: (v) => v.toFixed(2) },
];

/**
 * The theme builder, as a modal rather than a strip inside Settings: it needs a
 * preview next to the controls to be usable at all, and that does not fit in a
 * settings column. Edits apply live to the whole app — the modal is deliberately
 * not a sandbox, because the dashboard behind it is the real preview.
 */
export function ThemeStudio({
  appearance,
  onChange,
  onClose,
  themes = [],
  onThemes,
  editing = null,
}: {
  appearance: Appearance;
  onChange: (patch: Partial<Appearance>) => void;
  onClose: () => void;
  /** Name of the theme being edited, so saving updates it instead of adding a copy. */
  editing?: string | null;
  themes?: StoredTheme[];
  onThemes?: (next: StoredTheme[]) => void;
}) {
  const a = appearance;
  // Every in-page copy of the glyph runs off the shared clock, so toggling motion here
  // shows what it does — on the tiles you are choosing between and on the tab preview,
  // not only on the real favicon behind the modal.
  const phase = useIconPhase(a.motion);
  const [name, setName] = useState(editing ?? "");
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  // The set for the mode on screen. Normalised here too: the studio is reachable
  // straight after applying a theme saved by an older build, and every slider
  // formats its own value.
  const palette = { ...DEFAULT_CUSTOM_PALETTE, ...a.customPalette[a.theme] };
  const other: ThemeName = a.theme === "dark" ? "light" : "dark";
  const setPalette = (next: CustomPalette) =>
    onChange({ palette: "custom", customPalette: { ...a.customPalette, [a.theme]: next } });
  const built = buildSurfaces(palette, a.theme, a.unsafeContrast);
  const s = built.surfaces;
  const accent = accentColor(a);
  const ink = accentInkColor(a);
  const inkRatio = contrast(ink, accent);
  // Both candidates, always, so each tile can show its own result and reading — the
  // measured one and the chosen one are a comparison, not a mode you have to enter.
  const autoInk = inkOn(accent);
  const forcedInk = a.customAccentInk[a.theme];
  const autoRatio = contrast(autoInk, accent);
  const forcedRatio = contrast(forcedInk, accent);
  const set = (patch: Partial<CustomPalette>) => setPalette({ ...palette, ...patch });

  const ratios = [
    { label: "Primary", hex: s["text-primary"], min: TEXT_FLOORS["text-primary"] },
    { label: "Secondary", hex: s["text-secondary"], min: TEXT_FLOORS["text-secondary"] },
    { label: "Muted", hex: s["text-muted"], min: TEXT_FLOORS["text-muted"] },
    { label: "Accent", hex: accent, min: 4.5 },
  ].map((r) => ({
    ...r,
    ratio: Math.min(
      contrast(r.hex, s["surface-0"]),
      contrast(r.hex, s["surface-1"]),
      contrast(r.hex, s["surface-2"]),
    ),
  }));

  /**
   * Render the chosen icon to a file. Revoking the object URL is deferred rather than
   * done on the next line: the click is handled asynchronously, and pulling the URL out
   * from under it cancels the download in some browsers.
   */
  const downloadIcon = () => {
    iconPng(a)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `claude-sessions-${a.favicon}-${a.faviconColor}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      })
      .catch(() => {});
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || !onThemes) return;
    // Saved as a look: the same theme has to serve both modes. Editing drops the
    // original entry too, so renaming while editing moves it rather than cloning it.
    const rest = themes
      .map(toSavedTheme)
      .filter((t) => t.name !== trimmed && t.name !== editing);
    onThemes([{ name: trimmed, look: lookOf(a) }, ...rest]);
    setSaved(trimmed);
    setName("");
  };

  return (
    <>
      <div className="scrim studio-scrim" onClick={onClose} />
      <div className="studio" role="dialog" aria-modal="true" aria-label="Theme studio">
        <header className="studio-head">
          <h2>{editing ? `Editing “${editing}”` : "Theme studio"}</h2>
          <div className="seg">
            {(["dark", "light"] as ThemeName[]).map((t) => (
              <button
                key={t}
                className={a.theme === t ? "active" : ""}
                onClick={() => onChange({ theme: t })}
              >
                {t === "dark" ? "Dark" : "Light"}
              </button>
            ))}
          </div>
          <button className="icon-btn tiny" onClick={onClose} aria-label="Close theme studio">
            ✕
          </button>
        </header>

        <div className="studio-body">
            <section className="studio-group studio-span">
              <h3 className="studio-h">Start from</h3>
              <div className="studio-seeds">
              {SEEDS.map((seed) => (
                <button
                  key={seed.name}
                  className="studio-seed"
                  title={seed.help}
                  onClick={() =>
                    setPalette(seedFor(seed.name, a.theme))
                  }
                >
                  {seed.label}
                </button>
              ))}
              </div>
            </section>

          <div className="studio-col">
            <section className="studio-group">
              <h3 className="studio-h">
              Surfaces · {a.theme}
              <button
                className="link-btn inline studio-copy"
                title={`Copy these five values to ${other}`}
                onClick={() =>
                  onChange({
                    palette: "custom",
                    customPalette: { ...a.customPalette, [other]: palette },
                  })
                }
              >
                copy to {other}
              </button>
            </h3>
            {SLIDERS.map((sl) => (
              <label key={sl.key} className="studio-slider">
                <span className="studio-slider-label">
                  {sl.label}
                  <span className="studio-slider-help">{sl.help}</span>
                </span>
                <input
                  type="range"
                  min={CUSTOM_RANGES[sl.key].min}
                  max={CUSTOM_RANGES[sl.key].max}
                  step={CUSTOM_RANGES[sl.key].step}
                  value={palette[sl.key]}
                  onChange={(e) => set({ [sl.key]: Number(e.target.value) } as Partial<CustomPalette>)}
                />
                <span className="studio-slider-value">{sl.fmt(palette[sl.key])}</span>
              </label>
            ))}

            <div className="studio-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={a.unsafeContrast}
                  onChange={(e) => onChange({ unsafeContrast: e.target.checked })}
                />
                <span>Allow text below the contrast floor</span>
              </label>
              <button className="link-btn inline" onClick={() => setPalette(DEFAULT_CUSTOM_PALETTE)}>
                Reset
              </button>
              </div>
            </section>
          </div>

          <div className="studio-col">
            <section className="studio-group">
              <h3 className="studio-h">
                Accent
                <span className="studio-h-tag">{a.theme} value</span>
              </h3>
              <ColorPicker
              value={a.accent === "custom" ? a.customAccent[a.theme] : accentHex(a.accent, a.theme)}
              presets={ACCENTS.map((c) => accentHex(c.name, a.theme))}
              onChange={(hex) =>
                onChange({
                  accent: "custom",
                  customAccent: { ...a.customAccent, [a.theme]: hex },
                })
              }
            />
              <h4 className="studio-sub">Label on the accent</h4>
              <div className="ink-picks">
                <button
                  className={`ink-pick ${a.accentInk === "auto" ? "on" : ""}`}
                  aria-pressed={a.accentInk === "auto"}
                  onClick={() => onChange({ accentInk: "auto" })}
                >
                  <InkSample accent={accent} ink={autoInk} />
                  <InkMeta name="Measured" ratio={autoRatio} />
                </button>
                <ColorWell
                  className="ink-pick"
                  active={a.accentInk === "custom"}
                  label="Pick the colour of labels on the accent"
                  value={forcedInk}
                  presets={[...INKS, s["surface-0"], s["text-primary"]]}
                  onActivate={() => onChange({ accentInk: "custom" })}
                  onChange={(hex) =>
                    onChange({
                      accentInk: "custom",
                      customAccentInk: { ...a.customAccentInk, [a.theme]: hex },
                    })
                  }
                  trigger={
                    <>
                      <InkSample accent={accent} ink={forcedInk} />
                      <InkMeta name="Chosen" ratio={forcedRatio} />
                    </>
                  }
                />
              </div>
              <span className={`studio-note ${inkRatio < 4.5 ? "warn" : ""}`}>
                {inkRatio < 4.5
                  ? `${inkRatio.toFixed(2)}:1 is under the 4.5:1 floor — buttons and the find match will be hard to read.`
                  : "Used for buttons, the current find match, and the glyph on an accent-coloured tile."}
              </span>
            </section>

          </div>

          <div className="studio-col">
            <section className="studio-group">
              <h3 className="studio-h">Tab icon</h3>
              <div className="studio-glyphs">
              {FAVICONS.map((f) => (
                <button
                  key={f.name}
                  className={`studio-glyph ${a.favicon === f.name ? "on" : ""}`}
                  title={f.label}
                  aria-label={f.label}
                  aria-pressed={a.favicon === f.name}
                  onClick={() => onChange({ favicon: f.name })}
                >
                  <img
                    src={faviconFor({ ...a, favicon: f.name }, false, phase)}
                    alt=""
                    width={26}
                    height={26}
                  />
                </button>
              ))}
            </div>
            <div className="studio-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={a.faviconColor === "inherit"}
                  onChange={(e) =>
                    onChange({ faviconColor: e.target.checked ? "inherit" : "custom" })
                  }
                />
                <span>Tile follows the accent</span>
              </label>
              {a.faviconColor !== "inherit" && (
                <ColorWell
                  value={a.customIconColor[a.theme]}
                  active={a.faviconColor === "custom"}
                  label="Custom icon colour"
                  presets={ACCENTS.map((c) => accentHex(c.name, a.theme))}
                  onActivate={() => onChange({ faviconColor: "custom" })}
                  onChange={(hex) =>
                    onChange({
                      faviconColor: "custom",
                      customIconColor: { ...a.customIconColor, [a.theme]: hex },
                    })
                  }
                />
              )}
            </div>
            <div className="studio-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={a.motion}
                  onChange={(e) => onChange({ motion: e.target.checked })}
                />
                <span>Animate the icon while a session is working</span>
              </label>
              </div>

              {/* Only the export came over from Settings: the tab strip that used to sit
                  with it was previewing the same glyph the grid above already shows. The
                  Dock caveat lives on the button, where it is read at the moment it
                  matters rather than as standing prose. */}
              <div className="studio-row">
                <button
                  className="icon-btn"
                  title="A Dock app keeps the icon it was installed with, so this choice cannot reach it while it runs. Download it, then set it in the web app's settings (File → Settings → General → the icon well) — or remove it from the Dock and add it again."
                  onClick={downloadIcon}
                >
                  Download as PNG
                </button>
              </div>
            </section>
          </div>

          {/* The preview is painted from the generated variables rather than
              inheriting them, so it stays honest even while the app around it is
              mid-change, and it can show both text steps and a code block at once. */}
          <div className="studio-preview" style={{ ...asVars(s), background: s["surface-0"] }}>
            <div className="studio-preview-bar">
              <img src={faviconFor(a, false, phase)} alt="" width={16} height={16} />
              <span style={{ color: s["text-primary"] }}>Claude Sessions</span>
              <span className="studio-preview-tab" style={{ background: accent }} />
            </div>

            <div
              className="studio-preview-card"
              style={{ background: s["surface-1"], borderColor: s.border }}
            >
              <div style={{ color: s["text-primary"], fontWeight: 600 }}>Session on main</div>
              <div style={{ color: s["text-secondary"], fontSize: 13 }}>
                Waiting on a permission prompt for a write to appearance.ts.
              </div>
              <div style={{ color: s["text-muted"], fontSize: 12 }}>11:04 · 3.2k tokens</div>
              <a href="#" style={{ color: accent, fontSize: 13 }} onClick={(e) => e.preventDefault()}>
                an accent link
              </a>
              <pre className="studio-preview-code" style={{ background: s["surface-2"] }}>
                <span className="tok-kw">export</span>{" "}
                <span className="tok-fn">buildSurfaces</span>
                {"("}
                <span className="tok-str">"dark"</span>
                {") {"}
              </pre>
              <div className="studio-preview-chips">
                <span
                  className="chip"
                  style={{ background: s["surface-2"], borderColor: s["border-strong"], color: s["text-secondary"] }}
                >
                  chip
                </span>
                <span className="chip" style={{ background: accent, color: ink, borderColor: accent }}>
                  active
                </span>
                <button
                  className="studio-preview-btn"
                  style={{ background: accent, color: ink }}
                  onClick={(e) => e.preventDefault()}
                >
                  Approve
                </button>
              </div>
            </div>

            <h4 className="studio-sub">Text on the surfaces</h4>
            <div className="studio-ratios">
              {ratios.map((r) => (
                <span
                  key={r.label}
                  className={`studio-ratio ${r.ratio >= r.min ? "pass" : "fail"}`}
                  style={{ color: s["text-secondary"], borderColor: s.border }}
                >
                  {r.label} {r.ratio.toFixed(2)}:1 {r.ratio >= r.min ? "✓" : "✕"}
                </span>
              ))}
            </div>
            {built.clamped.length > 0 && !a.unsafeContrast && (
              <span className="studio-note" style={{ color: s["text-muted"] }}>
                Held at the floor: {built.clamped.join(", ")} — the sliders asked for less
                contrast than stays readable.
              </span>
            )}
          </div>
        </div>

        <footer className="studio-foot">
          <input
            className="search theme-name"
            value={name}
            placeholder="Name this look…"
            aria-label="Theme name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          <button className="icon-btn" disabled={!name.trim() || !onThemes} onClick={save}>
            {editing ? (name.trim() === editing ? "Save changes" : "Rename and save") : "Save theme"}
          </button>
          {saved && <span className="studio-saved">Saved “{saved}”</span>}
          <button className="icon-btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </>
  );
}

/**
 * A sample of the ink on the accent, big enough to judge. The two candidates are shown
 * side by side rather than described, because "is this label readable" is a question
 * about a colour on a colour that no sentence answers as fast as looking does.
 */
function InkSample({ accent, ink }: { accent: string; ink: string }) {
  return (
    <span className="ink-sample" style={{ background: accent, color: ink }}>
      Approve
    </span>
  );
}

function InkMeta({ name, ratio }: { name: string; ratio: number }) {
  return (
    <span className="ink-meta">
      {name}
      <span className={`ink-ratio ${ratio < 4.5 ? "fail" : ""}`}>{ratio.toFixed(2)}:1</span>
    </span>
  );
}

/** The generated surfaces as CSS custom properties, for the preview subtree. */
function asVars(s: Record<string, string>): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s)) out[`--${k}`] = v;
  return out as React.CSSProperties;
}
