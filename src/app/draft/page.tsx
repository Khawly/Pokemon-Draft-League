/*
 * Draft page for the Pokemon Draft League.
 *
 * Placeholder route that announces the live draft arena as the next phase of
 * development.
 */

/**
 * Renders the "coming soon" placeholder for the live draft interface.
 */
export default function DraftPage() {
  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-center shadow-xl shadow-slate-950/40">
        <p className="text-4xl" aria-hidden="true">
          🏟️
        </p>
        <p className="mt-4 text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">
          Coming soon
        </p>
        <h1 className="mt-2 text-2xl font-bold text-white">The Draft Arena</h1>
        <p className="mt-3 text-sm text-slate-400">
          The live draft interface is the next phase of development. When it
          ships, this page will host the pick floor, priority lists, and the
          draft timer.
        </p>
        <p className="mt-4 text-xs text-slate-500">
          You can still prepare everything from the Draft Board.
        </p>
      </div>
    </main>
  );
}