import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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



const BG_BLUR_MAX = 60;

/**
 * A `backdrop-filter: blur()` px value is wildly non-linear perceptually: the
 * jump from 0 to 3px is far more visible than 30 to 33px. A plain linear
 * slider over 0–60 spent most of its drag distance on "very blurry, and
 * increasingly indistinguishable from more very blurry", leaving almost no
 * room to land precisely on the low end where the actual visible range is.
 * Cubic-easing the slider position fixes that: the first two-thirds of the
 * drag covers roughly 0–18px, the rest reaches on up to 60. The stored value
 * is still a plain px number — only the *slider's* mapping to it is curved.
 */
function bgBlurSliderPos(px: number): number {
  return Math.round(100 * Math.cbrt(Math.max(0, px) / BG_BLUR_MAX));
}
function bgBlurFromSliderPos(pos: number): number {
  return Math.round(BG_BLUR_MAX * (pos / 100) ** 3 * 10) / 10;
}

/**
 * Sample content for the preview card. One static sentence only tells you whether
 * that sentence is readable — a short status, a long wrapped one, an error, and a
 * quiet idle state exercise the surfaces very differently, so the preview cycles
 * through a few rather than picking one for good.
 */
const PREVIEW_SCENARIOS: {
  title: string;
  body: string;
  meta: string;
  link: string;
  code: { kw: string; fn: string; str: string };
  chips: string[];
}[] = [
  {
    title: "Session on main",
    body: "Waiting on a permission prompt for a write to appearance.ts.",
    meta: "11:04 · 3.2k tokens",
    link: "an accent link",
    code: { kw: "export", fn: "buildSurfaces", str: "dark" },
    chips: ["chip", "active"],
  },
  {
    title: "Session on feat/glass-opacity",
    body: "Reading through the theme studio to find where the slider bounds are set.",
    meta: "09:41 · 640 tokens",
    link: "view the diff",
    code: { kw: "const", fn: "clamp", str: "0..95" },
    chips: ["idle", "queued"],
  },
  {
    title: "Session on hotfix/contrast-floor",
    body: "Command failed: contrast ratio 2.9:1 is below the readability floor for this pair.",
    meta: "14:52 · 1.1k tokens",
    link: "open the error",
    code: { kw: "throw", fn: "belowFloor", str: "text-secondary" },
    chips: ["error", "blocked"],
  },
  {
    title: "Session on main",
    body: "Idle. Say the word and I'll pick up where the last run on this branch left off, whenever that turns out to be.",
    meta: "yesterday · 18.7k tokens",
    link: "resume this session",
    code: { kw: "async function", fn: "resume", str: "session-id" },
    chips: ["idle"],
  },
];

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
  const [previewIdx, setPreviewIdx] = useState(0);
  const scenario = PREVIEW_SCENARIOS[previewIdx];

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

  // Portalled to <body> rather than returned in place: this is opened from deep
  // inside Settings, nested under AppearancePanel's own `.panel`. `.panel` now
  // always carries a `backdrop-filter` (glass tracks the sliders unconditionally
  // — see styles.css), and backdrop-filter creates a new containing block for
  // position:fixed descendants exactly like `filter`/`transform` do. Left in
  // place, `.studio`'s `top: 50%; left: 50%` resolved against that nearby panel
  // instead of the viewport, so the whole modal collapsed to its top-left corner
  // instead of centering on screen. A portal sidesteps the ancestor chain
  // entirely, which is the only fix that stays correct regardless of what a
  // future ancestor's CSS does.
  return createPortal(
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

            <section className="studio-group">
              <h3 className="studio-h">Interface effects</h3>
              <div className="studio-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={a.hoverFx}
                    onChange={(e) => onChange({ hoverFx: e.target.checked })}
                  />
                  <span>Hover lift, button press feedback, streaming cursor</span>
                </label>
              </div>
              {/* Always mounted and always live, matching the two below: dialing
                  one in ahead of wanting it (or leaving it set from before)
                  should work without fighting a disabled slider, and keeping
                  the DOM shape constant regardless of the value is what
                  actually fixed the modal jumping/resizing on every change —
                  worth keeping regardless of there being no checkbox left to
                  toggle. */}
              <label className="studio-slider">
                <span className="studio-slider-label">
                  Background blur · {a.theme}
                  <span className="studio-slider-help">
                    Blurs the page behind an open drawer or dialog — 0 is off
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={bgBlurSliderPos(a.backgroundBlur[a.theme])}
                  onChange={(e) =>
                    onChange({
                      backgroundBlur: {
                        ...a.backgroundBlur,
                        [a.theme]: bgBlurFromSliderPos(Number(e.target.value)),
                      },
                    })
                  }
                />
                <span className="studio-slider-value">{a.backgroundBlur[a.theme]}px</span>
              </label>
              <label className="studio-slider">
                <span className="studio-slider-label">
                  Blur · {a.theme}
                  <span className="studio-slider-help">How much of what's behind smears</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={30}
                  step={1}
                  value={a.glassBlur[a.theme]}
                  onChange={(e) =>
                    onChange({ glassBlur: { ...a.glassBlur, [a.theme]: Number(e.target.value) } })
                  }
                />
                <span className="studio-slider-value">{a.glassBlur[a.theme]}px</span>
              </label>
              <label className="studio-slider">
                <span className="studio-slider-label">
                  Panel opacity · {a.theme}
                  <span className="studio-slider-help">Lower is more see-through glass</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={95}
                  step={1}
                  value={a.glassOpacity[a.theme]}
                  onChange={(e) =>
                    onChange({ glassOpacity: { ...a.glassOpacity, [a.theme]: Number(e.target.value) } })
                  }
                />
                <span className="studio-slider-value">{a.glassOpacity[a.theme]}%</span>
              </label>
              <span className="studio-note">
                The hover and cursor motion stays off under your system's reduced-motion
                setting regardless of this toggle.
              </span>
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
            {/* Nothing else in this mock sits behind the card, so a backdrop blur has
                nothing to smear and a slider drag looked like it did nothing. This
                is purely a demo prop for that — nudged behind the card on purpose.
                Unconditional now: the window's own glass is always on (see
                .drawer/.tile-window/.modal/.studio in styles.css), so the preview
                should never look like it's showing a state the app can't reach. */}
            <div
              className="studio-preview-glow"
              style={{ background: `linear-gradient(135deg, ${accent}, ${s["surface-2"]})` }}
            />
            <div className="studio-preview-bar">
              <img src={faviconFor(a, false, phase)} alt="" width={16} height={16} />
              <span style={{ color: s["text-primary"] }}>Claude Sessions</span>
              <span className="studio-preview-tab" style={{ background: accent }} />
            </div>

            <div
              className="studio-preview-card"
              style={{
                // Painted from the generated variables rather than the live
                // CSS custom properties, for the same reason the surface colours
                // are: this has to stay honest while a slider is mid-drag, before
                // applyAppearance has run. Unconditional to match the window's
                // own glass always being on — see the note above.
                background: `color-mix(in oklab, ${s["surface-1"]} ${a.glassOpacity[a.theme]}%, transparent)`,
                borderColor: s.border,
                backdropFilter: `blur(${a.glassBlur[a.theme] / 2}px) saturate(1.2)`,
                WebkitBackdropFilter: `blur(${a.glassBlur[a.theme] / 2}px) saturate(1.2)`,
              }}
            >
              <div style={{ color: s["text-primary"], fontWeight: 600 }}>{scenario.title}</div>
              <div style={{ color: s["text-secondary"], fontSize: 13 }}>{scenario.body}</div>
              <div style={{ color: s["text-muted"], fontSize: 12 }}>{scenario.meta}</div>
              <a href="#" style={{ color: accent, fontSize: 13 }} onClick={(e) => e.preventDefault()}>
                {scenario.link}
              </a>
              <pre className="studio-preview-code" style={{ background: s["surface-2"] }}>
                <span className="tok-kw">{scenario.code.kw}</span>{" "}
                <span className="tok-fn">{scenario.code.fn}</span>
                {"("}
                <span className="tok-str">"{scenario.code.str}"</span>
                {") {"}
              </pre>
              <div className="studio-preview-chips">
                {scenario.chips.map((c, i) =>
                  i === 0 ? (
                    <span
                      key={c}
                      className="chip"
                      style={{ background: s["surface-2"], borderColor: s["border-strong"], color: s["text-secondary"] }}
                    >
                      {c}
                    </span>
                  ) : (
                    <span key={c} className="chip" style={{ background: accent, color: ink, borderColor: accent }}>
                      {c}
                    </span>
                  ),
                )}
                <button
                  className="studio-preview-btn"
                  style={{ background: accent, color: ink }}
                  onClick={(e) => e.preventDefault()}
                >
                  Approve
                </button>
              </div>
            </div>

            <h4 className="studio-sub" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              Text on the surfaces
              <button
                className="icon-btn tiny"
                style={{ marginLeft: "auto" }}
                onClick={() => setPreviewIdx((i) => (i + 1) % PREVIEW_SCENARIOS.length)}
              >
                Try another sample
              </button>
            </h4>
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
    </>,
    document.body,
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
