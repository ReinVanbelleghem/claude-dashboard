import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

const ACTIVATION_PX = 4;
const SETTLE_TIMEOUT_MS = 3000;

type DragState = { active: number; target: number; offset: number };

export type Sortable = {
  /** Index of the item being dragged, or null. */
  active: number | null;
  /** Spread onto the drag handle of item `i`. */
  handleProps: (i: number) => {
    onPointerDown: (e: PointerEvent) => void;
    onKeyDown: (e: KeyboardEvent) => void;
  };
  /** Style for item `i`: the lifted one follows the pointer, the ones it passes slide aside. */
  itemStyle: (i: number) => CSSProperties | undefined;
};

/**
 * A sortable list in the dnd-kit style, without the dependency.
 *
 * A 4px activation distance keeps a click on the handle a click; the lifted item
 * follows the pointer on one axis only, clamped to the list; the items it passes
 * slide out of its way; and the arrow keys move a focused handle one step. An
 * item counts as passed once the lifted one's leading edge crosses its middle,
 * which the clamp can always reach: measuring from the lifted item's own centre
 * meant the last swap in a list, and the only swap in a list of two, needed the
 * pointer to go exactly as far as the clamp allows and no less. The
 * list's items are found with `itemSelector` under `listRef`, in index order.
 *
 * On release the items glide into their final slots and stay there, frozen,
 * until the list re-renders in the new order (a save and an SSE event later) or
 * a timeout gives up on it. Clearing the transforms the moment the pointer lifts
 * would send every item back to the old order, then jump again when the new one
 * arrives. The frame that hands over to the new order has transitions off.
 */
export function useSortable({
  count,
  listRef,
  itemSelector,
  axis = "y",
  onMove,
}: {
  count: number;
  listRef: RefObject<HTMLElement | null>;
  itemSelector: string;
  axis?: "x" | "y";
  onMove: (from: number, to: number) => void;
}): Sortable {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const sizes = useRef<number[]>([]);
  const starts = useRef<number[]>([]);
  const [settle, setSettle] = useState<DragState | null>(null);
  const [handover, setHandover] = useState(false);
  const settleOrder = useRef<HTMLElement[]>([]);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const update = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? []);
  const vertical = axis === "y";

  useLayoutEffect(() => {
    if (!settle) return;
    const now = items();
    const before = settleOrder.current;
    if (now.length === before.length && now.every((el, i) => el === before[i])) return;
    clearTimeout(settleTimer.current);
    setSettle(null);
    setHandover(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setHandover(false)));
  });

  function onPointerDown(index: number, e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rects = items().map((el) => el.getBoundingClientRect());
    if (!rects[index]) return;
    const start = vertical ? e.clientY : e.clientX;
    const itemStarts = rects.map((r) => (vertical ? r.top : r.left));
    starts.current = itemStarts;
    sizes.current = rects.map((r) => (vertical ? r.height : r.width));
    const min = itemStarts[0] - itemStarts[index];
    const last = rects[rects.length - 1];
    const max = (vertical ? last.bottom - rects[index].bottom : last.right - rects[index].right);
    const handle = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    let started = false;

    const move = (ev: globalThis.PointerEvent) => {
      const delta = (vertical ? ev.clientY : ev.clientX) - start;
      if (!started) {
        if (Math.abs(delta) < ACTIVATION_PX) return;
        started = true;
        clearTimeout(settleTimer.current);
        setSettle(null);
        try {
          handle.setPointerCapture(pointerId);
        } catch {
          // Capture is a nicety; dragging works without it.
        }
      }
      const offset = Math.max(min, Math.min(max, delta));
      const leading = itemStarts[index] + offset;
      const trailing = leading + sizes.current[index];
      let target = index;
      for (let i = 0; i < itemStarts.length; i++) {
        const mid = itemStarts[i] + sizes.current[i] / 2;
        if (i < index && leading < mid) target = Math.min(target, i);
        else if (i > index && trailing > mid) target = Math.max(target, i);
      }
      update({ active: index, target, offset });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const final = dragRef.current;
      const moves = !!final && final.target !== final.active;
      if (moves) {
        settleOrder.current = items();
        clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => setSettle(null), SETTLE_TIMEOUT_MS);
        setSettle(final);
      }
      update(null);
      if (!final) return;
      // The pointer-up that ends a drag also fires a click on the handle, which on
      // a chip that is itself the handle would toggle it. Swallow that one click.
      const swallow = (ce: MouseEvent) => ce.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 150);
      if (final.target !== final.active) onMove(final.active, final.target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function onKeyDown(index: number, e: KeyboardEvent) {
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const forward = vertical ? "ArrowDown" : "ArrowRight";
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const to = e.key === back ? index - 1 : index + 1;
    if (to < 0 || to >= count) return;
    onMove(index, to);
    requestAnimationFrame(() => {
      const el = items()[to];
      (el?.querySelector<HTMLElement>("[data-sort-handle]") ?? el)?.focus();
    });
  }

  function settledStyle(index: number, { active, target }: DragState): CSSProperties | undefined {
    const n = sizes.current.length;
    const gap = n > 1 ? starts.current[1]! - starts.current[0]! - sizes.current[0]! : 0;
    const order = Array.from({ length: n }, (_, i) => i);
    order.splice(active, 1);
    order.splice(target, 0, active);
    let cursor = starts.current[0]!;
    let delta = 0;
    for (const original of order) {
      if (original === index) delta = cursor - starts.current[index]!;
      cursor += sizes.current[original]! + gap;
    }
    const transform = vertical ? `translateY(${delta}px)` : `translateX(${delta}px)`;
    if (index === active) return { transform, zIndex: 2, position: "relative" };
    return { transform };
  }

  function itemStyle(index: number): CSSProperties | undefined {
    if (handover) return { transition: "none" };
    if (!drag && settle) return settledStyle(index, settle);
    if (!drag) return undefined;
    const { active, target, offset } = drag;
    const t = (px: number) => (vertical ? `translateY(${px}px)` : `translateX(${px}px)`);
    if (index === active) return { transform: t(offset), transition: "none", zIndex: 2, position: "relative" };
    const size = sizes.current[active] ?? 0;
    if (active < target && index > active && index <= target) return { transform: t(-size) };
    if (active > target && index >= target && index < active) return { transform: t(size) };
    return undefined;
  }

  return {
    active: drag?.active ?? null,
    handleProps: (i) => ({ onPointerDown: (e) => onPointerDown(i, e), onKeyDown: (e) => onKeyDown(i, e) }),
    itemStyle,
  };
}
