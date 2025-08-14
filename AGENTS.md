# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts`: Cloudflare Worker entry handling the `email` event.
- `test/index.spec.ts`: Vitest tests for parsing and GitHub issue creation.
- Config: `wrangler.jsonc` (worker name, entry, dates), `vitest.config.ts` (Cloudflare workers pool), `tsconfig.json` (strict TS), `.editorconfig`, `.prettierrc`.
- Types/assets: `worker-configuration.d.ts` augments Worker env; no app assets folder.

## Build, Test, and Development Commands
- `npm run dev` (or `pnpm dev`): Start Worker locally with Wrangler.
- `npm run start`: Alias for `dev`.
- `npm run test`: Run Vitest against the Workers pool.
- `npm run deploy`: Deploy to Cloudflare Workers.
- `npm run cf-typegen`: Generate Cloudflare type stubs.
- Optional type check: `npx tsc -p . --noEmit`.

## Coding Style & Naming Conventions
- Indentation: tabs; EOL: LF; final newline (see `.editorconfig`).
- Prettier: single quotes, semicolons, width 140, tabs (see `.prettierrc`).
- TypeScript: strict mode; ESM modules; prefer `async/await` and explicit return types for exported functions.
- Naming: files `kebab-case.ts` (e.g., `index.ts`), tests `*.spec.ts`; types/interfaces `PascalCase`, functions/vars `camelCase`, constants `SCREAMING_SNAKE_CASE`.

## Testing Guidelines
- Framework: Vitest with `@cloudflare/vitest-pool-workers` (uses `wrangler.jsonc`).
- Location: place tests under `test/` named `*.spec.ts`.
- Run: `npm test`. For coverage locally: `npx vitest --coverage` (optional).
- Write focused unit tests for parsing, attachment handling, and issue body construction; mock network calls to GitHub/Imgur.

## Commit & Pull Request Guidelines
- Commits: imperative, concise; prefer Conventional-style prefixes when helpful (`feat:`, `fix:`, `docs:`). Example: `fix: clean HTML-to-Markdown artifacts`.
- PRs: include purpose, linked issues (`Closes #123`), test updates, and logs/screenshots for edge cases. Update docs when env/config changes.
- Keep changes minimal and consistent with existing patterns; avoid unrelated refactors.

## Security & Configuration Tips
- Required env: `GITHUB_USERNAME`, `GITHUB_REPO`, `GITHUB_TOKEN`.
- Local dev: put values in `.dev.vars` (gitignored). Production: store secrets via `wrangler secret put NAME`.
- Do not log tokens or raw emails; redact in tests. Never commit credentials.

## Architecture Overview
- Flow: Email → Worker (`src/index.ts`) → parse (PostalMime) → upload images (Imgur) → create issue (Octokit). Configuration in `wrangler.jsonc`.
