# AGENTS.md — repo conventions for OmniHost.ai

Repo-specific facts only: where code lives, what you may write, what "done" means. Product
scope is in `Documentation/` and the team's business plan; read those separately.

## Where the code lives

- `/home/team/shared/site` is canonical — the platform serves it on port 3000 and edits
  hot-reload there. `scripts/sync-to-repo.sh [branch]` mirrors it into the git clone
  (`$OMNIHOST_REPO_DIR`, default `$HOME/work/OmniHost.ai`) and commits and pushes.
- **The mirror deletes.** The script is `rsync -a --delete`, so anything in the clone that is
  not in the site directory is removed, unless it is in the script's exclude list
  (`Documentation/`, `README.md`, `skills`, `node_modules`, `.git`, `dist`, `.run`,
  `.tanstack`, `.env*`, `src/routeTree.gen.ts`). **`docs/` is not excluded**: a file authored
  straight into the clone is deleted by the next sync anybody runs. Author in the site
  directory first, then sync. If you add a repo-only file, add it to the exclude list too.
- **Push gotcha.** The script runs `git checkout -B <branch> origin/main`, which re-points the
  branch's upstream at `origin/main`, so a plain `--force-with-lease` fails with *stale info*
  rather than "behind". Either push with the expected old value —
  `git push --force-with-lease=<branch>:<old-sha> origin <branch>` — or re-sync onto the
  existing branch with `OMNIHOST_BASE_BRANCH=<branch>` to fast-forward it. `gh` needs
  `GH_TOKEN` in the environment (`git push` does not), and `git push` prints nothing useful on
  success — verify with `git ls-remote origin <branch>`.
- The shared clone can be stale, and a stale tree produces confident findings about code that
  does not exist. Before branching: `git fetch origin && git reset --hard origin/main`.

## Database

- `DATABASE_URL` is set in the shell **and** in the dev server's environment, and points at the
  owner's Neon Postgres (Singapore). **There is no local database** — `env -u DATABASE_URL` no
  longer means "local". The working preview and the published site read the same database.
- A full seed against Neon takes roughly 15 minutes: run it in the background, and say so
  first.
- Keep test writes tiny, deliberate and reversible, and name in your report exactly which rows
  you touched. Never run a seed, bulk import or destructive script without flagging it first.
  If a task needs heavy test data, ask the lead for a scratch database.
- Migrations are `db/migrations/*.sql`; `bun run db:migrate` / `db:seed` / `db:reset`.

## Changes and verification

- No user-visible string literal in a component. Copy comes from the message catalogs
  (`src/i18n/catalog-en.ts`, `src/i18n/catalog-other.ts`) through `t()`.
- Every mutation writes its audit row in the same transaction as the change it records. Use
  `auditedMutation` in `src/server/audit.ts`. This is why the schema uses `pg` transactions —
  `@neondatabase/serverless` over HTTP has none.
- Capability checks happen **server-side**, through `guard()` / `requirePermission`, never in a
  screen. Hiding a nav item is a courtesy, not a control: the server refuses the operation
  whatever the UI offered, and a refusal is audited with `outcome='denied'`.
- `npx tsc --noEmit` must be clean for `src/`. The only known errors are in `serve.ts` (Bun
  globals; `@types/bun` is not installed) — leave those alone. `bun run build` must be green.
- A change is not verified until it has been exercised as a real user in a browser, **including
  a write**, with the evidence quoted in the report — the URL, what was clicked, what changed.

## Client/server boundary

- Module-scope, client-retained code — routes, components, and any shape a screen imports —
  may import only import-free modules.
- `src/domain/nav.ts` and `src/domain/principal.ts` are the pattern: they have **no imports at
  all**, and the server imports from them too. Both carry a header comment explaining why.
- A server-only module (`~/domain/auth`, `~/server/*`, anything importing `pg` or
  `node:crypto`) pulled into the client graph breaks the **production** build — dev mode hides
  it until someone publishes.

## Workflow

- Branch, push, open a pull request; the team lead reviews and merges. **Never merge or publish
  your own work.**
- **Commit and push as soon as the code compiles.** A delegation session can be cut off at any
  moment, and a session that ends with a pushed branch plus one sentence saying what remains is
  worth far more than a perfect change nobody can see. Do not wait for it to be finished.
