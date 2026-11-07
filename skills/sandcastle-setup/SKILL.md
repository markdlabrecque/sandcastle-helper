---
name: sandcastle-setup
description: Set up a project's Sandcastle scaffold from composable layers - GitLab issue tracker via `glab`, then optionally the Docker setup (single-container web runtime with Apache, PHP-FPM, MariaDB and Composer, Drupal (Drush) or WordPress (WP-CLI), Playwright for self-checking) and the workflow from sandcastle-helper (orchestrator, dispatcher with ticket graph, board). Use when setting up Sandcastle with GitLab or for a Drupal/WordPress project, or when `.sandcastle/` still holds the Custom tracker sentinels.
---

# Sandcastle setup (layers)

Sandcastle has no built-in GitLab tracker (maintainer points to `Custom`; upstream #511, #521). Instead of improvising from `SETUP_ISSUE_TRACKER.md`, apply fixed layers from `layers/`. The scaffold is copied into the project, so no fork of Sandcastle is needed.

## Detect (defaults; confirm with the user, don't ask from scratch)
Inspect the project root first and propose these as the answers:
- **Drupal:** `composer.json` requires `drupal/core`, `drupal/core-recommended` or `drupal/cms`, or `web/core/` / `docroot/core/` exists. Docroot is the dir holding `core/` (usually `web/`). Layers: web + Drupal + Playwright.
- **WordPress:** `wp-config.php`, `wp-content/` or `wp-includes/` at the root or in `web/`/`public/`/`wp/`, or `composer.json` requires `johnpbloch/wordpress*` or `roots/wordpress*`. Docroot is the dir holding `wp-config.php` (or `wp-load.php`). Layers: web + WordPress + Playwright.
- **PHP_VERSION:** `.ddev/config.yaml` `php_version`, else `composer.json` `config.platform.php`, else the minor from `require.php`, else 8.3. Use the minor only (`8.3`).
- **Both or neither matched:** ask. Not a PHP/web project: offer tracker layer only.
- **ddev in tests:** if project tests or scripts call `ddev drush|wp|composer|exec`, propose the ddev shim layer. The host keeps DDEV; only the sandbox bypasses it.
- **Tracker:** the GitLab layer is the default when `git remote get-url origin` points at a GitLab host (e.g. git.affinitybridge.com); use that host as `GITLAB_HOST`.
Report what was detected and why (which file matched) in one line, then confirm.

**Database:** MariaDB for both Drupal and WordPress (decided 2026-11-05). SQLite deferred: Drupal supports it natively, WordPress needs the SQLite Database Integration plugin, and prod dumps are MySQL-shaped.

## Layers
| Layer | Dir | Needs |
| --- | --- | --- |
| Tracker: GitLab | `layers/tracker-gitlab/` | `GITLAB_HOST` (default git.affinitybridge.com), `LABEL` (default `Sandcastle`; only for the init template's prompt, see Base install step 3), `GLAB_VERSION` |
| Runtime: web | `layers/runtime-web/` | `PHP_VERSION`; Docker only (services need root); docroot from Detect |
| CMS: Drupal | `layers/cms-drupal/` | web runtime; the project's own Drush (`drush/drush` in `composer.json`), linked as `drush` |
| CMS: WordPress | `layers/cms-wordpress/` | web runtime |
| Browser: Playwright | `layers/browser-playwright/` | `PLAYWRIGHT_VERSION` (npm); works without the web layer too. If the project has `@playwright/test`, use the `playwright-core` version from its lockfile so the project's own test runner finds the matching browser build |
| Compat: ddev shim | `layers/compat-ddev/` | web runtime; add when the project's scripts or tests shell out to `ddev` (`grep -rl 'ddev ' tests/ scripts/`) |

Substitute `{{VARS}}` in snippets with the chosen values. Pin versions; look up current ones.

## Status
- Verified (2026-11-05): web + Playwright layers build on `node:22-bookworm`; running as root, `start-web.sh` serves PHP 8.3 with a working MariaDB connection and headless Chromium loads the page. (That build used the Drush launcher, since removed: the Drupal layer now only links the project's `vendor/bin/drush`.)
- Verified (2026-11-06, islandhealth/public-site, Drupal 10 / PHP 8.4): the ddev shim layer. As the non-root `agent` user, a project Playwright spec that seeds content via `ddev drush ev` passed, and the `drush` link ran the project's Drush against the sandbox site (`BASE_URL=http://127.0.0.1`). Specs that read existing published content still need fixtures, since the sandbox site is a fresh install.
- **Not verified:** the GitLab layer (`glab` flags, install URL); starting services via a Sandcastle sandbox hook (`sudo: true`) with the non-root `agent` user; the WP-CLI layer.

## Steps

### Base install (always)
1. Run **Detect** above and confirm the values. Check the branch is clean. If `.sandcastle/` doesn't exist, `npx sandcastle init` with tracker **Custom** and the **Docker** provider (always Docker, not Podman).
2. **Fail loudly if the scaffold moved.** Grep `.sandcastle/` for `No issue tracker configured`, `<view command`, `<close command`, `TODO: install your issue tracker`. If any is missing, stop and say which.
3. Tracker layer: substitute list/view/close from `tracker-gitlab/commands.md` for the markers. These markers live in the init template's own `prompt.md` and `main.mts` (e.g. `simple-loop`); `LABEL` only filters that template's issue list. Use the default and don't ask about it, create it, or reconcile it with anything: if the workflow is chosen later, its files replace these and its labels come from `config.mts`. Put `.env` lines from `env.snippet` into `.sandcastle/.env` and `.env.example`; **leave `GITLAB_TOKEN` empty, tell the user to fill it** (never fetch it from 1Password). Replace the Dockerfile's `# TODO: install your issue tracker's CLI` line with `glab.Dockerfile.snippet`.
4. Verify: `glab auth status --hostname <host>`.

### Then ask: two separate questions
Once the base install is done, ask the user, as two separate yes/no questions (not one combined question):
1. **Docker setup?** Adds the web runtime, CMS and Playwright layers that Detect proposed, so agents can run and check the site.
2. **Workflow?** Adds the sandcastle-helper workflow: the one-ticket orchestrator (implement, verify with evidence, MR), the dispatcher with its ticket graph, and the board.

The workflow's verifier needs the web runtime and Playwright. If the user wants the workflow but declines the Docker setup and the image doesn't already have those layers, say so and ask again before going on. Do whichever parts they chose, Docker first.

### Docker setup (if chosen)
1. Add the chosen `*.Dockerfile.snippet` files after the glab one, in order: web, CMS, ddev shim, Playwright. Copy `runtime-web/start-web.sh` (and `compat-ddev/ddev-shim.sh` with the shim) into `.sandcastle/` (the snippets COPY them; they must be in the build context).
2. Web layer hook: `start-web.sh <detected docroot>` run as root once the sandbox is ready. With the workflow, it goes in `CONFIG.sandboxSetup` in `main.mts` (`{ command: "start-web.sh <docroot>", sudo: true }`); without it, add `hooks: { sandbox: { onSandboxReady: [{ command: "start-web.sh <docroot>", sudo: true }] } }` to the init template's `main.mts`. Project code reaches Playwright's global install via `NODE_PATH=$(npm root -g)` (ESM ignores it; use CJS or install `playwright` in the project).
3. Verify: build the image (`npx sandcastle docker build-image`); a `maxIterations: 1` run on a throwaway ticket where the agent starts the web layer, loads the page with Playwright, and closes the ticket.
4. Prompt conventions (the init template's prompt; skip with the workflow, which ships its own): state the label; commit messages start with the ticket ref (`#425: ...`); `glab mr create` titles start `#<iid>: `; tell the agent to check its work with the web server and Playwright before committing.

### Workflow (if chosen)
Source: a sandcastle-helper checkout. Ask for its path (default `~/Projects/sandcastle-helper`); if there is none, `gh repo clone markdlabrecque/sandcastle-helper` into a temp dir. Follow its `orchestrator/ADAPTING.md` ("Install into a project" and "What to adapt per project"):
1. Copy the files ADAPTING.md lists into `.sandcastle/`, overwriting the init template's `main.mts` and `prompt.md` (the base install's list/close substitutions and `LABEL` go with them; the workflow's host-side code does that work with the host's `glab` login, so `GITLAB_TOKEN` in `.env` stays unused). Delete the template's other prompt files if it shipped any.
2. Fill in `config.mts`: GitLab host, project path and numeric id (`glab api projects/<url-encoded path>`), and the milestone (ask which; unset means every open ticket in the project). Labels: show the shipped `LABELS` (ready, exclude, needs-human, and done: the stage a ticket moves to once merged, default `Internal QA`) and ask once whether to keep them. `SUBTASKS.enabled` (one run per GitLab Task) stays on unless the user says otherwise. `MERGE.whenCiPasses` (merge an MR once its pipeline passes; review happens on the integration branch) is on by default: ask once whether to keep it. Don't bring the base install's `LABEL` into this.
3. Set `CONFIG.image` in `main.mts` to this project's image, and put the web hook in `CONFIG.sandboxSetup` (see Docker setup step 2).
4. Adapt `sandbox/bootstrap-site.sh`, the Environment section of `prompt.md`, and `prompt.verify.md` to this project's stack. The shipped `bootstrap-site.sh` is Drupal-only; WordPress needs a new one that ends with the site answering on `http://127.0.0.1`.
5. Add `@ai-hero/sandcastle` and `tsx` as dev dependencies, and `evidence/`, `state/`, `logs/` and `board.html` to `.sandcastle/.gitignore`. The host needs Node 22.18+, and `glab` and `claude` logged in.
6. Verify: with the integration branch checked out, `.sandcastle/dispatch.sh --dry-run` from a terminal (it builds the image if it's missing) and show the user the output. It checks the labels exist; ask before letting it create any.

## Reuse
Commit the edited `.sandcastle/`. Next project: rerun this skill, changing only host, label and CMS.
