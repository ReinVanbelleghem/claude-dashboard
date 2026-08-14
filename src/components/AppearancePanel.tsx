import {
  ACCENTS,
  FAVICONS,
  PALETTES,
  accentHex,
  faviconDataUrl,
  type AccentName,
  type Appearance,
  type FaviconName,
} from "../appearance.ts";

/**
 * Appearance, applied live as you click rather than on save — the point of a
 * theme picker is seeing it, and every option here is reversible.
 */
export function AppearancePanel({
  appearance,
  onChange,
}: {
  appearance: Appearance;
  onChange: (patch: Partial<Appearance>) => void;
}) {
  const a = appearance;

  return (
    <div className="panel">
      <h2>Appearance</h2>
      <p className="hint">
        Applied as you click, and remembered per browser as well as in settings.json.
      </p>

      <div className="set-group">
        <h3 className="set-h">Theme</h3>
        <div className="swatch-row">
          {(["dark", "light"] as const).map((t) => (
            <button
              key={t}
              className={`theme-card ${a.theme === t ? "on" : ""}`}
              data-theme-preview={t}
              onClick={() => onChange({ theme: t })}
            >
              <span className="theme-card-bar" style={{ background: accentHex(a.accent, t) }} />
              <span className="theme-card-line" />
              <span className="theme-card-line short" />
              <span className="theme-card-name">{t === "dark" ? "Dark" : "Light"}</span>
            </button>
          ))}
        </div>

        <h3 className="set-h">Palette</h3>
        <p className="set-help">
          Surfaces, borders and text. Chart colours and the accent sit on top and do not move.
        </p>
        <div className="swatch-row">
          {PALETTES.map((p) => {
            const s = p[a.theme];
            return (
              <button
                key={p.name}
                className={`palette-card ${a.palette === p.name ? "on" : ""}`}
                title={p.help}
                aria-pressed={a.palette === p.name}
                onClick={() => onChange({ palette: p.name })}
                style={
                  s
                    ? { background: s["surface-1"], borderColor: s.border, color: s["text-secondary"] }
                    : undefined
                }
              >
                <span
                  className="palette-card-bar"
                  style={{ background: accentHex(a.accent, a.theme) }}
                />
                <span className="palette-card-line" />
                <span className="palette-card-name">{p.label}</span>
              </button>
            );
          })}
        </div>

        <h3 className="set-h">Accent</h3>
        <p className="set-help">
          Drives links, focus rings, active tabs and the speaker bar. Chart colours are
          deliberately left alone.
        </p>
        <div className="swatch-row">
          {ACCENTS.map((c) => (
            <button
              key={c.name}
              className={`swatch ${a.accent === c.name ? "on" : ""}`}
              title={c.label}
              aria-label={c.label}
              aria-pressed={a.accent === c.name}
              style={{ background: accentHex(c.name, a.theme) }}
              onClick={() => onChange({ accent: c.name })}
            />
          ))}
        </div>

        <h3 className="set-h">Tab icon</h3>
        <div className="swatch-row">
          {FAVICONS.map((f) => (
            <button
              key={f.name}
              className={`fav-pick ${a.favicon === f.name ? "on" : ""}`}
              title={f.label}
              aria-pressed={a.favicon === f.name}
              onClick={() => onChange({ favicon: f.name as FaviconName })}
            >
              <img src={faviconDataUrl(f.name, a.faviconColor, a.theme)} alt={f.label} width={28} height={28} />
              <span>{f.label}</span>
            </button>
          ))}
        </div>

        <div className="sub-label">Icon colour</div>
        <div className="swatch-row">
          {ACCENTS.map((c) => (
            <button
              key={c.name}
              className={`swatch sm ${a.faviconColor === c.name ? "on" : ""}`}
              title={`Icon in ${c.label.toLowerCase()}`}
              aria-label={`Icon in ${c.label.toLowerCase()}`}
              aria-pressed={a.faviconColor === c.name}
              style={{ background: accentHex(c.name, a.theme) }}
              onClick={() => onChange({ faviconColor: c.name as AccentName })}
            />
          ))}
        </div>

        <div className="tab-preview-row">
          <div className="tab-preview">
            <img
              src={faviconDataUrl(a.favicon, a.faviconColor, a.theme)}
              alt=""
              width={16}
              height={16}
            />
            <span>Claude Sessions</span>
            <span className="tab-preview-x">×</span>
          </div>
          {/* The badged state is the whole point of the icon, so show it here
              rather than making you wait for a session to block. */}
          <div className="tab-preview">
            <img
              src={faviconDataUrl(a.favicon, a.faviconColor, a.theme, true)}
              alt=""
              width={16}
              height={16}
            />
            <span>(1) Claude Sessions</span>
            <span className="tab-preview-x">×</span>
          </div>
        </div>
        <span className="set-help">
          The dot and the count appear whenever a session is waiting on you. Browsers cache
          favicons hard — a hard reload (⌘⇧R) settles it if the tab lags behind.
        </span>
      </div>
    </div>
  );
}
