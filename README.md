# sandcastle-helper

Helpers for [Sandcastle](https://github.com/mattpocock/sandcastle) setups.

- `skills/sandcastle-setup/` - Claude Code skill that scaffolds `.sandcastle/` from layers (GitLab tracker, web runtime, Drupal/WordPress, ddev shim, Playwright), and optionally installs the workflow below. Copy to `~/.claude/skills/` (and `~/.agents/skills/` for other agents).
- `orchestrator/` - one-ticket loop: implement, verify with screenshot/video evidence, post to the ticket, push, open the MR and merge it once its pipeline passes (review happens on the integration branch; `MERGE` in `config.mts` turns this off). Plus a dispatcher that starts many runs, held back by an agent-built ticket graph (dependencies and file conflicts). A ready issue with GitLab Tasks gets one run per Task; once MRs merge, the dispatcher closes the Tasks and moves finished tickets to the next stage (`Internal QA` by default). `dispatch.sh` runs a pass with the defaults. Start with `orchestrator/ADAPTING.md`.
- `board/` - run-state store and treasure-map status board. `board.mts` writes `.sandcastle/state/<project>--<iid>.json` per run and regenerates a self-contained `board.html` from `board.template.html`. Copy both into a project's `.sandcastle/`.
  - `board-server.mts`, `sandcastle-board.service`, `install-service.sh` - always-on version: a systemd user service (macOS: `com.sandcastle.board.plist` + `install-launchd.sh`, a launchd user agent) serving the board at `http://127.0.0.1:4444` (and each run's evidence under `/evidence/`) from one shared state folder. Node 22.18+. Run `board/install-service.sh` (Linux) or `board/install-launchd.sh` (macOS), then `export SANDCASTLE_STATE_DIR=$HOME/.local/state/sandcastle` wherever runs start, so every project and worktree reports to the one board.

Without the service, the board assumes it runs from a repo root containing `.sandcastle/` and writes `.sandcastle/board.html`.

## Setting up a project

1. Run the `sandcastle-setup` skill in the project. It does the base install (Sandcastle scaffold and GitLab tracker), then asks separately whether to add the Docker setup (web runtime, CMS and Playwright layers) and the workflow (orchestrator, dispatcher, ticket graph, board).
2. For a project set up before the skill offered the workflow, ask Claude to install it with this prompt. Replace `<sandcastle-helper>` with where this repo is checked out, and fill in `<MILESTONE>` and `<BASE>`:

```text
Install the Sandcastle workflow from <sandcastle-helper> into this project's .sandcastle/,
following <sandcastle-helper>/orchestrator/ADAPTING.md ("Install into a project" and
"What to adapt per project"). sandcastle-setup has already run here, so the Dockerfile and
tracker layer exist.

- Copy the files ADAPTING.md lists, including board.mts and board.template.html from board/.
- Fill in config.mts for this project: GitLab host, project path and numeric id (look it up with
  glab), labels (including the done stage, default "Internal QA"), and milestone "<MILESTONE>" (or leave it unset to use every open ticket).
- The workflow's main.mts and prompt.md replace the ones `sandcastle init` created. Move the
  start-web.sh hook that sandcastle-setup added to the old main.mts into CONFIG.sandboxSetup
  in the new one. Set CONFIG.image to this project's image name. Labels come only from
  config.mts; ignore the label in the old prompt.md.
- Adapt sandbox/bootstrap-site.sh, the Environment section of prompt.md, and prompt.verify.md
  to this project's stack.
- Make sure the Dockerfile's Drupal layer matches
  <sandcastle-helper>/skills/sandcastle-setup/layers/cms-drupal/drush.Dockerfile.snippet
  (a link to the project's own vendor/bin/drush, not a Drush download).
- Add @ai-hero/sandcastle and tsx as dev dependencies, and evidence/, state/, logs/ and
  board.html to .sandcastle/.gitignore.
- Rebuild the image, then, with <BASE> checked out, run `.sandcastle/dispatch.sh --dry-run` from a
  terminal and show me the output. Ask me before creating any GitLab label.
Work on a branch, and don't push.
```

For WordPress, leave out the Drupal layer step. The shipped `bootstrap-site.sh` is Drupal-only, so expect the agent to write a WordPress one.

3. Review the dry run: it shows which tickets the graph would start and why the others wait. Then run passes by hand or start the dispatcher timer (below).

## Running the dispatcher

From the project, with the integration branch checked out:

```sh
.sandcastle/dispatch.sh --dry-run   # show what would start, launch nothing
.sandcastle/dispatch.sh             # one real pass
```

It uses the checked-out branch as the base (it must be on origin), checks that `node`, `glab`, `claude` and Docker are there and logged in, and that the image in `CONFIG.image` exists and was built for your user. From a terminal it builds a missing or mismatched image; under the timer it stops and prints the build command instead. Other arguments go to `dispatch.mts`: `--max N` (concurrent runs, default 3) and `--whole-issues` (one run per issue, ignoring Tasks).

Retry a failed run by deleting its record, `~/.local/state/sandcastle/<project>--<iid>.json` (or `.sandcastle/state/` without the shared state dir). The next pass picks the ticket up again.

### On a schedule (Linux)

Each project gets its own systemd user timer, `sandcastle-dispatch@<name>.timer`, which runs a pass 15 minutes after the last one finished. All projects share the run cap and the board. There's no launchd version for the dispatcher yet, so on macOS run passes by hand.

```sh
cd ~/Projects/<project>                       # with the integration branch checked out
.sandcastle/dispatch.sh --dry-run             # once from a terminal: builds the image, checks logins
<sandcastle-helper>/orchestrator/install-dispatch.sh            # name = the repo folder's name
<sandcastle-helper>/orchestrator/install-dispatch.sh --name foo # if two repos share a folder name
loginctl enable-linger $USER                  # once per machine: keep timers running when logged out
```

```sh
systemctl --user list-timers 'sandcastle-dispatch@*'   # every project's next pass
journalctl --user -u sandcastle-dispatch@<name> -f     # one project's dispatcher log
<sandcastle-helper>/orchestrator/install-dispatch.sh --uninstall <name>
```

The timer never builds the image: after a Dockerfile change, run `.sandcastle/dispatch.sh --dry-run` from a terminal to rebuild it. To change a project's base, check out the other branch in its repo; the next pass uses it.

Upgrading from the single-project timer:

```sh
systemctl --user disable --now sandcastle-dispatch.timer
rm ~/.config/systemd/user/sandcastle-dispatch.{service,timer}
```

then run `install-dispatch.sh` from each project.

### Updating a project's copy of the workflow

Projects run their own copy of the files in `.sandcastle/`, so changes here don't reach them on their own. After pulling this repo, copy the files listed in `orchestrator/ADAPTING.md` ("Install into a project") into the project again, except the ones you adapted (`config.mts`, `main.mts`'s `CONFIG`, `prompt.md`, `prompt.verify.md`, `sandbox/bootstrap-site.sh`): merge changes into those by hand. Then check new settings in `config.mts` against the shipped one, and run `.sandcastle/dispatch.sh --dry-run`.

### On a new machine

```sh
git clone <project> && cd <project> && git checkout <integration branch>
npm install
cp .sandcastle/.env.example .sandcastle/.env    # then fill it in; it's gitignored
glab auth login --hostname <gitlab host>
claude auth login
.sandcastle/dispatch.sh --dry-run               # builds this machine's image
```

Each machine builds its own image (CPU architecture and user ID differ). Don't run dispatchers for the same project on two machines: each keeps its own state, so they would start the same tickets twice.
