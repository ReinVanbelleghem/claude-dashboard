/** Fired on the window when the daemon reports the drawings folder changed. */
export const DRAWINGS_CHANGED = "drawings-changed";

/** `slug` and `hash` are set when one drawing was saved; absent for a change to the list. */
export type DrawingsChange = { slug?: string; hash?: string };
