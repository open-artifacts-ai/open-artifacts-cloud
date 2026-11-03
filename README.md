# open-artifacts-admin

The private half of Open Artifacts: the hosted control plane (admin panel,
provisioner, Provisioning API, scheduler, dispatch, inventory, platform D1),
the hosted release flow, red-line and the hosted runbooks. Self-host stays in
the public repo, open-artifacts-ai/open-artifacts, and builds on its own.
Issue #1056 tracks the move.

This repo is not a standalone workspace. It is an **overlay**: it builds on a
pinned public release, with this tree copied on top.

> Status: scaffold. The private paths are not copied in yet; that happens
> after the public untangle PRs land. There are no secrets, no environments
> and no deploy jobs here yet. They come at the cut-over, after the GitHub
> plan upgrade.

## Layout

| Path | What |
|---|---|
| `PUBLIC_PIN` | The public tag and the full commit sha it resolves to. |
| `private-paths.txt` | The paths this repo owns. Interim copy: once public has `scripts/ci/private-paths.txt`, that list wins. |
| `SYNCED_FROM` | Written by the sync: the public commit the private paths were copied from. |
| `scripts/overlay.sh` | Builds the overlay: `overlay.sh <public-checkout> <private-dir>`. |
| `scripts/sync-from-public.sh` | Copies the private paths from a public checkout: `sync-from-public.sh <public-checkout> [<dest>]`. |
| `scripts/dev-overlay.sh` | Builds the overlay in a new local worktree, for agents: `dev-overlay.sh <new-dir>`. |
| `scripts/ci-plan.sh` | CI: lists the private packages and every private test, and fails on a package without `test`/`typecheck` or a test nothing would run. |
| `scripts/ci-public-tests.sh` | CI: runs private tests that live in public packages through that package's own vitest configs. |
| `scripts/overlay.test.sh` | Tests for the scripts above, on throwaway repos. |
| `hosted-workflows/` | Written by the sync: the hosted workflows, inert. GitHub never runs them from here; the cut-over PR moves them into `.github/workflows/`. |
| `.github/workflows/ci.yml` | Checks out public at the pin, overlays, then install, build, typecheck, test. |

## Overlay rules

`scripts/overlay.sh` enforces all of these, and CI runs it on every change.

1. **The pin is exact.** The public checkout's HEAD must be PUBLIC_PIN's sha,
   the tag (if the checkout has it) must point at the same commit, and no
   tracked public file may be modified.
2. **No overwrite.** A private file whose path exists in public, or a public
   file where private needs a directory, is a collision. Any collision fails
   the run before anything is copied, and every collision is listed.
3. **One listed exception: `pnpm-lock.yaml`.** Public's lockfile has no
   private importers, so `--frozen-lockfile` would fail. The private merged
   lockfile replaces it. Nothing else may.
4. **No root `package.json`.** The version and commit a build records come
   from public's root `package.json` and git, so they stay the public tag's.
   Private runs everything through `pnpm --filter`.
5. **This repo's own files never overlay**: root-level files (this README,
   PUBLIC_PIN, SYNCED_FROM, private-paths.txt), the tooling scripts listed in
   `TOOLING` in `overlay.sh`, `.github/workflows/ci.yml` (this repo's CI;
   public has its own) and `hosted-workflows/`. Any other file directly in
   `scripts/` fails the run. Everything else in the tree overlays, at the
   same path.

The overlay sits at the public checkout's root, not in a subfolder, because
private code reads public files by relative path (the server's wrangler
template and migrations, the authz tables, auth-core source).

Since the overlay's git is public's, git-based scoping (affected tests,
workspace-import diffs) sees nothing private. Private CI always runs full
suites.

## Bumping the pin

One PR per bump:

1. Set `tag=` and `sha=` in PUBLIC_PIN to the new public release. The sha is
   `gh api repos/open-artifacts-ai/open-artifacts/commits/<tag> --jq .sha`.
2. Build the overlay (`scripts/dev-overlay.sh`) and run `pnpm install` in it
   without `--frozen-lockfile`, to regenerate the merged lockfile. Copy the
   overlay's `pnpm-lock.yaml` back here.
3. Fix whatever the new public release broke, in this repo.
4. CI must be green on the PR: it checks out the new tag, so a collision with
   a file public added fails here first.

## Copying the private paths (the sync)

`scripts/sync-from-public.sh <public-checkout>` mirrors each listed path from
the public checkout into this repo (old copies are removed first, only
tracked public files are copied) and writes SYNCED_FROM. It refuses a dirty
public checkout, a listed path public doesn't have, an absolute, root-level
or `..` entry, and uncommitted changes under a listed path here.

The sync never writes under `.github/workflows/`. A listed hosted workflow
lands in `hosted-workflows/` instead: several run on a schedule or on
`workflow_run`, and must not start here before the cut-over. The cut-over PR
moves them into `.github/workflows/` by hand.

## What CI runs

`scripts/ci-plan.sh` reads this repo's tracked files and makes three sets:
the private packages (each must define `test` and `typecheck`; CI runs them
one by one and logs each), the root-vitest tests in `scripts/ci` and
`scripts/ops`, and every other `*.test.ts`. That last set is private tests
inside public packages (auth-broker's platform-ticket, server's
mcp-sdk-iserror, ...); `scripts/ci-public-tests.sh` runs each through its
owning package's vitest, under whichever of that package's test configs
include it. A test with no owning package, or one no config includes, fails
CI. So does an empty tree once SYNCED_FROM exists.

Until the public repo deletes its hosted code, the pinned tag still contains
every private path, so an overlay of a synced tree on that tag collides on
purpose. The order is: public untangle, sync, public delete, then a pin bump
to the release with the delete.

## Local development

```sh
scripts/dev-overlay.sh ~/code/oa-overlay-<task>
cd ~/code/oa-overlay-<task>
pnpm install --frozen-lockfile
pnpm -r --filter "{./apps/provisioning}..." build   # braces: deps included
```

`OA_PUBLIC_REPO` (default `~/code/open-artifacts`) is the public clone the
worktree comes from; it must already have the pinned commit. The private
files in an overlay are copies: make changes in this checkout, then build a
fresh overlay. Remove one with
`git -C ~/code/open-artifacts worktree remove --force <dir>`.

## Not here yet

- Secrets and GitHub environments (hosted-staging, hosted-prod, their deploy
  environments, redline-staging). They need the org plan upgrade first.
- Deploy, release, sign and publish workflows, and branch protection. They
  come at the cut-over.
- `main`. The lead and the owner create it and its protections.
