import type * as T from "./types.ts";
export const renderJson = (verdict: T.WatcherVerdict): string =>
  `${JSON.stringify(verdict)}\n`;
function ciCell(row: T.PrSnapshot): string {
  if (row.kind !== "open") return "\u2014";
  const was = row.ci.hadPreviousPassingCi ? ", was ✅" : "";
  switch (row.ci.kind) {
    case "ci-clean":
      return "✅";
    case "ci-pending":
      return `⏳ ${row.ci.pending.length} pending${was}`;
    case "ci-failing":
      return `❌ ${row.ci.failed.length} failed${row.ci.pending.length ? `, ${row.ci.pending.length} pending` : ""}${was}`;
    case "ci-github-rejected":
      return `❌ GitHub reports failing checks${was}`;
    default: {
      const exhaustive: never = row.ci;
      return exhaustive;
    }
  }
}
function reviewCell(row: T.PrSnapshot): string {
  if (row.kind !== "open") return "\u2014";
  const open = row.threads.length;
  return row.reviewAutomationRunning
    ? open
      ? `🤖 running, ${open} open`
      : "🤖 running"
    : open
      ? `📝 ${open} open`
      : "✅";
}
function mergeCell(row: T.PrSnapshot): string {
  if (row.kind === "merged") return "✅ merged";
  if (row.kind === "closed") return "❌ closed";
  if (row.facts.isDraft) return "⏸ draft";
  if (row.facts.reviewDecision === "CHANGES_REQUESTED")
    return "⚠️ changes requested";
  return row.facts.mergeable === "CONFLICTING" ||
    row.facts.mergeStateStatus === "DIRTY" ||
    row.facts.mergeStateStatus === "CONFLICTING"
    ? "⚠️ conflict"
    : "✅";
}
export function renderStatusTable(rows: T.NonEmpty<T.PrSnapshot>): string {
  const lines = ["| PR | CI | Review | Merge |", "| --- | --- | --- | --- |"];
  for (const row of rows) {
    const url = `https://github.com/${row.context.owner}/${row.context.repo}/pull/${row.context.number}`;
    lines.push(
      `| [#${row.context.number}](${url}) | ${ciCell(row)} | ${reviewCell(row)} | ${mergeCell(row)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
function threadLine(thread: T.ReviewThread): string {
  const comment = thread.firstComment;
  return [
    thread.id,
    comment?.path ?? "None",
    comment?.line ?? "None",
    comment?.authorLogin ?? "None",
    `isReviewBot=${thread.isReviewBot}`,
    `reviewBotPasses=${thread.reviewBotPasses}`,
    (comment?.body ?? "").split(/\r?\n/, 1)[0]?.slice(0, 180) ?? "",
  ].join(" ");
}
type StatusQueryBlocker = {
  readonly kind: "status-query";
  readonly failures: number;
  readonly failure: { readonly detail: string };
};
function renderBlocker(blocker: T.MergeBlocker | StatusQueryBlocker): string {
  switch (blocker.kind) {
    case "merge-conflicts":
      return [
        "BLOCKER: merge-conflicts",
        `pr=${blocker.pr.number}`,
        `mergeable=${blocker.facts.mergeable}`,
        `mergeStateStatus=${blocker.facts.mergeStateStatus}`,
        "action=resolve merge conflicts before waiting for CI",
      ].join("\n");
    case "review-threads":
      return [
        "BLOCKER: review-threads",
        `pr=${blocker.pr.number}`,
        `unresolved=${blocker.threads.length}`,
        ...blocker.threads.map(threadLine),
      ].join("\n");
    case "failing-checks": {
      const failed = blocker.ci.kind === "ci-failing" ? blocker.ci.failed : [];
      const details = failed.map(
        (check) =>
          `${check.name} ${check.reportedState} ${check.description} ${check.link}`,
      );
      if (blocker.ci.kind === "ci-github-rejected")
        details.push(
          `mergeStateStatus=${blocker.ci.github.mergeStateStatus}`,
          `headRollupState=${blocker.ci.github.headRollupState}`,
        );
      return [
        "BLOCKER: failing-checks",
        `pr=${blocker.pr.number}`,
        `failed=${failed.length}`,
        ...details,
      ].join("\n");
    }
    case "merge-gate": {
      const action =
        blocker.reason === "closed-without-merge"
          ? "reopen the PR or drop it from the watch"
          : blocker.reason === "review-required"
            ? "obtain the approvals branch protection requires"
            : blocker.reason === "draft-pr"
              ? "mark the PR ready for review before waiting for the merge queue"
              : "resolve the changes-requested review before waiting for the merge queue";
      return [
        `BLOCKER: ${blocker.reason}`,
        `pr=${blocker.pr.number}`,
        `action=${action}`,
      ].join("\n");
    }
    case "status-query":
      return [
        "BLOCKER: status-query",
        `failures=${blocker.failures}`,
        `detail=${blocker.failure.detail}`,
        "action=verify current PR context, GitHub authentication, and API availability, then rearm",
      ].join("\n");
    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}
export function renderPretty(verdict: T.WatcherVerdict): string {
  switch (verdict.kind) {
    case "STATUS":
      return renderStatusTable(verdict.rows);
    case "WAITING":
      if (verdict.reason.kind === "pending-checks")
        return `WAITING: pr=#${verdict.waiting.number}; ${verdict.reason.pending.length} check${verdict.reason.pending.length === 1 ? "" : "s"} pending\n`;
      if (verdict.reason.kind === "mergeability-unknown")
        return `WAITING: pr=#${verdict.waiting.number}; GitHub has not finished computing mergeability\n`;
      return `WAITING: pr=#${verdict.waiting.number} is blocker-free; waiting for merge queue (${verdict.reason.unmergedCount} PR${verdict.reason.unmergedCount === 1 ? "" : "s"} unmerged)\n`;
    case "RETRY":
      return `RETRY: GitHub status query failed; retrying in ${verdict.retryInSeconds}s\ndetail=${verdict.failure.detail}\n`;
    case "BLOCKER":
      return `${renderBlocker(verdict.blocker)}\n`;
    case "READY": {
      const detail =
        verdict.pr.kind === "ready-pr"
          ? `\nmergeStateStatus=${verdict.pr.proof.ci.github.mergeStateStatus}\nreviewDecision=${verdict.pr.proof.gate.reviewDecision}\nisDraft=${verdict.pr.proof.gate.draft === "draft-allowed"}${verdict.pr.proof.gate.draft === "draft-allowed" ? "\nnote=draft allowed (--allow-draft); leave draft \u2014 do not mark ready" : ""}`
          : "";
      return `READY: no merge conflicts, no unresolved review threads, no failing or pending checks${detail}\n`;
    }
    case "TIMEOUT":
      if (verdict.reason.kind === "pending-checks")
        return "TIMEOUT: checks still pending\n";
      if (verdict.reason.kind === "status-unavailable")
        return "TIMEOUT: GitHub status remained unavailable\n";
      return "TIMEOUT: GitHub never finished computing mergeability\n";
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}
