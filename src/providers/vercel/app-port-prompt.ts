/**
 * Interactive confirmation for newly detected app ports.
 *
 * Exposing an app route makes it reachable by anyone holding the URL, so the
 * prompt never assumes: it names the ports that are already configured and
 * therefore retained, lists the inferred candidates it would add, says plainly
 * that accepted routes are public, and requires a decision. Enter accepts
 * high-confidence candidates; conflicting literal ports have no safe default
 * and must be selected explicitly.
 */
import { createInterface } from 'node:readline/promises';
import type { Writable } from 'node:stream';
import { describeAppPortCandidate, type AppPortCandidate } from './app-ports.js';
import { parseExposePortsList, VercelPortsError } from './ports.js';
import type { ProviderInput } from '../types.js';

export type AppPortPromptDecision = 'accepted' | 'rejected' | 'edited';

export interface AppPortPromptResult {
  decision: AppPortPromptDecision;
  /** Inferred app ports the user chose to expose. */
  selected: number[];
}

export interface AppPortPromptOptions {
  stdin: ProviderInput;
  stderr: Writable;
  /** Trusted explicit app ports; retained regardless of the answer. */
  configured: readonly number[];
  candidates: readonly AppPortCandidate[];
  /** True when one framework produced several literal ports. */
  conflicting: boolean;
  /** Injection seam for tests; defaults to a readline question on stdin. */
  ask?: (question: string) => Promise<string>;
}

/** Prompt the user to expose the detected app ports. */
export async function promptForAppPorts(
  options: AppPortPromptOptions,
): Promise<AppPortPromptResult> {
  const candidatePorts = uniquePorts(options.candidates.map(({ port }) => port));
  if (candidatePorts.length === 0) return { decision: 'rejected', selected: [] };

  let ask = options.ask;
  let close: (() => void) | undefined;
  if (!ask) {
    const readline = createReadlineAsk(options.stdin, options.stderr);
    ask = readline.ask;
    close = readline.close;
  }
  try {
    options.stderr.write(renderCandidateBlock(options));
    for (;;) {
      const answer = (await ask(
        options.conflicting
          ? 'Expose which app port(s)? [y=all/n=none/e=edit] '
          : 'Expose the detected app port(s)? [Y/n/e=edit] ',
      )).trim();
      if (answer.length === 0) {
        // A conflict has no defensible default: two literal ports in one dev
        // script mean the project itself is ambiguous about which one runs.
        if (options.conflicting) {
          options.stderr.write('  conflicting candidates require an explicit answer\n');
          continue;
        }
        return { decision: 'accepted', selected: candidatePorts };
      }
      if (/^y(?:es)?$/i.test(answer)) return { decision: 'accepted', selected: candidatePorts };
      if (/^n(?:o)?$/i.test(answer)) return { decision: 'rejected', selected: [] };
      if (/^e(?:dit)?$/i.test(answer)) {
        const edited = await editSelection(ask, options);
        if (edited) return { decision: 'edited', selected: edited };
        continue;
      }
      options.stderr.write('  answer y, n, or e\n');
    }
  } finally {
    close?.();
  }
}

async function editSelection(
  ask: (question: string) => Promise<string>,
  options: AppPortPromptOptions,
): Promise<number[] | undefined> {
  // Only the inferred set is editable. Configured ports are the explicit host
  // configuration and stay exposed whatever is typed here.
  options.stderr.write(
    '  editing the inferred ports only; configured ports stay exposed\n',
  );
  for (;;) {
    const answer = (await ask('  app ports to expose (comma-separated, empty for none): ')).trim();
    if (answer.length === 0) return [];
    try {
      return parseExposePortsList(answer);
    } catch (error) {
      if (!(error instanceof VercelPortsError)) throw error;
      options.stderr.write(`  ${error.message.replace(/^--expose-ports /, '')}\n`);
      const retry = (await ask('  try again? [Y/n] ')).trim();
      if (/^n(?:o)?$/i.test(retry)) return undefined;
    }
  }
}

function renderCandidateBlock(options: AppPortPromptOptions): string {
  const lines = ['Detected app ports in the remote checkout:'];
  const configured = uniquePorts(options.configured);
  if (configured.length > 0) {
    lines.push(`  retained (configured): ${configured.join(', ')}`);
  }
  for (const candidate of options.candidates) {
    lines.push(`  candidate: ${candidate.port} (${describeAppPortCandidate(candidate)})`);
  }
  if (options.conflicting) {
    lines.push('  the dev script names more than one port; pick the one your app listens on');
  }
  lines.push('  accepted app routes are PUBLIC: anyone with the URL can reach them');
  return `${lines.join('\n')}\n`;
}

interface ReadlineAsk {
  ask: (question: string) => Promise<string>;
  close: () => void;
}

function createReadlineAsk(stdin: ProviderInput, stderr: Writable): ReadlineAsk {
  const handle = createInterface({ input: stdin, output: stderr });
  return {
    ask: (question) => handle.question(question),
    close: () => handle.close(),
  };
}

function uniquePorts(ports: readonly number[]): number[] {
  return [...new Set(ports)].sort((left, right) => left - right);
}
