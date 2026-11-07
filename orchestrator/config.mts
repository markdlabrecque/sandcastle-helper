// Project settings shared by main.mts and dispatch.mts. Edit this file when adapting to a project.

export const TRACKER = {
  gitlabHost: "git.affinitybridge.com",
  project: "islandhealth/public-site", // path with namespace
  projectId: 699,
  // Project-level milestone (title). The dispatcher only picks tickets in it, and the ticket graph
  // looks for blockers among its open tickets. undefined = every open ticket in the project.
  milestone: undefined as string | undefined,
};

// Every label Sandcastle filters on or writes. main.mts and dispatch.mts check they all exist in the
// project at startup and offer to create any that are missing; declining quits the run.
export const LABELS = {
  // A ticket must carry ALL of these to be picked.
  ready: ["Ready to do", "ready-for-agent"],
  // A ticket carrying ANY of these is never picked.
  exclude: ["blocked", "needs-human", "wontfix"],
  // Added to a ticket when the implementer reports a blocker the graph can't resolve: one with no
  // providing ticket, or one that is already merged or closed. Keep it in `exclude`.
  needsHuman: "needs-human",
  // The stage a ticket moves to once its work is merged into the integration branch: a whole ticket
  // when its MR merges, a parent once every one of its Tasks is closed. The `ready` labels come off
  // and this one goes on; the ticket stays open.
  done: "Internal QA",
};

export const allLabels = () => [...new Set([...LABELS.ready, ...LABELS.exclude, LABELS.needsHuman, LABELS.done])];

// GitLab Tasks (the "Child items" on an issue).
export const SUBTASKS = {
  // true: a ready issue with Tasks is a container, and each open Task is a run of its own (closed
  // once its branch merges). false, or `--whole-issues` on dispatch.mts / main.mts: every ready issue
  // is one run, Tasks or not.
  enabled: true,
};

// Merging. Review happens on the integration branch after the work is merged, so by default a
// Sandcastle MR is merged as soon as its pipeline has passed on the MR's head commit and GitLab says
// it can merge (no conflicts, nothing else blocking). main.mts tries right after opening the MR; every
// dispatcher pass retries the ones still open. An MR with no pipeline at all is never merged.
// false: MRs stay open for you to merge.
export const MERGE = {
  whenCiPasses: true,
};

// Ticket graph: dependency analysis and conflict holds (see graph.mts).
export const GRAPH = {
  model: "sonnet", // model for the read-only analysis run on the host
  maxAnalysesPerPass: 5, // a new milestone fills in over a few dispatcher passes
  analysisTimeoutMinutes: 10,
  // Paths whose overlap never holds a ticket back: exact file, or directory ending in "/".
  conflictIgnore: [] as string[],
  // Manifests of tickets that left the catalogue are deleted after this long.
  pruneAfterDays: 30,
};
