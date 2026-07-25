// Mutable registries the mounted SqlEditor fills in, split out so the shell
// (App, Palette) can read them without statically importing the CodeMirror
// bundle: the editor loads lazily; until it mounts these are null/false,
// which is also the correct answer (nothing to run/format yet).

/** what ⌘↩ / the Run button should execute: the selection if any, else the
 * STATEMENT under the caret (Run All ⇧⌘↩ takes the whole buffer). offset =
 * where the text sits in the buffer, so error squiggles land right. Set while
 * the editor is mounted so the toolbar matches ⌘↩. */
export const editorRunText: {
  current: (() => { text: string; offset: number }) | null;
} = { current: null };

/** true while the buffer time-machine shows a snapshot: run/save/format on
 * the (invisible) parked draft are swallowed everywhere via this flag */
export const editorTimeTraveling = { current: false };

/** ⇧⌘F / menu format hook, registered by the mounted editor */
export const editorFormat: { current: (() => void) | null } = { current: null };
