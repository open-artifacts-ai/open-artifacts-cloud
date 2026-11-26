# open-artifacts-cloud

The hosted half of Open Artifacts: the hosted control plane (admin panel,
provisioner, Provisioning API, scheduler, dispatch, inventory, platform D1),
the hosted release flow, red-line and the hosted runbooks. Self-host stays in
the public repo, open-artifacts-ai/open-artifacts, and builds on its own.
Issue #1056 tracks the move.

This repo is not a standalone workspace. It is an **overlay**: it builds on a
pinned public release, with this tree copied on top.

> Status: post-split. Public deleted its hosted code at F1 and `PUBLIC_PIN` is
> the first release without it (v0.136.1, step F2), so the overlay is strict, and `SYNCED_FROM` moved to the same release because the lockfile's public importers changed (the equivalence check compares them at `SYNCED_FROM`):
> `--auto-split` finds none of the listed paths in public and a collision
> fails. `--pre-split` stays only for tags older than the delete.
>
> History: the private paths were copied in once (the B1 sync, recorded in
> SYNCED_FROM). From now on this repo owns them; see "CLOUD owns the private
> paths". Secrets, environments and deploy jobs arrive at the cut-over.

## Layout

| Path | What |
|---|---|
| `PUBLIC_PIN` | The public tag and the full commit sha it resolves to. |
| `private-paths.txt` | The paths this repo owns. A copy of public's `scripts/ci/private-paths.txt` at SYNCED_FROM, refreshed by the sync and checked by `pin-check.sh`. While the pinned public tree has its own list, that one wins; after public deletes the hosted code, this one is the list. |
| `SYNCED_FROM` | Written by the sync: the public commit the private paths were copied from. |
| `scripts/overlay.sh` | Builds the overlay: `overlay.sh [--pre-split | --auto-split] <public-checkout> <private-dir>`. `--pre-split` first removes the hosted paths (public's `scripts/ci/private-paths.txt`) from the checkout, as `public-only.sh` does. `--auto-split` (what CI uses) is `--pre-split` while the pinned tree holds every listed path, strict once it holds none, and a failure when it holds some. The two flags together exit 2. |
| `scripts/sync-from-public.sh` | Copies the private paths from a public checkout: `sync-from-public.sh <public-checkout> [<dest>]`. |
| `scripts/dev-overlay.sh` | Builds the overlay in a new local worktree, for agents: `dev-overlay.sh <new-dir>`. |
| `scripts/ci-plan.sh` | CI: lists the private packages and every private test, and fails on a package without `test`/`typecheck` or a test nothing would run. |
| `scripts/ci-public-tests.sh` | CI: runs private tests that live in public packages through that package's own vitest configs. |
| `scripts/equivalence.sh` | CI: builds `overlay.sh --pre-split` of public at `SYNCED_FROM` and fails on any difference from public outside the private paths and the allowlist in the script. The private paths themselves are not compared (CLOUD owns them). Skips before the first sync: `equivalence.sh <public-checkout> [<private-dir>]`. |
| `scripts/pin-check.sh` | CI: ties `PUBLIC_PIN` to `SYNCED_FROM` while public still holds the hosted paths: `pin-check.sh <public-checkout-with-history> [<private-dir>]`. |
| `scripts/place-workflows.sh` | The one place step: copies `hosted-workflows/` into an overlay tree's `.github/workflows/` (recursive, `cp -P -p`, refuses a symlinked dir and an existing target). Used by CI and `equivalence.sh`. |
| `scripts/overlay.test.sh` | Tests for the scripts above, on throwaway repos. |
| `hosted-workflows/` | Where the sync parks public's copies of the hosted workflows (it never writes under `.github/workflows/`). Empty since C2: the live workflows are in `.github/workflows/`, edited for this repo, and a re-sync's changes are hand-ported into them. |
| `.github/workflows/ci.yml` | Checks out public at the pin, overlays, then install, build, typecheck, test. Runs on PRs, the merge queue, and pushes to main, `scaffold` and `pin-land/*` (direct-mode pin bumps, whose port-check base is the commit's parent). |
| `.github/ISSUE_TEMPLATE/blocker.yml` | Repo-only GitHub config so the hosted workflows can open `blocker` issues here. Never overlaid; `equivalence.sh` requires it to be byte-identical to public's at `SYNCED_FROM`. |
| `.github/workflows/hosted-release.yml` | Mirrors the public release at `PUBLIC_PIN` into this repo (tag and release, by the release App), then builds, signs and attaches the hosted release files (cut-over step C3, #1056). Runs for real on a push to `main` that changes `PUBLIC_PIN` (step F2): a push has no inputs, so `inputs.dry_run` is null and every dry-run test treats it as not a dry run. `workflow_dispatch` keeps `dry_run` (the default), which builds and signs with the staging key and stops before the tag and the attach. |
| `.github/workflows/pin-bump.yml` | Every 6 hours (and on dispatch, from main): if public has a stable release newer than `PUBLIC_PIN`, opens one PR into main that moves `PUBLIC_PIN` and `SYNCED_FROM` to it and carries the lockfile regenerated in the overlay (cloud #20). Three jobs: `prepare` (no secrets) installs and regenerates the lockfile and uploads only that file; `open` (fresh runner, main's checkout, never the public tree) plans again, takes the lockfile as data, then uses the release App token to push `pin-bump/<tag>` and open the PR; `report` keeps one `blocker` issue "pin-bump failed" open while the last run is red. On the PR path it never arms or merges; CI's port check and equivalence judge the PR. It does nothing while a `pin-bump/*` PR is open or one already took the tag, and an open one older than 3 days turns the run red. Needs the App to hold contents and pull-requests write. Direct mode adds a fourth job, `land`. Direct mode (cloud #264, repo variable `PIN_BUMP_DIRECT` set to `on`) lands without a PR, and CI still gates main: `open` pushes the same App-signed commit to `pin-land/<tag>` (never to main), where CI runs in full; the `land` job (after CI on a `pin-land/*` branch, and on each schedule and dispatch) fast-forwards main to that exact sha, never with force, only when `ci.yml`'s push run on that branch and exact sha passed in full (every job main's ruleset requires green, none skipped, none on the pin-only short path), the commit is the bot's verified one, it changes only `PUBLIC_PIN`, `SYNCED_FROM` and `pnpm-lock.yaml`, and both pin files name the public tag's sha. A red branch stays for a person. A main that moved meanwhile gets the same blobs rebuilt on its head and tested again, unless it moved on a lockfile-sensitive path (the branch is dropped and the next run regenerates). A bump with a surfaces port goes the PR path, for a person, as `pin-bump-arm` would. Both the direct plan and `land` wait on `pin-bump-arm`'s release pipeline gate. `land` writes with its own App (`PIN_LAND_APP_ID`, `PIN_LAND_APP_PRIVATE_KEY`, Environment `pin-land`), which is the only bypass actor main's ruleset needs, never the release App (docs/ops/hosted.md, "Pin land App"). Unset, the PR path runs as before. |
| `.github/workflows/pin-bump-arm.yml` | After CI completes, when the prod chain ends, on bump-PR events and every 15 minutes (cloud #264): arms a `pin-bump/*` PR by `open-artifacts-release[bot]` when it changes only `PUBLIC_PIN`, `SYNCED_FROM` and `pnpm-lock.yaml` (plain modifications), the tag and sha agree with the public tag and with `SYNCED_FROM`, the tag is newer than main's pin, and every required check is green on its current head. Anything else is left for a person. The App token is minted only for the arm step. Rule: `scripts/ci/pin-bump-arm.ts`. |
| `.github/workflows/hosted-release-alert.yml` | After each `hosted-release` run on main (#1782): a red real run (`failure`, `timed_out` or `startup_failure`) keeps one `blocker` issue "hosted-release failed" open with the run URL, sha and conclusion; a green one closes it. `cancelled`, `skipped` and dry runs count as nothing. `issues: write` only, no checkout, no secret; runs only from main's copy. |
| `.github/workflows/redline-retry.yml` | When attempt 1 of a release gate (`redline-staging`, dispatched on main) fails: reruns the whole run once with the release App token (actions only), and notes it on #428. Attempt 2 is never retried. Test: `scripts/ci/redline-retry.test.ts`. |
| `.github/workflows/release-watch.yml` | After each run of the release chain's workflows on main and every 5 minutes (cloud #264): times each release stage by stage, each from its own start (stages can overlap), against each stage's usual time in `.github/hosted/release-stages.json`, writes `current.json` (in flight, ETAs, per-stage p50/p90, each release's merge to every install against the 20 min target, to the prod deploy's "Fleet done" step where it ran, else to prod deploy (fleet not yet measured)) to the job summary and the `release-stats` artifact, which also carries `history.jsonl` to the next run, and comments once per release and stage on the one open issue "release stuck" when a stage runs past its limit, max(2 x usual, usual + 5 min) (release, stage, run id and rerun, failed job and one safe error line, attempts). The total is reported, never alerted on. Measure only: it gates nothing and is never a required check. Dispatch with `backfill_since` (YYYY-MM-DD) to rebuild the history. Default token only (contents and actions read, issues write). Script: `scripts/ci/release-watch.ts`. |
| `.github/workflows/cloud-flaky-tracker.yml` | When a `CI` run (a fork's PR too; this repo's code reads its logs as text, never runs the fork's), or a release gate (`redline-staging`, dispatched on main), passes on attempt 2 or later (#447): every test that failed or timed out on an earlier attempt of that run (vitest and Playwright in CI; T19 and red-line `fail` cases, never `infra`, in the gate) is recorded with its run link in one `flaky-sightings` issue, rolled over to a new one past 2000 comments. A test with sightings in 2 or more runs within 7 days, this one counted, opens or bumps one open issue labelled `flaky`, with the run links and the last author of the test file (assigned when GitHub allows it, else named in plain text). More than 5 tests to open or bump from one run: one summary issue instead of those. Test titles are made inert (no HTML comment, marker, link or mention), and only the bot's trailing marker block is parsed. Store comments split to stay under 60000 characters. One tracker run at a time per repo, every pending one kept in order (`queue: max`); hourly, the same job reconciles: any run created in the last 30 days and 26 hours (GitHub allows a rerun for 30 days; the 26 hours keep a late rerun listed) and updated in the last 26 hours that passed after a failed attempt and is not in the store yet (by run id and attempt) is tracked the same way, its listing split into smaller creation ranges wherever one query would reach GitHub's 1,000-run limit, so a dropped tracker run loses no sighting. Tracking only: no retry, nothing blocks. Default token, no secret. Public's CI has its own copy there. Not yet for runs that call `redline-staging` as a reusable workflow. Rule: `scripts/ci/cloud-flaky-tracker.ts`. |
| `.github/workflows/release-retry.yml` | When a release-chain run on main fails (hosted-release, hosted-publish, staging-release-chain, deploy-hosted-platform, prod-release-chain; pushes, workflow_run, or a dispatch whose run-name has a chain id): reruns the failed jobs (`--failed`: release steps, not tests; a whole hosted-release rerun refuses at attach) after 30 s, and again after 120 s if attempt 2 fails. One layer only: prod-release-chain is retried, never the deploy and prod publish it dispatches and waits on; a staging-chain deploy (` [sc`) is retried, with the release App token (actions only), and notes it on #428. Attempt 3 is never retried. Test: `scripts/ci/release-retry.test.ts`. |
| `.github/workflows/<hosted>.yml` | The hosted workflows (deploy, publish, floor, red-line, monitors, token pings), live since C2 (#1056). Dispatch only, plus `hosted-publish`'s `workflow_run` on `hosted-release` (C3). `prodclean-monitor` runs hourly from here; `redline-nightly` runs nightly at 03:17 UTC (F5; the public repo no longer runs one). `PROD_RELEASE_CHAIN` stays unset. |
| `.github/actions/overlay/` | The overlay prelude every hosted job that installs or builds uses: check this repo out at `_cloud`, then this action puts public at the `PUBLIC_PIN` of that checkout with this repo on top, at the workspace root. |
| `.nvmrc` | Node version for jobs that check out only this repo (scripts, no install). CI fails if it differs from public's at the pin. |

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
   public has its own), `.github/actions/` (this repo's CI actions),
   `.github/ISSUE_TEMPLATE/blocker.yml` (repo-only
   GitHub config, checked equal to public's by `equivalence.sh`) and
   `hosted-workflows/`. Any other file directly in
   `scripts/` fails the run. Everything else in the tree overlays, at the
   same path.

The overlay sits at the public checkout's root, not in a subfolder, because
private code reads public files by relative path (the server's wrangler
template and migrations, the authz tables, auth-core source).

Since the overlay's git is public's, git-based scoping (affected tests,
workspace-import diffs) sees nothing private. Private CI always runs full
suites.

## CLOUD owns the private paths

Decision, after the one-time sync (B1): this repo owns every path in the
private list and edits it freely (C1 renames the repo pins inside them, C4 and
C5 change pins and keys). Public's hosted paths are frozen and are deleted at
F1. So:

- **Outside the private paths, strict.** `equivalence.sh` still fails on any
  difference between the overlay and public at `SYNCED_FROM`: a non-private
  file dropped, added or changed. The `pnpm-lock.yaml` allowlist stays, with
  every non-private importer still matched against public's, byte for byte.
- **Inside the private paths, CLOUD's.** They are not compared to public. The
  script reports how many differences it skipped.
- **The sync cannot overwrite CLOUD's edits.** `sync-from-public.sh` refuses
  when a listed path here differs from public's copy at the recorded
  `SYNCED_FROM` (a changed, added or deleted file, a changed mode). Nothing is
  written. From B1 on, take a public change to a hosted path by hand.
- **The pin stays tied to the sync.** `pin-check.sh` requires, while public
  still holds the hosted paths: `SYNCED_FROM` is `PUBLIC_PIN` or an ancestor
  of it; and if the pin leads `SYNCED_FROM`, public changed neither a listed
  path nor the list itself in between. If it did, the pin bump PR must also
  carry the hand-ports and move `SYNCED_FROM` to the pin: that edit is the
  statement that the ports are in the PR. A pin bump over hosted changes
  without it is red. Once public holds none of the listed paths (after F1) the
  pin may still lead `SYNCED_FROM` only if public made no add or modify change
  to the listed paths in between (a fix made before the delete); otherwise
  bump `SYNCED_FROM` to the last commit before the delete, with the ports. The
  port check runs in that mode too.

## Hand-porting a public fix

A fix lands in public's hosted paths (a release carrying one is rare under the
freeze). One PR here, in this order:

1. Pick the new public release (tag `T`, sha `P`). In a clean public clone with
   history, list the hosted changes since the recorded sync:
   `git diff <SYNCED_FROM sha> P -- $(grep -v '^#' private-paths.txt)`.
2. Apply them as a diff. Public workflows live in `hosted-workflows/` here, so
   rename the path in the diff:
   `git -C <public> diff <S> P -- <paths> | sed 's|\([ab]\)/.github/workflows/|\1/hosted-workflows/|g' | git apply --3way`.
   Resolve conflicts with CLOUD's edits (the repo-name pins, keys) by hand;
   keep CLOUD's side where the change is the rename.
3. If public changed `scripts/ci/private-paths.txt`, port that too: edit
   `private-paths.txt` to match it.
4. In the same PR set `PUBLIC_PIN` (tag and sha) to `T`/`P`, set `SYNCED_FROM`
   `sha=` and `tag=` to the same, and regenerate the merged lockfile (see
   "Bumping the pin").
5. CI must be green. When `SYNCED_FROM` moves, CI takes the base's
   `SYNCED_FROM` as `OLD` and runs the port check (`pin-check.sh --prev OLD`):
   the public diff `OLD..NEW` over the listed paths, with workflows renamed to
   `hosted-workflows/`, must reverse-apply (`git apply -R --check`) to this
   tree. A bump that ports nothing fails. Where CLOUD deliberately keeps its
   own side of a changed file (the repo-name pins, keys), add a line to
   `port-exceptions.txt`: `<path> <new SYNCED_FROM sha> # reason`. An
   exception counts only for the bump whose new `SYNCED_FROM` is that sha. An
   entry for any other sha is stale and fails CI, so remove it, or state it
   again for the new bump. The exceptions file is reviewed like code: a line
   there is the claim that the hunk is intentionally not taken.
   The port check runs only when CI knows the base: on `pull_request`,
   `merge_group` and `push`. `workflow_dispatch` has no base, so `OLD` is empty
   and there is no port check. Keep `merge_group` a required check, so the
   `OLD` used is the queue's base and not a stale `pull_request` base sha.

`SYNCED_FROM` is required. Deleting it does not turn the checks off:
`pin-check.sh`, `equivalence.sh` and the sync refuse, and CI fails, whenever
the tree holds any listed path. `equivalence.sh` also fails if a whole listed
path is gone from this repo (at its own path, in `hosted-workflows/` or in
`.github/workflows/`); deletions inside a path stay CLOUD's call.

Do not run the sync to take a public fix: it refuses once CLOUD has edited a
listed path.

## Bumping the pin

One PR per bump. The `pin-bump` workflow opens it for a new public release (steps 1 to 3
below, done for you). Its `pin-bump/*` branch takes no hand pushes: when CI finds a port,
open a PR of your own from the bot's commit with the fix (as #422 did for #421), then
close the bot's. If a newer release lands while a bump is red and not armed, the workflow
closes that bump itself and opens one for the newest release (#425). With the repo
variable `PIN_BUMP_DIRECT` set to `on` (cloud #264) a pin-only bump has no PR: the workflow
stages it on `pin-land/<tag>` and moves main to it once a full CI push run passed there (workflow table
above). A red `pin-land/*` branch takes no hand pushes either: port in a PR of your own.
Unset the variable to go back to PRs. By hand:

1. Set `tag=` and `sha=` in PUBLIC_PIN to the new public release. The sha is
   `gh api repos/open-artifacts-ai/open-artifacts/commits/<tag> --jq .sha`.
2. `SYNCED_FROM` moves to the same release as `PUBLIC_PIN`; the pin-bump
   workflow always does this. Moving it is the claim that every public change
   to the hosted paths or the list since the old `SYNCED_FROM` is already in
   this PR, and CI checks the claim: `pin-check.sh --prev` must be able to
   reverse-apply the public diff to this tree. If public changed a hosted path
   or the list, hand-port it into the PR ("Hand-porting a public fix") or the
   port check fails. Leaving `SYNCED_FROM` behind is only possible while public
   did not change any non-private lockfile importer; otherwise `equivalence.sh`
   fails (CI installs at the pin, equivalence compares at the sync).
3. Build the overlay (`scripts/dev-overlay.sh`) and run `pnpm install` in it
   without `--frozen-lockfile`, to regenerate the merged lockfile. Copy the
   overlay's `pnpm-lock.yaml` back here.
4. Fix whatever the new public release broke, in this repo. A new public route
   needs its classification by hand in `tests/redline/src/surfaces.ts`
   (`INTERACTIVE_ONLY`, `EXCLUDED_ROUTES`, `DROPPED`, each citing a public
   test). The files that follow from it are generated: the pin-bump bot commits
   them, and by hand run, in the overlay's `tests/redline` (after
   `pnpm --filter "@oa/redline^..." build`),
   `node --experimental-strip-types --no-warnings scripts/redline-regen.ts write`
   (`check` fails and prints each route with the list it needs).
5. CI must be green on the PR: it checks out the new tag, so a collision with
   a file public added fails here first.

## Copying the private paths (the sync)

`scripts/sync-from-public.sh <public-checkout>` mirrors each listed path from
the public checkout into this repo (old copies are removed first, only
tracked public files are copied) and writes SYNCED_FROM. It refuses a dirty
public checkout, a listed path public doesn't have, an absolute, root-level
or `..` entry, uncommitted changes under a listed path here, and (once
SYNCED_FROM exists) any listed path that differs from public's copy at
SYNCED_FROM, because that is a CLOUD edit it would destroy. When the list is
public's, it also rewrites `private-paths.txt` from it.

The sync never writes under `.github/workflows/`. A listed hosted workflow
lands in `hosted-workflows/` instead: several run on a schedule or on
`workflow_run`, and must not start here before the cut-over. The cut-over PR
moves them into `.github/workflows/` by hand.

## What CI runs

`scripts/ci-plan.sh` reads this repo's tracked files and makes three sets:
the private packages (each must define `test` and `typecheck`; CI runs them
one by one and logs each), the root-vitest tests in `scripts/ci`,
`scripts/ops` and `scripts/audit`, and every other `*.test.ts`. That last set is private tests
inside public packages (auth-broker's platform-ticket, server's
mcp-sdk-iserror, ...); `scripts/ci-public-tests.sh` runs each through its
owning package's vitest, under whichever of that package's test configs
include it. A test with no owning package, or one no config includes, fails
CI. So does an empty tree once SYNCED_FROM exists.

Public has deleted its hosted code (F1), and the pin is a release without it,
so a plain overlay is strict. A tag from before the delete still contains
every private path and would collide on purpose. CI
uses `--auto-split`, which removes the listed paths from the pinned tree while
they are all there and is strict once none are. The order is: public untangle,
sync, public delete, then a pin bump to the release with the delete.
The hosted workflows live at `.github/workflows/`, so the overlay copies them
to the tree where the private workflow tests read them. `place-workflows.sh`
is still run: it places whatever is parked in `hosted-workflows/` (nothing, now).

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

- Secrets and GitHub environments' remaining values, and the signing and
  release workflow (`hosted-release`, C3). The deploy, publish, floor and
  red-line workflows are live since C2.
