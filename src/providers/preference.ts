import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProviderName } from './types.js';

/**
 * Remember the provider a repository was last used with.
 *
 * `--provider vercel <branch>` on every command is a lot of typing for a repo
 * you have decided to run in the cloud, so the choice sticks until it is
 * changed. It is stored per repository rather than globally: two checkouts on
 * the same machine routinely want different providers.
 *
 * The stored choice is never applied silently — see `describeProviderChoice` —
 * because the Vercel provider creates billable cloud resources, and a remembered
 * default that you cannot see is the kind that surprises you later.
 */

const PREFERENCES_DIRECTORY = 'repos';
const APP_DIRECTORY = 'devbox';
/** Selectable providers, in the order the CLI documents them. */
const PROVIDER_NAMES: readonly ProviderName[] = ['local', 'vercel'];

export interface ProviderPreferenceOptions {
  /** Overridable for tests; defaults to the XDG state home. */
  stateHome?: string;
}

export interface ProviderChoice {
  provider: ProviderName;
  /** True when the value came from stored state rather than the command line. */
  remembered: boolean;
}

function preferencePath(repoRoot: string, options: ProviderPreferenceOptions): string {
  const stateHome = options.stateHome || process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const key = createHash('sha256').update(repoRoot).digest('hex').slice(0, 32);
  return join(stateHome, APP_DIRECTORY, PREFERENCES_DIRECTORY, `${key}.json`);
}

export function readProviderPreference(
  repoRoot: string,
  options: ProviderPreferenceOptions = {},
): ProviderName | undefined {
  let raw: string;
  try {
    raw = readFileSync(preferencePath(repoRoot, options), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { provider?: unknown };
    return parsed.provider === 'vercel' || parsed.provider === 'local' ? parsed.provider : undefined;
  } catch {
    // A corrupt preference must not break the CLI; fall back to the default.
    return undefined;
  }
}

export function writeProviderPreference(
  repoRoot: string,
  provider: ProviderName,
  options: ProviderPreferenceOptions = {},
): void {
  const path = preferencePath(repoRoot, options);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ provider })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Remembering is a convenience; failing to persist must never fail a command.
  }
}

/**
 * Resolve the provider for this invocation.
 *
 * An explicit flag always wins and becomes the new remembered value, so
 * `--provider local` is how you switch back.
 */
export function resolveProviderChoice(
  requested: string | undefined,
  repoRoot: string,
  options: ProviderPreferenceOptions = {},
): ProviderChoice {
  if (requested === 'local' || requested === 'vercel') {
    writeProviderPreference(repoRoot, requested, options);
    return { provider: requested, remembered: false };
  }
  if (requested !== undefined) {
    // Unsupported names are rejected by the registry, not silently remembered.
    return { provider: requested as ProviderName, remembered: false };
  }
  const stored = readProviderPreference(repoRoot, options);
  if (stored) return { provider: stored, remembered: true };
  return { provider: 'local', remembered: false };
}

/**
 * A one-line notice when a non-local provider was applied from memory, so a
 * remembered cloud provider is always visible before it spends anything.
 *
 * The tag carries the provider rather than describing it in prose, so the line
 * reads the same however many providers exist. The switch hint lists the
 * registry's names so it stays correct as providers are added.
 */
export function describeProviderChoice(choice: ProviderChoice): string | undefined {
  if (!choice.remembered || choice.provider === 'local') return undefined;
  return `[devbox/${choice.provider}] (change with --provider [${PROVIDER_NAMES.join('|')}])`;
}
