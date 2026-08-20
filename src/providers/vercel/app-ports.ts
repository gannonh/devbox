/**
 * Bounded app-port detection for a remote checkout.
 *
 * The detector reads the remote repository's root `package.json` as data and
 * nothing else: `dependencies`, `devDependencies`, and the root `scripts.dev`
 * string. No package script or JavaScript/TypeScript config is executed, no
 * workspace is traversed, and no raw script, source, or `.env` text ever
 * leaves this module -- callers receive structured candidates only.
 *
 * The grammar is intentionally literal. A framework is an exact dependency key
 * or a `vite`/`next` executable token in command position (optionally after
 * `npx`). A port override is an unquoted decimal token in a `PORT=`,
 * `--port`, `--port=`, `-p`, or `-pN` form. Shell expansion, quoting, and
 * ambiguous expressions yield no inferred override rather than being
 * interpreted.
 */
import { createHash } from 'node:crypto';

/**
 * Bump whenever the grammar below changes. Stored selections are bound to this
 * value so an upgraded detector re-prompts instead of silently reusing a
 * selection that a different grammar produced.
 */
export const APP_PORT_DETECTOR_VERSION = 1;

export const VITE_DEFAULT_PORT = 5173;
export const NEXT_DEFAULT_PORT = 3000;

/** Largest root package.json the scanner will read from the Sandbox. */
export const MAX_PACKAGE_JSON_BYTES = 262_144;

export type AppPortFramework = 'vite' | 'next';
/** Where a candidate port came from; both are safe to print. */
export type AppPortEvidence = 'framework-default' | 'dev-script';

export interface AppPortCandidate {
  port: number;
  framework: AppPortFramework;
  source: AppPortEvidence;
}

export interface AppPortDetection {
  candidates: AppPortCandidate[];
  /**
   * True when a framework produced more than one literal port. Conflicting
   * candidates are labeled and require an explicit selection; they are never
   * silently resolved and never accepted by a bare Enter.
   */
  conflicting: boolean;
  /** Bounded, content-free notices safe to print. */
  warnings: string[];
  fingerprint: string;
}

const FRAMEWORK_DEFAULTS: Record<AppPortFramework, number> = {
  vite: VITE_DEFAULT_PORT,
  next: NEXT_DEFAULT_PORT,
};

const FRAMEWORKS: readonly AppPortFramework[] = ['vite', 'next'];

/** Characters that make a token a shell expression rather than a literal. */
const AMBIGUOUS = /[$`'"\\*?()<>{}[\]~!]/;

const DECIMAL = /^(?:0|[1-9]\d*)$/;

interface Segment {
  /** The framework executable this segment runs, when it names one. */
  framework?: AppPortFramework;
  /** Literal decimal ports named by the documented option forms. */
  ports: number[];
}

/**
 * Detect app-port candidates from the remote root `package.json` text.
 *
 * `null` (no such file) yields no candidates. Malformed JSON yields a bounded
 * warning and no candidates so a Sandbox is never failed by a project's own
 * broken metadata.
 */
export function detectAppPorts(packageJson: string | null): AppPortDetection {
  if (packageJson === null) return detection([], false, []);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson) as unknown;
  } catch (error) {
    // The parser message can echo file content; keep only the offset.
    const position = /position (\d+)/i.exec(error instanceof Error ? error.message : '')?.[1];
    return detection([], false, [
      `remote root package.json is not valid JSON${position === undefined ? '' : ` (at byte ${position})`}`
      + '; no app ports were inferred',
    ]);
  }
  if (!isRecord(parsed)) {
    return detection([], false, ['remote root package.json is not a JSON object; no app ports were inferred']);
  }

  const declared = new Set<AppPortFramework>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const value = parsed[field];
    if (!isRecord(value)) continue;
    for (const framework of FRAMEWORKS) {
      if (Object.prototype.hasOwnProperty.call(value, framework)) declared.add(framework);
    }
  }

  const scripts = parsed.scripts;
  const devScript = isRecord(scripts) && typeof scripts.dev === 'string' ? scripts.dev : undefined;
  const segments = devScript === undefined ? [] : parseDevScript(devScript);
  for (const segment of segments) {
    if (segment.framework) declared.add(segment.framework);
  }

  const frameworks = FRAMEWORKS.filter((framework) => declared.has(framework));
  if (frameworks.length === 0) return detection([], false, []);

  const literal = new Map<AppPortFramework, Set<number>>(
    frameworks.map((framework) => [framework, new Set<number>()]),
  );
  const soleFramework = frameworks.length === 1 ? frameworks[0] : undefined;
  for (const segment of segments) {
    // A port named by a segment that runs no framework executable belongs to
    // the sole detected framework; with two frameworks in play it is ambiguous
    // and produces no override.
    const owner = segment.framework ?? soleFramework;
    if (!owner) continue;
    const bucket = literal.get(owner);
    if (!bucket) continue;
    for (const port of segment.ports) bucket.add(port);
  }

  const candidates: AppPortCandidate[] = [];
  let conflicting = false;
  for (const framework of frameworks) {
    const ports = [...(literal.get(framework) ?? [])].sort((left, right) => left - right);
    if (ports.length === 0) {
      candidates.push({ port: FRAMEWORK_DEFAULTS[framework], framework, source: 'framework-default' });
      continue;
    }
    if (ports.length > 1) conflicting = true;
    for (const port of ports) candidates.push({ port, framework, source: 'dev-script' });
  }
  return detection(candidates, conflicting, []);
}

/**
 * Canonical candidate fingerprint: SHA-256 over a stable serialization of the
 * sorted candidates plus the detector version.
 */
export function fingerprintAppPortCandidates(candidates: readonly AppPortCandidate[]): string {
  const sorted = sortCandidates(candidates).map(({ port, framework, source }) => [port, framework, source]);
  return createHash('sha256')
    .update(JSON.stringify({ detectorVersion: APP_PORT_DETECTOR_VERSION, candidates: sorted }))
    .digest('hex');
}

/** Human-readable, content-free label for a candidate. */
export function describeAppPortCandidate(candidate: AppPortCandidate): string {
  return candidate.source === 'framework-default'
    ? `${candidate.framework} default`
    : `${candidate.framework} dev script`;
}

function detection(
  candidates: AppPortCandidate[],
  conflicting: boolean,
  warnings: string[],
): AppPortDetection {
  const sorted = sortCandidates(candidates);
  return {
    candidates: sorted,
    conflicting,
    warnings,
    fingerprint: fingerprintAppPortCandidates(sorted),
  };
}

function sortCandidates(candidates: readonly AppPortCandidate[]): AppPortCandidate[] {
  return [...candidates].sort((left, right) =>
    left.port - right.port
    || left.framework.localeCompare(right.framework)
    || left.source.localeCompare(right.source));
}

/**
 * Split the dev script into shell segments and read each segment's command and
 * literal port options. Anything that is not a bare token is dropped.
 */
function parseDevScript(script: string): Segment[] {
  return script
    .split(/&&|\|\||[;|&\n]/)
    .map((piece) => parseSegment(piece.trim().split(/\s+/).filter((token) => token.length > 0)))
    .filter((segment): segment is Segment => segment !== undefined);
}

function parseSegment(tokens: string[]): Segment | undefined {
  if (tokens.length === 0) return undefined;
  const ports: number[] = [];
  let framework: AppPortFramework | undefined;
  let commandSeen = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const literal = !AMBIGUOUS.test(token);

    if (literal && /^PORT=/.test(token)) {
      const value = token.slice('PORT='.length);
      if (DECIMAL.test(value)) pushPort(ports, Number(value));
      continue;
    }
    if (!commandSeen) {
      // Leading `NAME=value` assignments precede the command word.
      if (literal && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      commandSeen = true;
      // `npx vite` keeps the following token in command position.
      if (literal && token === 'npx') {
        commandSeen = false;
        continue;
      }
      if (literal && isFramework(token)) framework = token;
      continue;
    }
    if (!literal) continue;
    if (token === '--port' || token === '-p') {
      const value = tokens[index + 1];
      if (value !== undefined && !AMBIGUOUS.test(value) && DECIMAL.test(value)) {
        pushPort(ports, Number(value));
        index += 1;
      }
      continue;
    }
    if (token.startsWith('--port=')) {
      const value = token.slice('--port='.length);
      if (DECIMAL.test(value)) pushPort(ports, Number(value));
      continue;
    }
    if (token.startsWith('-p') && token.length > 2) {
      const value = token.slice(2);
      if (DECIMAL.test(value)) pushPort(ports, Number(value));
      continue;
    }
  }
  return { ...(framework === undefined ? {} : { framework }), ports };
}

function pushPort(ports: number[], port: number): void {
  if (port < 1 || port > 65_535) return;
  if (!ports.includes(port)) ports.push(port);
}

function isFramework(value: string): value is AppPortFramework {
  return value === 'vite' || value === 'next';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
