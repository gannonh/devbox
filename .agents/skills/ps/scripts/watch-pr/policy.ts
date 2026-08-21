import { WatcherQueryError, resolveChecks } from "./github.ts";
import type * as T from "./types.ts";
import { nonEmpty } from "./types.ts";
export function assessGitHubMerge(args: {
  readonly mergeStateStatus: T.MergeStateStatus;
  readonly headRollupState: T.RollupState;
}): T.GitHubMergeAssessment {
  if (args.mergeStateStatus === "BLOCKED") {
    if (args.headRollupState === "ERROR" || args.headRollupState === "FAILURE")
      return {
        kind: "refused",
        mergeStateStatus: args.mergeStateStatus,
        headRollupState: args.headRollupState,
      };
    return {
      kind: "allowed",
      basis: "rollup",
      mergeStateStatus: args.mergeStateStatus,
      headRollupState: args.headRollupState,
    };
  }
  return {
    kind: "allowed",
    basis: "merge-state",
    mergeStateStatus: args.mergeStateStatus,
    headRollupState: args.headRollupState,
  };
}
async function mergeAssessment(
  reader: T.GitHubReader,
  facts: T.PullRequestFacts
) {
  const commits = await reader.commitRollups(facts.context);
  const headRollupState =
    facts.headRefOid === null
      ? null
      : (commits.find((commit) => commit.oid === facts.headRefOid)?.state ??
        null);
  return {
    hadPreviousPassingCi: commits.some(
      (commit) => commit.oid !== facts.headRefOid && commit.state === "SUCCESS"
    ),
    github: assessGitHubMerge({
      mergeStateStatus: facts.mergeStateStatus,
      headRollupState,
    }),
  };
}
const AUTOMATION_TOKENS = [
  "bugbot",
  "coderabbit",
  "security review",
  "pr review automation",
  "review automation",
] as const;
export async function readSnapshot(args: {
  readonly reader: T.GitHubReader;
  readonly context: T.PrContext;
  readonly pendingHistory: "include" | "omit";
  readonly allowDraft: boolean;
}): Promise<T.PrSnapshot> {
  const facts = await args.reader.pullRequest(args.context);
  if (facts.state === "MERGED" || facts.mergedAt !== null)
    return { kind: "merged", context: args.context, facts };
  if (facts.state === "CLOSED")
    return { kind: "closed", context: args.context, facts };
  const threads = await args.reader.reviewThreads(args.context);
  const checks = await resolveChecks(args.reader, args.context);
  const failed = nonEmpty(
    checks.checks.filter(
      (check): check is T.FailedCheck => check.kind === "failed"
    )
  );
  const pending = nonEmpty(
    checks.checks.filter(
      (check): check is T.PendingCheck => check.kind === "pending"
    )
  );
  let ci: T.CiState;
  if (failed === null && pending !== null && args.pendingHistory === "omit")
    ci = {
      kind: "ci-pending",
      source: checks.source,
      all: checks.checks,
      failed: [],
      pending,
      hadPreviousPassingCi: false,
    };
  else {
    const merge = await mergeAssessment(args.reader, facts);
    const base = {
      source: checks.source,
      all: checks.checks,
      hadPreviousPassingCi: merge.hadPreviousPassingCi,
    };
    if (failed !== null)
      ci = {
        ...base,
        kind: "ci-failing",
        failed,
        pending: pending ?? [],
        github: merge.github,
      };
    else if (merge.github.kind === "refused")
      ci = {
        ...base,
        kind: "ci-github-rejected",
        failed: [],
        pending: pending ?? [],
        github: merge.github,
      };
    else if (pending !== null)
      ci = { ...base, kind: "ci-pending", failed: [], pending };
    else
      ci = {
        ...base,
        kind: "ci-clean",
        failed: [],
        pending: [],
        github: merge.github,
      };
  }
  return {
    kind: "open",
    context: args.context,
    facts,
    threads,
    ci,
    reviewAutomationRunning: checks.checks.some(
      (check) =>
        check.kind === "pending" &&
        AUTOMATION_TOKENS.some((token) =>
          check.name.toLowerCase().includes(token)
        )
    ),
  };
}
const conflictBlocker = (row: T.PrSnapshot): T.MergeBlocker | null =>
  row.kind === "open" &&
  (row.facts.mergeable === "CONFLICTING" ||
    row.facts.mergeStateStatus === "DIRTY" ||
    row.facts.mergeStateStatus === "CONFLICTING")
    ? { kind: "merge-conflicts", pr: row.context, facts: row.facts }
    : null;
function threadBlocker(row: T.PrSnapshot): T.MergeBlocker | null {
  if (row.kind !== "open") return null;
  const threads = nonEmpty(row.threads);
  return threads === null
    ? null
    : { kind: "review-threads", pr: row.context, threads };
}
const ciBlocker = (row: T.PrSnapshot): T.MergeBlocker | null =>
  row.kind === "open" &&
  (row.ci.kind === "ci-failing" || row.ci.kind === "ci-github-rejected")
    ? { kind: "failing-checks", pr: row.context, ci: row.ci }
    : null;
function gateReason(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.MergeGateReason | null {
  if (row.kind === "merged") return null;
  if (row.kind === "closed") return "closed-without-merge";
  if (row.facts.isDraft && !allowDraft) return "draft-pr";
  if (row.facts.reviewDecision === "CHANGES_REQUESTED")
    return "changes-requested";
  // Branch protection requiring approvals that have not arrived. GitHub
  // refuses the merge, so READY here would be a false merge-ready report.
  return row.facts.reviewDecision === "REVIEW_REQUIRED"
    ? "review-required"
    : null;
}
function gateBlocker(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.MergeBlocker | null {
  const reason = gateReason(row, allowDraft);
  return reason === null ||
    (reason === "draft-pr" &&
      row.kind === "open" &&
      row.ci.kind === "ci-pending")
    ? null
    : { kind: "merge-gate", pr: row.context, reason };
}
function readyContribution(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.ReadyPr | T.MergedPr | null {
  if (row.kind === "merged")
    return {
      kind: "merged-pr",
      context: row.context,
      mergedAt: row.facts.mergedAt,
    };
  if (
    row.kind !== "open" ||
    row.ci.kind !== "ci-clean" ||
    row.threads.length !== 0 ||
    conflictBlocker(row) !== null ||
    gateReason(row, allowDraft) !== null
  )
    return null;
  const reviewDecision = row.facts.reviewDecision;
  if (reviewDecision === "CHANGES_REQUESTED" || reviewDecision === "REVIEW_REQUIRED")
    return null;
  return {
    kind: "ready-pr",
    context: row.context,
    proof: {
      mergeability: "clear",
      threads: [],
      ci: row.ci,
      gate: {
        state: "OPEN",
        reviewDecision,
        draft: row.facts.isDraft ? "draft-allowed" : "not-draft",
      },
    },
  };
}
export function classifyPr(
  row: T.PrSnapshot,
  allowDraft = false
): T.PrDecision {
  for (const blocker of [
    conflictBlocker(row),
    threadBlocker(row),
    ciBlocker(row),
    gateBlocker(row, allowDraft),
  ])
    if (blocker !== null) return { kind: "blocker", blocker };
  if (row.kind === "open" && row.ci.kind === "ci-pending")
    return { kind: "waiting", waiting: row.context, pending: row.ci.pending };
  // GitHub is still computing mergeability. READY is terminal, so emitting it
  // here would lock in a verdict that was never provable.
  if (row.kind === "open" && row.facts.mergeable === "UNKNOWN")
    return { kind: "mergeability-unknown", waiting: row.context };
  const ready = readyContribution(row, allowDraft);
  if (ready === null) throw new Error("snapshot has no classified decision");
  return ready.kind === "merged-pr"
    ? { kind: "merged", pr: ready }
    : { kind: "ready", pr: ready };
}
export const queryBackoffSeconds = (
  interval: number,
  failures: number
): number => Math.min(Math.max(interval, 60) * 2 ** (failures - 1), 300);
interface Envelope<M extends T.WatchMode> {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly observedAt: string;
  readonly mode: M;
}
type Payload<V> = V extends unknown
  ? Omit<V, keyof Envelope<T.WatchMode>>
  : never;
type VerdictPayload = Payload<T.WatcherVerdict>;
export interface VerdictStamp<M extends T.WatchMode = T.WatchMode> {
  <const P extends VerdictPayload>(payload: P): Envelope<M> & P;
  <const P extends VerdictPayload, M2 extends T.WatchMode>(
    payload: P,
    mode: M2
  ): Envelope<M2> & P;
}
export function verdictFactory<M extends T.WatchMode>(
  clock: WatchClock,
  mode: M
): VerdictStamp<M> {
  let sequence = 0;
  function stamp<const P extends VerdictPayload>(payload: P): Envelope<M> & P;
  function stamp<const P extends VerdictPayload, M2 extends T.WatchMode>(
    payload: P,
    mode: M2
  ): Envelope<M2> & P;
  function stamp<const P extends VerdictPayload>(
    payload: P,
    override?: T.WatchMode
  ): Envelope<T.WatchMode> & P {
    return {
      schemaVersion: 1,
      sequence: (sequence += 1),
      observedAt: clock.observedAt(),
      mode: override ?? mode,
      ...payload,
    };
  }
  return stamp;
}
function blockerVerdict(
  stamp: VerdictStamp,
  blocker: T.MergeBlocker
): T.BlockerVerdict {
  switch (blocker.kind) {
    case "merge-conflicts":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 2, blocker });
    case "review-threads":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 3, blocker });
    case "failing-checks":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 4, blocker });
    case "merge-gate":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 6, blocker });
    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}
export function statusQueryVerdict(
  stamp: VerdictStamp,
  failures: number,
  failure: T.QueryFailure
): T.BlockerVerdict {
  return stamp({
    kind: "BLOCKER",
    terminal: true,
    exitCode: 7,
    blocker: { kind: "status-query", failures, failure },
  });
}
export interface WatchClock {
  now(): number;
  observedAt(): string;
  sleep(seconds: number): Promise<void>;
}
export interface RunDependencies {
  readonly reader: T.GitHubReader;
  readonly clock: WatchClock;
  readonly emit: (verdict: T.ProgressVerdict) => void;
}
const deadlinePassed = (
  started: number,
  options: T.PollingOptions,
  now: number
): boolean => options.timeout > 0 && now - started >= options.timeout;
type StepResult<V> =
  | { readonly kind: "terminal"; readonly verdict: V }
  | {
      readonly kind: "sleep";
      readonly seconds: number;
      readonly onDeadline?: () => V;
    }
  | { readonly kind: "continue" };
async function pollUntilTerminal<V>(args: {
  readonly dependencies: RunDependencies;
  readonly options: T.PollingOptions;
  readonly stamp: VerdictStamp;
  readonly step: () => Promise<StepResult<V>>;
}): Promise<V | T.BlockerVerdict | T.TimeoutVerdict> {
  let failures = 0;
  const started = args.dependencies.clock.now();
  while (true) {
    let result: StepResult<V>;
    try {
      result = await args.step();
      failures = 0;
    } catch (error) {
      if (!(error instanceof WatcherQueryError)) throw error;
      failures += 1;
      if (!error.failure.retryable || failures >= args.options.maxQueryErrors)
        return statusQueryVerdict(args.stamp, failures, error.failure);
      const retryInSeconds = queryBackoffSeconds(
        args.options.interval,
        failures
      );
      args.dependencies.emit(
        args.stamp({
          kind: "RETRY",
          terminal: false,
          failure: error.failure,
          consecutiveFailures: failures,
          retryInSeconds,
        })
      );
      if (deadlinePassed(started, args.options, args.dependencies.clock.now()))
        return args.stamp({
          kind: "TIMEOUT",
          terminal: true,
          exitCode: 5,
          reason: { kind: "status-unavailable", failure: error.failure },
        });
      await args.dependencies.clock.sleep(retryInSeconds);
      continue;
    }
    if (result.kind === "terminal") return result.verdict;
    if (result.kind === "sleep") {
      if (
        result.onDeadline !== undefined &&
        deadlinePassed(started, args.options, args.dependencies.clock.now())
      )
        return result.onDeadline();
      await args.dependencies.clock.sleep(result.seconds);
    }
  }
}
export async function runSimple(args: {
  readonly dependencies: RunDependencies;
  readonly contexts: T.NonEmpty<T.PrContext>;
  readonly mode: T.WatchMode;
  readonly statusOnly: boolean;
  readonly options: T.PollingOptions;
}): Promise<T.TerminalVerdict> {
  const stamp = verdictFactory(args.dependencies.clock, args.mode);
  const step = async (): Promise<StepResult<T.TerminalVerdict>> => {
    const rows: T.PrSnapshot[] = [];
    for (const context of args.contexts)
      rows.push(
        await readSnapshot({
          reader: args.dependencies.reader,
          context,
          pendingHistory: "include",
          allowDraft: args.options.allowDraft,
        })
      );
    const complete = nonEmpty(rows);
    if (complete === null) throw new Error("watch context cannot be empty");
    if (args.statusOnly)
      return {
        kind: "terminal",
        verdict: stamp({
          kind: "STATUS",
          terminal: true,
          exitCode: 0,
          reason: "status-only",
          rows: complete,
        }),
      };
    const decision = classifyPr(complete[0], args.options.allowDraft);
    if (decision.kind === "blocker")
      return {
        kind: "terminal",
        verdict: blockerVerdict(stamp, decision.blocker),
      };
    if (decision.kind === "ready" || decision.kind === "merged")
      return {
        kind: "terminal",
        verdict: stamp(
          {
            kind: "READY",
            terminal: true,
            exitCode: 0,
            pr: decision.pr,
          },
          args.mode
        ),
      };
    const waitReason =
      decision.kind === "waiting"
        ? ({ kind: "pending-checks", pending: decision.pending } as const)
        : ({ kind: "mergeability-unknown" } as const);
    args.dependencies.emit(
      stamp({
        kind: "WAITING",
        terminal: false,
        waiting: decision.waiting,
        reason: waitReason,
      })
    );
    return {
      kind: "sleep",
      seconds: args.options.interval,
      onDeadline: () =>
        stamp({
          kind: "TIMEOUT",
          terminal: true,
          exitCode: 5,
          reason:
            waitReason.kind === "pending-checks"
              ? { kind: "pending-checks", pending: waitReason.pending }
              : { kind: "mergeability-unknown" },
        }),
    };
  };
  return pollUntilTerminal({
    dependencies: args.dependencies,
    options: args.options,
    stamp,
    step,
  });
}
