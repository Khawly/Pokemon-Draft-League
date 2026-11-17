<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:documentation-rules -->

# Documentation rules

Every source file must be documented. This applies to new files, edited files, and existing files being touched.

## TypeScript / React (`*.ts`, `*.tsx`)

- **File header**: a `/*`-style block comment at the very top of the file (below `"use client"` or imports as appropriate — for `.tsx` put it above `"use client"`, for `.ts` above imports) describing the file's purpose, one or two sentences. Example:

```ts
/*
 * Authentication helpers for the Pokemon Draft League.
 *
 * Provides typed wrappers around Supabase auth (sign up, sign in, sign out)
 * and a client-side session singleton shared across the app.
 */
```

- **Exported functions/components**: JSDoc (`/** ... */`) directly above the declaration documenting what it does, parameters, and return value. Include `@returns` for functions that return a value.
- **Types/interfaces**: a short JSDoc line above the type describing its meaning.
- **Complex logic** (non-obvious algorithms, RPC payloads, async flows): a concise inline comment (`//`) explaining the *why*, not the *what*.
- **Props of components**: describe the behavior in the component's JSDoc.
  Document only props whose meaning or constraints are non-obvious; do not
  enumerate self-explanatory props inline.

## SQL (`*.sql`, `supabase/migrations/*`)

- **File header**: a `--` comment describing the migration purpose.
- **Tables**: a `--` comment above each `CREATE TABLE` describing the table.
- **Functions/RPCs**: a `--` comment above each `CREATE FUNCTION` describing behavior, parameters, and permissions/security context.
- **Indexes**: a `--` comment above each `CREATE INDEX` describing what it enforces/speeds up.

## Config files

- Add a brief `/*`-header describing what the config controls only if non-obvious. Never add comments to auto-generated files (e.g., `next-env.d.ts`).

## Rules of thumb

- Prefer documenting exported API surface (functions, components, types).
- Do not add inline comments unless they explain a critical non-obvious design
  decision or business constraint. Express intent through function and variable
  naming instead.
- Never add emojis.
- Follow existing spacing/style in the file.

## Module boundaries

- Pages and components read league data through a feature module under
  `@/lib/supabase/` (`auth`, `dashboard`, `draft`, `draftboard`, `pokemon`,
  `schedule`, `seasons`, `teams`, `trades`, `week-deadline`, `availability`,
  `rules`, `honors`, `invites`). Add a loader or RPC wrapper there instead of
  querying `@/lib/supabase/client` from a page. The shell provider and the
  realtime helper are the only components that talk to the client directly.
- Import shared helpers from the module that owns them (`@/lib/datetime`,
  `@/lib/type-styles`, `@/lib/deadlines`, `@/lib/trades-view`). Do not re-derive
  or inline the same logic in a page.
- Always import through the `@/` alias. No `../..` paths.
- Keep one import statement per module: merge value and type imports
  (`import { loadThing, type Thing } from "..."`). `no-duplicate-imports` enforces
  this.

<!-- END:documentation-rules -->
