/*
 * Pool page for the Pokemon Draft League.
 *
 * Placeholder route that announces the draft pool and tier list editor as the
 * next phase of development.
 */

/**
 * Renders the "coming soon" placeholder for the draft pool editor.
 */
export default function PoolPage() {
  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-center shadow-xl shadow-slate-950/40">
        <p className="text-4xl" aria-hidden="true">
          🗂️
        </p>
        <p className="mt-4 text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">
          Coming soon
        </p>
        <h1 className="mt-2 text-2xl font-bold text-white">
          Draft Pool &amp; Tier List
        </h1>
        <p className="mt-3 text-sm text-slate-400">
          The draft pool editor is the next phase of development. It will bring
          the tier view, CSV import/export, and Pokémon catalog search.
        </p>
        <p className="mt-4 text-xs text-slate-500">
          Until then, the pool can be prepared from Draft Settings.
        </p>
      </div>
    </main>
  );
}