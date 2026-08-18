import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { hexToOklch, MAX_CHROMA, oklchToHex, oklchToRgbRaw } from "../palette.ts";

/**
 * An OKLCH colour picker, drawn here rather than delegated to <input type="color">
 * — that opens the OS panel, which on macOS is a floating window in its own visual
 * language and cannot be styled to belong to the dashboard.
 *
 * The field is lightness across, chroma down, at a fixed hue, because that is the
 * pair worth exploring for an accent: the hue is the decision, and the other two
 * are the tuning.
 *
 * Chroma is relative — the axis runs 0 to whatever sRGB can actually reach at that
 * lightness, found per column by bisection. An absolute axis wastes most of the
 * field on unreachable colours (sRGB's gamut narrows sharply toward both ends of
 * the lightness range), so the usable area became a small triangle in a checkered
 * void. Relative means every point in the field is a colour you can have.
 */
const FIELD_W = 240;
const FIELD_H = 150;
const HUE_STOPS = 24;

/** Largest chroma sRGB can show at this lightness and hue, to ~0.001. */
function maxChroma(L: number, hue: number): number {
  let lo = 0;
  let hi = MAX_CHROMA;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (oklchToRgbRaw(L, mid, hue).inGamut) lo = mid;
    else hi = mid;
  }
  return lo;
}

function useFieldPaint(hue: number) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = FIELD_W * dpr;
    el.height = FIELD_H * dpr;
    const img = ctx.createImageData(el.width, el.height);

    // Column-major: maxChroma depends only on lightness, so it is found once per
    // column rather than per pixel — 12 bisections x width instead of x area.
    for (let x = 0; x < el.width; x++) {
      const L = x / (el.width - 1);
      const top = maxChroma(L, hue);
      for (let y = 0; y < el.height; y++) {
        const C = (1 - y / (el.height - 1)) * top;
        const { rgb } = oklchToRgbRaw(L, C, hue);
        const at = (y * el.width + x) * 4;
        for (let i = 0; i < 3; i++) {
          const v = rgb[i];
          const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
          img.data[at + i] = Math.round(Math.min(1, Math.max(0, encoded)) * 255);
        }
        img.data[at + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
  }, [hue]);

  return canvas;
}

/** Pointer drag on the field, reported as fractions so the caller keeps the units. */
function useDrag(onMove: (fx: number, fy: number) => void) {
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const report = (e: PointerEvent | React.PointerEvent) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onMove(
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    );
  };

  useEffect(() => {
    const move = (e: PointerEvent) => dragging.current && report(e);
    const up = () => (dragging.current = false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  return {
    ref: box,
    onPointerDown: (e: React.PointerEvent) => {
      dragging.current = true;
      report(e);
    },
  };
}

export function ColorPicker({
  value,
  onChange,
  presets = [],
}: {
  value: string;
  onChange: (hex: string) => void;
  presets?: string[];
}) {
  // Hue is held here, not derived from the hex on every render: a fully grey colour
  // has no hue, and recomputing would snap the strip to 0 and lose your place.
  const [hue, setHue] = useState(() => hexToOklch(value).H);
  const [text, setText] = useState(value);
  const { L, C } = hexToOklch(value);

  useEffect(() => setText(value), [value]);

  const canvas = useFieldPaint(hue);
  const field = useDrag((fx, fy) => onChange(oklchToHex(fx, (1 - fy) * maxChroma(fx, hue), hue)));

  const commitText = (raw: string) => {
    const hex = raw.trim().replace(/^#?/, "#");
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return;
    onChange(hex.toLowerCase());
    setHue(hexToOklch(hex).H);
  };

  const hueGradient = `linear-gradient(to right, ${Array.from({ length: HUE_STOPS }, (_, i) =>
    oklchToHex(0.7, 0.16, (i / (HUE_STOPS - 1)) * 360),
  ).join(", ")})`;

  const nudge = (dL: number, dC: number) => {
    const nextL = Math.min(1, Math.max(0, L + dL));
    const top = maxChroma(nextL, hue);
    onChange(oklchToHex(nextL, Math.min(top, Math.max(0, C + dC * top)), hue));
  };

  return (
    <div className="cp">
      <div
        className="cp-field"
        ref={field.ref}
        onPointerDown={field.onPointerDown}
        role="application"
        aria-label="Lightness and chroma"
        tabIndex={0}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.05 : 0.01;
          if (e.key === "ArrowLeft") nudge(-step, 0);
          else if (e.key === "ArrowRight") nudge(step, 0);
          else if (e.key === "ArrowUp") nudge(0, step * 2);
          else if (e.key === "ArrowDown") nudge(0, -step * 2);
          else return;
          e.preventDefault();
        }}
      >
        <canvas ref={canvas} width={FIELD_W} height={FIELD_H} />
        <span
          className="cp-dot"
          style={{
            left: `${L * 100}%`,
            top: `${(1 - Math.min(1, C / (maxChroma(L, hue) || 1))) * 100}%`,
            background: value,
          }}
        />
      </div>

      <label className="cp-hue" style={{ background: hueGradient }}>
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={Math.round(hue)}
          aria-label="Hue"
          onChange={(e) => {
            const next = Number(e.target.value);
            setHue(next);
            onChange(oklchToHex(L, C, next));
          }}
        />
      </label>

      <div className="cp-foot">
        <span className="cp-preview" style={{ background: value }} />
        <input
          className="cp-hex"
          value={text}
          spellCheck={false}
          aria-label="Hex value"
          onChange={(e) => {
            setText(e.target.value);
            commitText(e.target.value);
          }}
          onBlur={() => setText(value)}
        />
        {presets.length > 0 && (
          <div className="cp-presets">
            {presets.map((hex) => (
              <button
                key={hex}
                className="cp-preset"
                style={{ background: hex }}
                title={hex}
                aria-label={`Use ${hex}`}
                onClick={() => {
                  onChange(hex);
                  setHue(hexToOklch(hex).H);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The swatch that opens the picker. Distinct from the fixed swatches on purpose:
 * a plain dot in the accent row gives no hint that this one is the free choice, so
 * it carries a hue ring, and shows the chosen colour inside it once it is in use.
 */
export function ColorWell({
  value,
  active,
  onChange,
  onActivate,
  label = "Custom colour",
  presets,
  trigger,
  className = "swatch cp-well",
}: {
  value: string;
  active: boolean;
  onChange: (hex: string) => void;
  onActivate?: () => void;
  label?: string;
  presets?: string[];
  /**
   * Content for the trigger, when a bare swatch is not enough of a control. The ink
   * picker needs to show its own result — a sample of the colour it produces, with a
   * contrast reading — and that sample has to be the thing you click, not a label
   * beside a second button that opens the picker.
   */
  trigger?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div className="cp-well-wrap" ref={wrap}>
      <button
        className={`${className} ${active ? "on" : ""}`}
        title={label}
        aria-label={label}
        aria-pressed={active}
        aria-expanded={open}
        style={trigger ? undefined : { background: value }}
        onClick={() => {
          onActivate?.();
          setOpen((v) => !v);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className="cp-pop" role="dialog" aria-label={label}>
          <ColorPicker value={value} onChange={onChange} presets={presets} />
        </div>
      )}
    </div>
  );
}
