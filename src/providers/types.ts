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
  /** Host dotenv source selected by `--env`, when provided. */
  envPath?: string;
  /** Parsed values from the selected dotenv source. */
  runtimeEnvironment?: Record<string, string>;
  tty: boolean;
  stdin: ProviderInput;
  stdout: ProviderOutput;
  stderr: Writable;
}

export interface ProviderBranchRequest extends ProviderRequestContext {
  branch: string;
  /**
   * Validated `--expose-ports` opt-in. Present only for boot/attach, and only
   * for providers that expose public app routes.
   */
  exposePorts?: number[];
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
  username?: undefined;
  password?: undefined;
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
