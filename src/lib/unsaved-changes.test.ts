/*
 * Tests for the unsaved-changes guard registry.
 *
 * The registry holds module state, so each test resets it. That is also the
 * behaviour worth pinning: a page that unregisters on unmount must not be able to
 * keep intercepting navigation afterwards, and that is exactly what a stale guard
 * would do.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearUnsavedChangesGuard,
  confirmDiscardUnsavedChanges,
  createUnsavedChangesGuard,
  registerUnsavedChangesGuard,
} from "@/lib/unsaved-changes";

afterEach(() => {
  clearUnsavedChangesGuard();
});

describe("confirmDiscardUnsavedChanges", () => {
  it("allows navigation when no page has registered anything", () => {
    expect(confirmDiscardUnsavedChanges()).resolves.toBe(true);
  });

  it("defers to the registered page's own confirmation", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    registerUnsavedChangesGuard({ confirm });

    await expect(confirmDiscardUnsavedChanges()).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("cancels the navigation when the member declines", async () => {
    registerUnsavedChangesGuard({ confirm: async () => false });

    await expect(confirmDiscardUnsavedChanges()).resolves.toBe(false);
  });

  it("prompts on every attempt, not just the first", async () => {
    /*
     * A member who cancels is still on the page with unsaved changes, so a second
     * attempt must warn again rather than pass through because the first one was
     * already seen. Caching the answer would let the second click through silently.
     */
    const confirm = vi.fn().mockResolvedValue(false);
    registerUnsavedChangesGuard({ confirm });

    await confirmDiscardUnsavedChanges();
    await confirmDiscardUnsavedChanges();

    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("stops intercepting once the page unregisters", async () => {
    /*
     * The unmount cleanup. Without this, navigating away from a clean page later in
     * the session would pop a dialog about edits that no longer exist.
     */
    const confirm = vi.fn().mockResolvedValue(false);
    registerUnsavedChangesGuard({ confirm });
    clearUnsavedChangesGuard();

    await expect(confirmDiscardUnsavedChanges()).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("takes over cleanly when a second page registers", async () => {
    const first = vi.fn().mockResolvedValue(false);
    const second = vi.fn().mockResolvedValue(true);

    registerUnsavedChangesGuard({ confirm: first });
    registerUnsavedChangesGuard({ confirm: second });

    await confirmDiscardUnsavedChanges();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("treats a cleared guard as safe to leave", async () => {
    registerUnsavedChangesGuard(null);

    await expect(confirmDiscardUnsavedChanges()).resolves.toBe(true);
  });
});
describe("createUnsavedChangesGuard", () => {
  it("builds no guard at all when the page is clean", async () => {
    /*
     * The bug this exists to prevent: a guard registered unconditionally kept
     * prompting after a successful save, because clearing `hasChanges` re-ran the
     * owning effect and its body reinstalled a guard over the clean page. Building
     * null for a clean page makes that outcome unreachable rather than merely
     * unlikely.
     */
    const ask = vi.fn().mockResolvedValue(true);

    expect(createUnsavedChangesGuard(false, ask)).toBeNull();

    registerUnsavedChangesGuard(createUnsavedChangesGuard(false, ask));
    await expect(confirmDiscardUnsavedChanges()).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("saves leaving the page alone once the guard is dropped for a clean page", async () => {
    /*
     * The save-then-leave sequence end to end: guard installed while dirty, guard
     * dropped once saved, navigation allowed without a prompt.
     */
    const ask = vi.fn().mockResolvedValue(true);

    registerUnsavedChangesGuard(createUnsavedChangesGuard(true, ask));
    registerUnsavedChangesGuard(createUnsavedChangesGuard(false, ask));

    await expect(confirmDiscardUnsavedChanges()).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks and reverts only when the member accepts", async () => {
    const onDiscard = vi.fn();
    const ask = vi.fn().mockResolvedValue(true);

    registerUnsavedChangesGuard(
      createUnsavedChangesGuard(true, ask, onDiscard),
    );

    await expect(confirmDiscardUnsavedChanges()).resolves.toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("keeps the edits when the member cancels", async () => {
    const onDiscard = vi.fn();

    registerUnsavedChangesGuard(
      createUnsavedChangesGuard(true, async () => false, onDiscard),
    );

    await expect(confirmDiscardUnsavedChanges()).resolves.toBe(false);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("still works when the page supplies no revert step", async () => {
    registerUnsavedChangesGuard(
      createUnsavedChangesGuard(true, async () => true),
    );

await expect(confirmDiscardUnsavedChanges()).resolves.toBe(true);
  });
});
