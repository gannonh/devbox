import type { Writable } from 'node:stream';

/** Caller-owned input stream used by interactive providers. */
export interface ProviderInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  readonly readableFlowing?: boolean | null;
}

/** Caller-owned output stream with optional terminal dimensions. */
export interface ProviderOutput extends Writable {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

/** Providers currently understood by the CLI. */
export type ProviderName = 'local' | 'vercel';

/** Runtime facts shared by every provider operation. */
export interface ProviderRequestContext {
  repoRoot: string;
  repoName: string;
  env: Record<string, string | undefined>;
  tty: boolean;
  stdin: ProviderInput;
  stdout: ProviderOutput;
  stderr: Writable;
}

export interface ProviderBranchRequest extends ProviderRequestContext {
  branch: string;
}

export type ProviderListRequest = ProviderRequestContext;

export interface ProviderUrlRequest extends ProviderBranchRequest {
  open: boolean;
}

/** Neutral completion result for lifecycle and list/URL operations. */
export interface ProviderActionResult {
  exitCode: number;
}

/** Stable lifecycle boundary consumed by CLI routing. */
export interface DevboxProvider {
  readonly name: ProviderName;
  up(request: ProviderBranchRequest): Promise<ProviderActionResult>;
  attach(request: ProviderBranchRequest): Promise<ProviderActionResult>;
  stop(request: ProviderBranchRequest): Promise<ProviderActionResult>;
  remove(request: ProviderBranchRequest): Promise<ProviderActionResult>;
  list(request: ProviderListRequest): Promise<ProviderActionResult>;
  url(request: ProviderUrlRequest): Promise<ProviderActionResult>;
}

export class ProviderUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'ProviderUsageError';
  }
}

export class ProviderOperationError extends Error {
  readonly exitCode: number;
  /** True when a provider already rendered the error in its own format. */
  readonly reported: boolean;

  constructor(message: string, exitCode = 1, reported = false) {
    super(message);
    this.name = 'ProviderOperationError';
    this.exitCode = exitCode;
    this.reported = reported;
  }
}
