import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEVBOX_NOVNC_PROXY_PORT = 6080;
export const DEVBOX_VNC_PORT = 5900;
export const MAX_VERCEL_SANDBOX_PORTS = 15;

export interface ParsedDevcontainerPorts {
  ports: number[];
  labels: Record<number, string>;
}

export class VercelPortsError extends Error {
  readonly code = 'invalid_ports';

  constructor(message: string) {
    super(message);
    this.name = 'VercelPortsError';
  }
}

export function assertSdkPorts(ports: number[]): number[] {
  const resolved = new Set<number>();
  for (const port of ports) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new VercelPortsError(
        `SDK ports input contains ${describe(port)}; every port must be an integer in 1..65535`,
      );
    }
    if (port === DEVBOX_VNC_PORT) {
      throw new VercelPortsError(`SDK ports input contains ${DEVBOX_VNC_PORT}; this port is forbidden/private`);
    }
    resolved.add(port);
  }
  resolved.add(DEVBOX_NOVNC_PROXY_PORT);
  const result = [...resolved].sort((left, right) => left - right);
  if (result.length > MAX_VERCEL_SANDBOX_PORTS) {
    const overflow = result.filter((port) => port !== DEVBOX_NOVNC_PROXY_PORT).slice(MAX_VERCEL_SANDBOX_PORTS - 1);
    throw new VercelPortsError(
      `SDK ports input resolves to ${result.length} ports; the maximum is ${MAX_VERCEL_SANDBOX_PORTS}; `
      + `overflow ports: ${overflow.join(', ')}`,
    );
  }
  return result;
}

export function normalizeContainerPort(value: unknown): number {
  if (typeof value === 'number') return validatePort(value, describe(value));
  if (typeof value !== 'string') {
    throw new VercelPortsError(`Invalid container port ${describe(value)}; expected an integer or decimal port string in 1..65535`);
  }
  if (value.length === 0) {
    throw new VercelPortsError('Invalid container port ""; the port string must not be empty');
  }
  if (/\s/.test(value)) {
    throw new VercelPortsError(`Invalid container port ${describe(value)}; whitespace-padded or whitespace-containing ports are not allowed`);
  }
  if (isDecimal(value)) return validatePort(Number(value), describe(value));

  const pieces = value.split(':');
  if (pieces.length !== 2) {
    throw new VercelPortsError(`Invalid container port ${describe(value)}; expected a decimal port or host:containerPort mapping`);
  }
  const host = pieces[0];
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) {
    throw new VercelPortsError(`Invalid container port ${describe(value)}; host:containerPort has a malformed host`);
  }
  if (isDecimal(host)) validatePortString(host, 'host port', value);
  return validatePortString(pieces[1], 'container port', value);
}

export function parseDevcontainerPorts(
  source: string,
  filePath = '.devcontainer/devcontainer.json',
): ParsedDevcontainerPorts {
  const json = stripJsonc(source, filePath);
  let config: unknown;
  try {
    config = JSON.parse(json) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/i.exec(message)?.[1];
    const location = ` at ${formatLocation(source, position === undefined ? source.length : Number(position))}`;
    throw new VercelPortsError(`${filePath}: invalid JSONC${location}: ${message}`);
  }
  if (!isRecord(config)) {
    throw new VercelPortsError(`${filePath}: expected a JSON object, found ${describe(config)}`);
  }
  const values = config.forwardPorts === undefined ? [] : config.forwardPorts;
  if (!Array.isArray(values)) {
    throw new VercelPortsError(
      `${filePath}: forwardPorts found ${describe(values)}; forwardPorts must be an array`,
    );
  }
  const normalized: Array<{ port: number; index: number; value: unknown }> = [];
  const seen = new Map<number, { index: number; key: string }>();
  for (const [index, value] of values.entries()) {
    let port: number;
    try {
      port = normalizeContainerPort(value);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new VercelPortsError(`${filePath}: forwardPorts[${index}] ${describe(value)} is invalid: ${reason}`);
    }
    const key = JSON.stringify(value) ?? String(value);
    if (port !== DEVBOX_NOVNC_PROXY_PORT && port !== DEVBOX_VNC_PORT) {
      const existing = seen.get(port);
      if (existing && existing.key !== key) {
        throw new VercelPortsError(
          `${filePath}: forwardPorts[${existing.index}] ${existing.key} and `
          + `forwardPorts[${index}] ${key} are conflicting normalized duplicates for port ${port}`,
        );
      }
      if (existing === undefined) seen.set(port, { index, key });
    }
    normalized.push({ port, index, value });
  }
  let resolvedPorts: number[];
  try {
    resolvedPorts = assertSdkPorts(normalized.map(({ port }) => port));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const forbidden = normalized.find(({ port }) => port === DEVBOX_VNC_PORT);
    const context = forbidden === undefined
      ? ''
      : ` forwardPorts[${forbidden.index}] ${describe(forbidden.value)}:`;
    throw new VercelPortsError(`${filePath}:${context} ${detail}`);
  }
  const labels: Record<number, string> = {};
  if (config.portsAttributes !== undefined) {
    if (!isRecord(config.portsAttributes)) {
      throw new VercelPortsError(
        `${filePath}: portsAttributes found ${describe(config.portsAttributes)}; `
        + 'portsAttributes must be an object keyed by decimal ports',
      );
    }
    for (const [key, value] of Object.entries(config.portsAttributes)) {
      if (!isDecimal(key)) {
        throw new VercelPortsError(
          `${filePath}: portsAttributes key ${JSON.stringify(key)} is an ambiguous label; `
          + 'keys must be normalized decimal port strings',
        );
      }
      const port = Number(key);
      if (port < 1 || port > 65_535) {
        throw new VercelPortsError(
          `${filePath}: portsAttributes key ${JSON.stringify(key)} is an ambiguous label; port must be in 1..65535`,
        );
      }
      if (!resolvedPorts.includes(port)) {
        throw new VercelPortsError(
          `${filePath}: portsAttributes key ${JSON.stringify(key)} is an ambiguous label; port is not present in resolved SDK ports`,
        );
      }
      if (!isRecord(value)) {
        throw new VercelPortsError(
          `${filePath}: portsAttributes key ${JSON.stringify(key)} found ${describe(value)}; `
          + 'the attribute value must be an object',
        );
      }
      if (value.label !== undefined && typeof value.label !== 'string') {
        throw new VercelPortsError(
          `${filePath}: portsAttributes key ${JSON.stringify(key)} found label ${describe(value.label)}; `
          + 'the label must be a string',
        );
      }
      if (typeof value.label === 'string') labels[port] = value.label;
    }
  }
  return { ports: resolvedPorts, labels };
}

export async function resolveDevcontainerPorts(
  repoRoot: string,
): Promise<ParsedDevcontainerPorts & { fileMissing?: boolean }> {
  const filePath = join(repoRoot, '.devcontainer', 'devcontainer.json');
  try {
    return parseDevcontainerPorts(await readFile(filePath, 'utf8'), filePath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { ports: [DEVBOX_NOVNC_PROXY_PORT], labels: {}, fileMissing: true };
    if (error instanceof VercelPortsError) throw error;
    throw new VercelPortsError(`${filePath}: unable to read devcontainer config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function stripJsonc(source: string, filePath: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (index === 0 && character === '\ufeff') {
      output += ' ';
      index += 1;
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      output += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        output += ' ';
        index += 1;
      }
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const start = index;
      output += '  ';
      index += 2;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          output += '  ';
          index += 2;
          closed = true;
          break;
        }
        output += source[index] === '\n' || source[index] === '\r' ? source[index] : ' ';
        index += 1;
      }
      if (!closed) throw new VercelPortsError(`${filePath}: unterminated block comment at ${formatLocation(source, start)}`);
      continue;
    }
    output += character;
    index += 1;
  }
  return stripTrailingCommas(output);
}

function stripTrailingCommas(source: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ',') {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (source[next] === '}' || source[next] === ']') {
        output += ' ';
        continue;
      }
    }
    output += character;
  }
  return output;
}

function formatLocation(source: string, offset: number): string {
  const bounded = Math.max(0, Math.min(offset, source.length));
  const line = source.slice(0, bounded).split('\n').length;
  const lastNewline = source.lastIndexOf('\n', bounded - 1);
  return `line ${line}, column ${bounded - lastNewline}`;
}

function isDecimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}

function validatePort(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new VercelPortsError(`Invalid container port ${source}; expected an integer in 1..65535`);
  }
  return value;
}

function validatePortString(value: string, kind: string, source: string): number {
  if (!isDecimal(value)) {
    throw new VercelPortsError(`Invalid container port ${describe(source)}; ${kind} must be a decimal port in 1..65535`);
  }
  return validatePort(Number(value), `${kind} ${describe(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Number.POSITIVE_INFINITY) return 'Infinity';
    if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

