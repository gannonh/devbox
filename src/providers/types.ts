import type { Writable } from 'node:stream';

/** Providers currently understood by the CLI. */
export type ProviderName = 'local' | 'vercel';

/** Runtime facts shared by every provider operation. */
export interface ProviderRequestContext {
  repoRoot: string;
  repoName: string;
  env: Record<string, string | undefined>;
  tty: boolean;
  stdout: Writable;
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

export interface SupportedDisplayCredentials {
  supported: true;
  username: string;
  password: string;
}

export interface UnsupportedDisplayCredentials {
  supported: false;
  message: string;
}

/** Explicitly labeled credentials, or a provider-owned unsupported result. */
export type DisplayCredentialsResult =
  | SupportedDisplayCredentials
  | UnsupportedDisplayCredentials;

/** Stable lifecycle boundary consumed by CLI routing. */
export interface DevboxProvider {
  readonly name: ProviderName;
  up(request: ProviderBranchRequest): Promise<ProviderActionResult>;
  attach(request: ProviderBranchRequest): Promise<ProviderActionResult>;
  stop(request: ProviderBranchRequest): Promise<ProviderActionResult>;
  remove(request: ProviderBranchRequest): Promise<ProviderActionResult>;
  list(request: ProviderListRequest): Promise<ProviderActionResult>;
  url(request: ProviderUrlRequest): Promise<ProviderActionResult>;
  getDisplayCredentials(request: ProviderBranchRequest): Promise<DisplayCredentialsResult>;
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
