# Orchestrator

`main.mts` takes one GitLab ticket through: branch off an integration branch, implementer run, verifier run (screenshot/video evidence plus a verdict), evidence posted to the ticket, then on PASS push, wait for CI and open an MR into the same integration branch. It never merges and never closes the ticket; once you merge the MR, the next dispatcher pass closes a Task or moves a ticket to `LABELS.done` (see below). Written against `@ai-hero/sandcastle` 0.14.0 with the Docker provider.

```
npx tsx .sandcastle/main.mts --base <integration-branch> [--issue N] [--no-push]
```

## Install into a project

Copy into the project's `.sandcastle/`: `config.mts`, `main.mts`, `dispatch.mts`, `dispatch.sh`, `graph.mts`, `analyze.mts`, `tracker.mts`, `manifests.mts`, `prompt.md`, `prompt.verify.md`, `prompt.analyze.md`, `sandbox/`, and `board.mts` + `board.template.html` from `../board/`. Add `evidence/`, `state/`, `logs/` and `board.html` to `.sandcastle/.gitignore`. The image comes from the `sandcastle-setup` skill (needs the GitLab, web runtime, CMS and Playwright layers). The host needs Node 22.18+, Docker, and `glab` and `claude` on the PATH and logged in.

## What is generic

Branching, the two agent runs and the verifier guard (it must not commit, move HEAD or dirty the tree), evidence upload and the ticket comment, the verdict gate, the push/CI/MR step, and the board updates. The container never holds a GitLab token; every GitLab call runs on the host with its own `glab` auth.

## What to adapt per project

1. **`config.mts`:** GitLab host, project path and id, the milestone, every label Sandcastle filters on or writes (including `LABELS.done`, the stage a ticket moves to once its work is merged), whether Tasks are the units of work (`SUBTASKS`), and the ticket graph settings. `main.mts` and `dispatch.mts` check at startup that every label exists. From a terminal they offer to create missing ones; declining, or running without a terminal (the timer), quits.
2. **`CONFIG` at the top of `main.mts`:** image name, model, CI wait times, and `sandboxSetup` (commands that run in the container before the agent starts).
3. **`sandbox/bootstrap-site.sh`:** installs a throwaway site with synthetic data. The shipped version is Drupal from config (mirrors the project's CI e2e job). A WordPress or other stack needs its own; keep the contract that it ends with the site answering on `http://127.0.0.1`.
4. **`prompt.md`, Environment section:** how the site is reached, how to create content, which test commands to run and which not to.
5. **`prompt.verify.md`:** fixture advice and the before/after procedure. The `git checkout` + `drush updb/cim/cr` steps are Drupal specific.
6. **CI behaviour:** if branch pushes never get a pipeline, the "no pipeline appeared" fallback is the normal path; if they always do, consider dropping it.
7. **Integration branch:** `--base` is required. Some projects use a different integration branch per epic.

## Running many tickets: the dispatcher

`dispatch.mts` lists the tickets that qualify and starts one detached `main.mts --issue N` run for each, up to a cap on concurrent runs.

```
.sandcastle/dispatch.sh [--dry-run] [--max N] [--whole-issues]
```

`dispatch.sh` runs one pass with the defaults: the base is the branch checked out where you run it (it must be on origin). It first checks `node`, `glab`, `claude`, `curl` and Docker are there and logged in; that `.sandcastle/.env` exists and its `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) is accepted by the Anthropic API (an empty request that uses no tokens; the value is never printed); and that the `CONFIG.image` image exists and was built for your UID. From a terminal it builds a missing or mismatched image (`npx sandcastle docker build-image --image-name <CONFIG.image>`); without one, as under the timer, it stops and prints that command. Extra arguments go to `dispatch.mts`, which can also be run directly: `node .sandcastle/dispatch.mts --base <integration-branch> ...`.

- **Which tickets:** milestone and labels are in `config.mts`; the rest (assignee, excluded assignees, author, issue type, confidential, search, order, sort, cap, stagger) is in the `SELECT` block at the top of `dispatch.mts`, each commented with an example.
- **GitLab Tasks.** With `SUBTASKS.enabled` (the default), a ready issue that has Tasks (its "Child items") is a container: each open Task gets its own run, branch and MR, with the parent's description as context. Ready and exclude labels go on the parent; an exclude label on a Task holds back just that Task. An issue without Tasks is one run, as before. `--whole-issues` (or `enabled: false`) makes every ready issue one run, Tasks or not.
- **Merged work.** Every pass checks the runs whose MR merged into their base: a Task is closed, a whole ticket moves to `LABELS.done` (the ready labels come off; it stays open). A parent moves to `LABELS.done` once every one of its Tasks is closed, however they were closed; it is never closed by Sandcastle.
- **Skipped tickets:** any ticket with a running or finished run record, or a `<iid>-*` branch. A failed run is not retried automatically; delete its JSON file from the state dir to retry it. Tickets the ticket graph holds back stay on the board as `queued` with the reason.
- **Capacity:** runs in flight are counted from the board, across all projects sharing the state dir.
- **Logs:** each run writes to `.sandcastle/logs/run-<iid>.log`. Add `logs/` to `.sandcastle/.gitignore`.
- **On a schedule (Linux/systemd):** from the project, run `<sandcastle-helper>/orchestrator/install-dispatch.sh` (or pass the repo path, and `--name` if two repos share a folder name). It installs the template units `sandcastle-dispatch@.service` and `.timer` once, writes `~/.config/sandcastle/dispatch/<name>.env` (the repo path, and a PATH that reaches `node`, `glab`, `claude` and `docker`), and enables `sandcastle-dispatch@<name>.timer`. Each project gets its own timer; the base is the branch checked out in that repo. Each timer re-arms 15 minutes after its pass finishes, so a project's passes never overlap, and a random delay of up to 2 minutes keeps projects from reading the shared run cap at the same moment. List them with `systemctl --user list-timers 'sandcastle-dispatch@*'`, read a project's log with `journalctl --user -u sandcastle-dispatch@<name>`, remove one with `install-dispatch.sh --uninstall <name>`. Run `loginctl enable-linger $USER` so timers keep running when you log out. Replaces the old single-project `sandcastle-dispatch.service`/`.timer`; the installer tells you if one is still installed.

## Ticket graph

Each dispatcher pass works out which tickets can start, so that (a) a ticket doesn't start before the tickets it depends on are merged, and (b) two tickets touching the same files are never in progress at once. The graph lives in the state dir; GitLab issue links are neither read nor written.

- **Manifests.** For each candidate, a read-only `claude -p` (model in `GRAPH.model`; Read, Grep and Glob only) reads the ticket and the code at `origin/<base>` and writes `<stateDir>/graph/<project>--<iid>.json`: what the ticket provides, what it needs that the code doesn't have yet (and which open ticket creates it), and the paths it is likely to change. The analysis runs in a detached worktree under `<stateDir>/worktrees/`.
- **Catalogue.** Blockers can only be open tickets in `TRACKER.milestone`, or in the whole project when no milestone is set. With Tasks, an issue that has them is replaced by its open Tasks (even ones outside the milestone), so sibling Tasks can depend on each other and the parent itself is never a blocker.
- **When it re-analyses.** A manifest is cached on a hash of the ticket's title, description and comments (and, for a Task, its parent's title and description); Sandcastle's own comments (marked `<!-- sandcastle -->`) and label changes don't count. A ticket is re-analysed when that hash changes, when a ticket it depends on is edited, or when it needs something nobody provided and new tickets have appeared. At most `GRAPH.maxAnalysesPerPass` per pass. To fix a wrong blocker, edit the ticket text: the next pass re-analyses it.
- **Who can start.** Its manifest is current, every ticket it depends on is closed or has its Sandcastle branch merged into the base, and its paths don't overlap a live run. A run is live from start until its MR is merged or closed, not just until the MR opens. A live run's real diff replaces its predicted paths once the implementer commits. `GRAPH.conflictIgnore` lists paths whose overlap doesn't count. Dependency cycles are broken by ignoring the weakest edge (logged).
- **Implementer finds a missing prerequisite.** It writes `blocked.json` to the evidence dir instead of committing. If every blocker is an open, unmerged ticket, the run moves to `waiting`, its empty branch is deleted, and the dispatcher relaunches it once the blockers are satisfied. Otherwise (no ticket provides it, or that ticket is already merged or closed) the ticket gets `LABELS.needsHuman` and a comment.
- **Before the MR opens.** If the ticket was edited during the run, the MR says it was built from an older version, with the description diff. `git merge-tree` against other live Sandcastle branches lists any exact conflicts in the MR description.
- **`--dry-run`** runs the analysis (it costs model calls) and prints each ticket's decision without launching, touching the board, or closing and relabelling tickets.
- **Tests:** `node --test 'orchestrator/*.test.mts'` (Node 22.18+).

## Not included

No automatic retry of failed runs. Human-written MRs don't hold their files in the conflict check.
