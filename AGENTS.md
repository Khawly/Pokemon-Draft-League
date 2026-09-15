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
- **Props of components**: document the props in a JSDoc block above the destructure or describe them in the component's JSDoc.

## SQL (`*.sql`, `supabase/migrations/*`)

- **File header**: a `--` comment describing the migration purpose.
- **Tables**: a `--` comment above each `CREATE TABLE` describing the table.
- **Functions/RPCs**: a `--` comment above each `CREATE FUNCTION` describing behavior, parameters, and permissions/security context.
- **Indexes**: a `--` comment above each `CREATE INDEX` describing what it enforces/speeds up.

## Config files

- Add a brief `/*`-header describing what the config controls only if non-obvious. Never add comments to auto-generated files (e.g., `next-env.d.ts`).

## Rules of thumb

- Prefer documenting exported API surface (functions, components, types).
- Keep comments meaningful — don't restate the code line-by-line.
- Never add emojis.
- Follow existing spacing/style in the file.

<!-- END:documentation-rules -->
