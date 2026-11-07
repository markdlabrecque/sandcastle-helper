import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { LABELS, TRACKER } from "./config.mts";
import type { Child, Note, Parent } from "./graph.mts";

// Tracker adapter: every tracker call the ticket graph needs. GitLab via `glab` for now; a GitHub
// version would implement the same functions with `gh`.

export interface Ticket {
  iid: number;
  title: string;
  description: string;
  state?: string;
  labels?: string[];
  parent?: Parent; // set on a Task whose parent issue is a container
}

const HOST = TRACKER.gitlabHost;
const ID = TRACKER.projectId;
const enc = encodeURIComponent;

function glab(args: string[]): string {
  return execFileSync("glab", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }).trim();
}
const api = <T,>(path: string): T => JSON.parse(glab(["api", path, "--hostname", HOST]));
/** GET every page of a list endpoint (100 per page). */
function apiAll<T>(path: string): T[] {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const batch = api<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

/** Open tickets the graph can name as blockers: the milestone's, or the whole project's when none is set. */
export function catalogue(milestone = TRACKER.milestone): Ticket[] {
  const filter = milestone ? `&milestone=${enc(milestone)}` : "";
  return apiAll<Ticket>(`projects/${ID}/issues?state=opened${filter}`).map(slim);
}
const slim = (t: Ticket): Ticket => ({ iid: t.iid, title: t.title, description: t.description ?? "", state: t.state, labels: t.labels ?? [] });

/** Open tickets by iid, whatever their milestone. */
function openTickets(iids: number[]): Ticket[] {
  const out: Ticket[] = [];
  for (let i = 0; i < iids.length; i += 50) {
    const q = iids.slice(i, i + 50).map((n) => `iids[]=${n}`).join("&");
    out.push(...apiAll<Ticket>(`projects/${ID}/issues?state=opened&${q}`).map(slim));
  }
  return out;
}

function gql<T>(query: string): T {
  const out = JSON.parse(glab(["api", "graphql", "--hostname", HOST, "-f", `query=${query}`]));
  if (out.errors?.length) throw new Error(`GitLab GraphQL: ${out.errors.map((e: { message: string }) => e.message).join("; ")}`);
  return out.data;
}
type Hierarchy = { iid: string; workItemType: { name: string }; widgets: { parent?: { iid: string } | null; children?: { nodes: { iid: string; state: string; workItemType: { name: string } }[] } }[] };
function hierarchy(iids: number[]): Hierarchy[] {
  const out: Hierarchy[] = [];
  for (let i = 0; i < iids.length; i += 50) {
    const list = iids.slice(i, i + 50).map((n) => JSON.stringify(String(n))).join(",");
    const data = gql<{ project: { workItems: { nodes: Hierarchy[] } } }>(
      `{ project(fullPath: ${JSON.stringify(TRACKER.project)}) { workItems(iids: [${list}], first: 50) { nodes { iid workItemType { name } widgets { ... on WorkItemWidgetHierarchy { parent { iid } children(first: 100) { nodes { iid state workItemType { name } } } } } } } } }`,
    );
    out.push(...data.project.workItems.nodes);
  }
  return out;
}

/** Each issue's Tasks, in board order. Issues without Tasks are left out. */
export function children(iids: number[]): Map<number, Child[]> {
  const map = new Map<number, Child[]>();
  for (const w of hierarchy(iids)) {
    const kids = w.widgets.flatMap((x) => x.children?.nodes ?? []).filter((k) => k.workItemType.name === "Task");
    if (kids.length) map.set(Number(w.iid), kids.map((k) => ({ iid: Number(k.iid), open: k.state === "OPEN" })));
  }
  return map;
}

/** The issue a Task belongs to; undefined for anything that isn't a Task with a parent. */
export function parentOf(iid: number): number | undefined {
  const w = hierarchy([iid])[0];
  if (w?.workItemType.name !== "Task") return undefined;
  const p = w.widgets.find((x) => x.parent)?.parent;
  return p ? Number(p.iid) : undefined;
}

/**
 * The tickets the graph and the implementer see. With subtasks, issues that have Tasks are replaced
 * by their open Tasks (which may sit outside the milestone), each carrying its parent's text.
 */
export function workCatalogue(subtasks: boolean): { tickets: Ticket[]; childrenOf: Map<number, Child[]> } {
  const open = catalogue();
  if (!subtasks) return { tickets: open, childrenOf: new Map() };
  const childrenOf = children(open.map((t) => t.iid));
  const byIid = new Map(open.map((t) => [t.iid, t]));
  const missing = [...childrenOf.values()].flat().filter((k) => k.open && !byIid.has(k.iid)).map((k) => k.iid);
  for (const t of openTickets(missing)) byIid.set(t.iid, t);
  for (const [p, kids] of childrenOf) {
    const parent = byIid.get(p)!;
    for (const k of kids) {
      const t = byIid.get(k.iid);
      if (t) t.parent = { iid: parent.iid, title: parent.title, description: parent.description };
    }
    byIid.delete(p);
  }
  return { tickets: [...byIid.values()], childrenOf };
}

export function ticket(iid: number): Ticket {
  const t = api<Ticket>(`projects/${ID}/issues/${iid}`);
  return { iid: t.iid, title: t.title, description: t.description ?? "", state: t.state };
}

/** Comments, oldest first. */
export function notes(iid: number): Note[] {
  return apiAll<Note>(`projects/${ID}/issues/${iid}/notes?sort=asc&order_by=created_at`).map((n) => ({ body: n.body, system: n.system }));
}

/** Source branches of every open MR in the project. */
export function openMrBranches(): Set<string> {
  return new Set(apiAll<{ source_branch: string }>(`projects/${ID}/merge_requests?state=opened`).map((m) => m.source_branch));
}

export function mergedInto(branch: string, base: string): boolean {
  return api<unknown[]>(`projects/${ID}/merge_requests?state=merged&source_branch=${enc(branch)}&target_branch=${enc(base)}&per_page=1`).length > 0;
}

export function addLabel(iid: number, label: string): void {
  glab(["issue", "update", String(iid), "-R", TRACKER.project, "--label", label]);
}

// REST rather than `glab issue`, which may not accept Tasks.
const put = (iid: number, fields: Record<string, string>) =>
  glab(["api", "-X", "PUT", `projects/${ID}/issues/${iid}`, "--hostname", HOST, ...Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);

export function close(iid: number): void {
  put(iid, { state_event: "close" });
}

/** Move a ticket to the next stage: `LABELS.done` on, the ready labels off. It stays open. */
export function advance(iid: number): void {
  put(iid, { add_labels: LABELS.done, remove_labels: LABELS.ready.join(",") });
}

// ---- merge requests ----------------------------------------------------------

interface MrDetail {
  iid: number;
  sha: string;
  detailed_merge_status: string;
  head_pipeline?: { status: string; sha: string } | null;
}

// GitLab is still working these out; worth waiting for when the caller can.
const SETTLING = ["unchecked", "checking", "preparing", "ci_still_running", "approvals_syncing"];
const RUNNING = ["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"];

/**
 * Why the open MR from `branch` into `base` can't merge now ("" when it can), with its iid and head.
 * It can merge when its head pipeline passed on its head commit and GitLab reports it mergeable.
 */
export function mergeCheck(branch: string, base: string): { reason: string; settling: boolean; iid?: number; sha?: string } {
  const open = api<{ iid: number }[]>(`projects/${ID}/merge_requests?state=opened&source_branch=${enc(branch)}&target_branch=${enc(base)}&per_page=1`);
  if (!open.length) return { reason: "no open MR", settling: false };
  const mr = api<MrDetail>(`projects/${ID}/merge_requests/${open[0].iid}`);
  const head = mr.head_pipeline;
  const pipeline = head && head.sha === mr.sha ? head.status : "none";
  const at = { iid: mr.iid, sha: mr.sha };
  if (pipeline !== "success") return { ...at, reason: `pipeline ${pipeline}`, settling: RUNNING.includes(pipeline) };
  if (mr.detailed_merge_status !== "mergeable") return { ...at, reason: mr.detailed_merge_status, settling: SETTLING.includes(mr.detailed_merge_status) };
  return { ...at, reason: "", settling: false };
}

/**
 * Merge the open MR from `branch` into `base` if `mergeCheck` passes, waiting up to `waitMs` while
 * its pipeline runs or GitLab is still checking. The merge names the checked head commit, so a push
 * after the check makes GitLab refuse it. Never throws; `reason` says why it didn't merge.
 */
export async function mergeIfGreen(branch: string, base: string, waitMs = 0): Promise<{ merged: boolean; reason: string }> {
  const until = Date.now() + waitMs;
  for (;;) {
    let check: ReturnType<typeof mergeCheck>;
    try {
      check = mergeCheck(branch, base);
    } catch (e) {
      return { merged: false, reason: `couldn't read the MR: ${(e as Error).message.split("\n")[0]}` };
    }
    if (!check.reason) {
      try {
        glab(["api", "-X", "PUT", `projects/${ID}/merge_requests/${check.iid}/merge`, "--hostname", HOST, "-f", `sha=${check.sha}`]);
        return { merged: true, reason: "" };
      } catch (e) {
        return { merged: false, reason: `GitLab refused the merge: ${(e as Error).message.split("\n")[0]}` };
      }
    }
    if (!check.settling || Date.now() >= until) return { merged: false, reason: check.reason };
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/**
 * Check every label exists in the project (group labels count). Offer to create missing ones when a
 * person is at the terminal; without one, or if they decline, exit.
 */
export async function ensureLabels(names: string[]): Promise<void> {
  const have = new Set(apiAll<{ name: string }>(`projects/${ID}/labels?include_ancestor_groups=true`).map((l) => l.name));
  const missing = names.filter((n) => !have.has(n));
  if (!missing.length) return;
  const list = missing.map((m) => `"${m}"`).join(", ");
  if (!process.stdin.isTTY) {
    console.error(`Missing label(s) in ${TRACKER.project}: ${list}. Run this once from a terminal to create them, or change LABELS in config.mts.`);
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (const name of missing) {
    const answer = (await rl.question(`Label "${name}" doesn't exist in ${TRACKER.project}. Create it? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      rl.close();
      console.error(`Not creating "${name}". Sandcastle needs it; quitting.`);
      process.exit(1);
    }
    glab(["label", "create", "--name", name, "-R", TRACKER.project]);
    console.log(`Created label "${name}".`);
  }
  rl.close();
}
