/*
 * Site-styled confirmation dialog for the Pokemon Draft League.
 *
 * The app's destructive actions all need a confirmation step, and the native
 * `window.confirm` cannot be made to match the dark card-based visual language:
 * it renders an OS chrome popup with browser-default buttons and type. This
 * component replaces it with a modal built from the same slate/amber tokens as
 * the rest of the app, and `useConfirm` wraps it so an async action can simply
 * `await confirm({...})` instead of hand-rolling open/cancel state.
 *
 * Copy written for a dialog should read as a short question, not a sentence with
 * a trailing period, because the buttons below it already complete the thought.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How urgent a confirmation is, which decides the button treatment. */
export type ConfirmTone = "default" | "danger";

/** The copy and behaviour of one confirmation request. */
export type ConfirmOptions = {
  /** Short question shown as the dialog heading, e.g. "Forfeit this match?". */
  title: string;
  /** Optional supporting detail, e.g. what is lost by going ahead. */
  detail?: string;
  /** Label for the affirmative button. */
  confirmLabel?: string;
  /** Label for the dismissive button. */
  cancelLabel?: string;
  /** `danger` for irreversible actions, `default` for ordinary ones. */
  tone?: ConfirmTone;
};

/** A pending request plus the resolver that settles the caller's promise. */
type ConfirmRequest = Required<Pick<ConfirmOptions, "title">> & {
  detail?: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: ConfirmTone;
};

/** Props for the {@link ConfirmDialog} component. */
export interface ConfirmDialogProps {
  /** The pending request, or null when nothing is awaiting an answer. */
  request: ConfirmRequest | null;
  /** Settles the request; the argument becomes the `confirm` promise's result. */
  onResolve: (accepted: boolean) => void;
}

/** Styling for the affirmative button, which is the risky one on a danger tone. */
const TONE_STYLES: Record<ConfirmTone, string> = {
  default: "bg-amber-500 text-slate-950 hover:bg-amber-400",
  danger: "bg-rose-500 text-white hover:bg-rose-400",
};

/**
 * Renders a confirmation modal, or nothing when no request is pending.
 *
 * Escape and a backdrop click both count as cancelling, so a member is never
 * trapped in a dialog they did not mean to open. The affirmative button takes
 * focus on open so the keyboard path does not start on the destructive choice.
 *
 * @param props - The pending request and the resolver that settles it.
 * @returns The modal, or null when there is nothing to confirm.
 */
export function ConfirmDialog({ request, onResolve }: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!request) {
      return;
    }

    confirmButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onResolve(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [request, onResolve]);

  if (!request) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm"
      // A click that both starts and ends on the backdrop is a dismissal; a drag
      // that began inside the card should not close it.
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onResolve(false);
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={request.detail ? "confirm-dialog-detail" : undefined}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl shadow-slate-950/60"
      >
        <h2
          id="confirm-dialog-title"
          className="text-lg font-bold text-white"
        >
          {request.title}
        </h2>

        {request.detail && (
          <p id="confirm-dialog-detail" className="mt-2 text-sm text-slate-300">
            {request.detail}
          </p>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
          >
            {request.cancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={() => onResolve(true)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${TONE_STYLES[request.tone]}`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A `confirm` function paired with the dialog element to render once. */
export type UseConfirmResult = {
  /**
   * Asks the member to confirm. Resolves true when they accept, false when they
   * cancel, dismiss, or the component unmounts while asking.
   */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** The dialog element, to be rendered once near the root of the page. */
  confirmDialog: React.ReactNode;
};

/**
 * Adds a site-styled confirmation prompt to a page.
 *
 * @returns The `confirm` helper and the dialog element to render.
 */
export function useConfirm(): UseConfirmResult {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolverRef = useRef<((accepted: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    // Only one question can be outstanding; a second call cancels the first so
    // the earlier awaiter always settles rather than hanging forever.
    resolverRef.current?.(false);

    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setRequest({
        title: options.title,
        detail: options.detail,
        confirmLabel: options.confirmLabel ?? "Confirm",
        cancelLabel: options.cancelLabel ?? "Cancel",
        tone: options.tone ?? "default",
      });
    });
  }, []);

  const onResolve = useCallback((accepted: boolean) => {
    setRequest(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(accepted);
  }, []);

  // Unmounting mid-question must not leave a caller awaiting forever.
  useEffect(
    () => () => {
      resolverRef.current?.(false);
    },
    [],
  );

  return {
    confirm,
    confirmDialog: <ConfirmDialog request={request} onResolve={onResolve} />,
  };
}
