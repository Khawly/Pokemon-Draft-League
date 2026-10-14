/*
 * A registry for the one page at a time that has unsaved changes.
 *
 * The problem this exists to solve: `beforeunload` covers closing the tab, reloading
 * and the browser back button, but NOT navigation inside the app. Next.js links and
 * `router.push` are client-side transitions that never unload the document, so the
 * browser's own dialog never fires and a form with unsaved edits is discarded without
 * a word. The settings page could only guard the exits it owned, which left every
 * link in the top navigation unprotected.
 *
 * The page with unsaved changes owns the dialog, because the confirmation is a React
 * component (`useConfirm`) and cannot be rendered from here. So a dirty page
 * registers a callback rather than a message, and anything about to navigate asks
 * the registry to run it.
 *
 * Module state rather than context because both ends are leaf components in
 * different parts of the tree, with no provider between them, and this is client
 * only. A page that unregisters on unmount keeps it to a single owner.
 */

/** What a dirty page hands the registry. */
export interface UnsavedChangesGuard {
  /**
   * Runs the page's own confirmation dialog.
   *
   * @returns True to allow the navigation, false to cancel it and stay put.
   */
  confirm: () => Promise<boolean>;
}

/** The currently registered dirty page, or null when nothing is dirty. */
let activeGuard: UnsavedChangesGuard | null = null;

/**
 * Registers the page that currently has unsaved changes.
 *
 * Call from an effect, and pair with {@link clearUnsavedChangesGuard} in the effect's
 * cleanup so an unmounted page cannot keep intercepting navigation.
 *
 * @param guard - The dirty page's confirmation callback, or null to clear.
 */
export function registerUnsavedChangesGuard(guard: UnsavedChangesGuard | null) {
  activeGuard = guard;
}

/**
 * Removes whatever guard is registered.
 *
 * Separate from passing null to the register call so the cleanup reads as intent
 * rather than as a re-registration with a missing argument.
 */
export function clearUnsavedChangesGuard() {
  activeGuard = null;
}

/**
 * Asks the dirty page whether it is safe to navigate away.
 *
 * @returns True when nothing is dirty or the member confirmed discarding, false when
 *   the navigation should be cancelled.
 */
export async function confirmDiscardUnsavedChanges(): Promise<boolean> {
  if (!activeGuard) {
    return true;
  }

  return activeGuard.confirm();
}

/**
 * Builds the guard a page should register, or null when it has nothing to guard.
 *
 * Returning null for a clean page is the whole point, and it lives here rather than
 * in the caller's effect so it can be tested. A caller that registers
 * unconditionally is correct right up until a save: `isDirty` flipping to false
 * re-runs the effect, React clears the old guard as its cleanup, and the effect body
 * then installs a fresh one over the clean state. Every later navigation then
 * prompted about edits that were already saved.
 *
 * @param isDirty - Whether the page currently has unsaved changes.
 * @param ask - Runs the page's confirmation dialog, resolving true to discard.
 * @param onDiscard - Reverts the page to its saved state, run only on acceptance.
 * @returns A guard to register, or null when the page is clean.
 */
export function createUnsavedChangesGuard(
  isDirty: boolean,
  ask: () => Promise<boolean>,
  onDiscard?: () => void,
): UnsavedChangesGuard | null {
  if (!isDirty) {
    return null;
  }

  return {
    confirm: async () => {
      const shouldDiscard = await ask();

      if (shouldDiscard) {
        onDiscard?.();
      }

      return shouldDiscard;
    },
  };
}