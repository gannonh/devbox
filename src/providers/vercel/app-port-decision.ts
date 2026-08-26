/**
 * Pure policy for which app ports to expose.
 *
 * Keeps boot/resume/empty/conflict/capacity rules out of the I/O orchestrator
 * so those rules can grow without nesting another ladder inside scan/prompt/
 * update code.
 */
import {
  describeAppPortCandidate,
  type AppPortCandidate,
} from './app-ports.js';
import {
  DEVBOX_NOVNC_PROXY_PORT,
  MAX_VERCEL_SANDBOX_PORTS,
} from './ports.js';

export type AppPortSelectionDecision =
  | { kind: 'selected'; selected: number[]; notice?: string }
  | { kind: 'prompt' }
  | { kind: 'non-interactive'; selected: number[]; notice: string };

export interface DecideAppPortSelectionInput {
  branch: string;
  exposePorts?: readonly number[];
  reusable: boolean;
  /** False when the remote checkout could not be read, so inference is unavailable. */
  inferenceAvailable: boolean;
  previousSelected: readonly number[];
  candidates: readonly AppPortCandidate[];
  configured: readonly number[];
  tty: boolean;
}

/** Room left for app ports once the configured set and reserved noVNC are in. */
export function remainingAppPortCapacity(configured: readonly number[]): number {
  const reserved = new Set([...configured, DEVBOX_NOVNC_PROXY_PORT]);
  return MAX_VERCEL_SANDBOX_PORTS - reserved.size;
}

export function candidatePortsOf(candidates: readonly AppPortCandidate[]): number[] {
  return [...new Set(candidates.map(({ port }) => port))].sort((left, right) => left - right);
}

export function candidatesFitCapacity(
  configured: readonly number[],
  candidates: readonly AppPortCandidate[],
): boolean {
  const additional = candidatePortsOf(candidates).filter((port) => !configured.includes(port));
  return additional.length <= remainingAppPortCapacity(configured);
}

export function decideAppPortSelection(input: DecideAppPortSelectionInput): AppPortSelectionDecision {
  if (input.exposePorts !== undefined) {
    const selected = [...input.exposePorts];
    return {
      kind: 'selected',
      selected,
      notice: `app ports: exposing ${formatPorts(selected)} from --expose-ports`,
    };
  }

  if (input.reusable) {
    const selected = [...input.previousSelected];
    return {
      kind: 'selected',
      selected,
      ...(selected.length > 0
        ? { notice: `app ports: reusing the confirmed selection ${formatPorts(selected)}` }
        : {}),
    };
  }

  // A failed remote scan must never turn a routine boot into a blocking
  // prompt. Trusted configured ports are still added by the flow, and a
  // previously confirmed selection is retained until the checkout can be
  // inspected again.
  if (!input.inferenceAvailable) {
    return { kind: 'selected', selected: [...input.previousSelected] };
  }

  if (input.candidates.length > 0 && !candidatesFitCapacity(input.configured, input.candidates)) {
    const selected = [...input.previousSelected];
    return {
      kind: 'selected',
      selected,
      notice:
        `app ports: not offering ${formatPorts(candidatePortsOf(input.candidates))}; `
        + `${input.configured.length} configured port(s) plus the reserved noVNC port ${DEVBOX_NOVNC_PROXY_PORT} `
        + `leave room for ${remainingAppPortCapacity(input.configured)} more`,
    };
  }

  if (input.tty) return { kind: 'prompt' };

  const selected = [...input.previousSelected];
  if (input.candidates.length === 0) {
    return {
      kind: 'non-interactive',
      selected,
      notice: selected.length === 0
        ? 'app ports: no app ports were inferred from the remote checkout;'
          + ` expose them with: devbox ${input.branch} --provider vercel --expose-ports <list>`
        : `app ports: no app ports were inferred; keeping ${formatPorts(selected)}`,
    };
  }

  return {
    kind: 'non-interactive',
    selected,
    notice: nonInteractiveSkipNotice(input.branch, input.candidates, selected),
  };
}

function nonInteractiveSkipNotice(
  branch: string,
  candidates: readonly AppPortCandidate[],
  retained: readonly number[],
): string {
  const skipped = candidatePortsOf(candidates);
  const detail = candidates
    .map((candidate) => `${candidate.port} (${describeAppPortCandidate(candidate)})`)
    .join(', ');
  return (
    `app ports: skipped ${detail} because this run is not interactive\n`
    + `  expose them with: devbox ${branch} --provider vercel --expose-ports ${skipped.join(',')}`
    + (retained.length === 0 ? '' : `\n  keeping the previously confirmed ${formatPorts(retained)}`)
  );
}

function formatPorts(ports: readonly number[]): string {
  return ports.length === 0 ? 'no app ports' : ports.join(', ');
}
