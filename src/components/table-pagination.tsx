/*
 * Shared table pagination controls for the Pokemon Draft League.
 *
 * The Pokémon tables can hold thousands of rows. Pages keep the rendered DOM
 * small without changing the data model: the caller slices its already-loaded
 * (and filtered/sorted) rows, then this component supplies the range label and
 * previous/next controls.
 */
"use client";

/** Props for the {@link TablePagination} component. */
export interface TablePaginationProps {
  /** One-based current page. Values outside the valid range are clamped. */
  page: number;
  /** Rows shown per page. */
  pageSize: number;
  /** Total rows in the current filtered dataset. */
  total: number;
  /** Called with the requested one-based page. */
  onPageChange: (page: number) => void;
  /** Called when the member picks a different page size. */
  onPageSizeChange: (pageSize: number) => void;
  /** Page sizes offered by the selector. Defaults to 50 and 100. */
  pageSizeOptions?: number[];
}

/**
 * Renders the row range, page-size selector, and previous/next controls.
 *
 * @param props - {@link TablePaginationProps}
 * @returns The pagination bar, or null when there are no rows.
 */
export function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [50, 100],
}: TablePaginationProps) {
  if (total === 0) {
    return null;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, total);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
      <p>
        Showing{" "}
        <span className="font-medium text-slate-200">
          {start}-{end}
        </span>{" "}
        of <span className="font-medium text-slate-200">{total}</span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs">
          <span className="uppercase tracking-[0.12em] text-slate-500">
            Rows
          </span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-amber-400"
            aria-label="Rows per page"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>

        <span className="whitespace-nowrap text-xs text-slate-500">
          Page {currentPage} of {totalPages}
        </span>

        <button
          type="button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
