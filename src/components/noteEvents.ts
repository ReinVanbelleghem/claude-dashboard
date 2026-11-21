/** Fired on the window when the daemon reports the notes folder changed. */
export const NOTES_CHANGED = "notes-changed";

/** `path` and `hash` are set when one note was saved; absent for a change to the list. */
export type NotesChange = { path?: string; hash?: string };
