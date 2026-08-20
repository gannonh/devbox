import { mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appPortsOf,
  assertSdkPorts,
  buildDesiredPortSet,
  DEVBOX_NOVNC_INTERNAL_PORT,
  DEVBOX_NOVNC_PROXY_PORT,
  DEVBOX_VNC_PORT,
  MAX_VERCEL_SANDBOX_APP_PORTS,
  MAX_VERCEL_SANDBOX_PORTS,
  parseDevcontainerPorts,
  parseExposePortsList,
  resolveDevcontainerPorts,
  samePortSet,
} from '../src/providers/vercel/ports.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import { createVercelBranchMetadataStore } from '../src/providers/vercel/metadata.js';
import {
  createVercelLifecycle,
} from '../src/providers/vercel/lifecycle.js';
import {
  type VercelSandboxClient,
  type VercelSandboxCreateRequest,
  type VercelSandboxHandle,
} from '../src/providers/vercel/client.js';
import type { GitHubSourcePlan } from '../src/providers/vercel/source.js';
import { resolveTestImage, TEST_IMAGE_REFERENCE } from './vercel-image.fixture.js';

describe('Vercel devcontainer ports', () => {
  it('normalizes an integer forward port and adds the noVNC proxy', () => {
    expect(parseDevcontainerPorts('{ "forwardPorts": [5173] }', '/repo/.devcontainer/devcontainer.json'))
      .toEqual({ ports: [5173, 6080], labels: {} });
  });

  it('names non-finite SDK port inputs in invariant errors', () => {
    expect(() => assertSdkPorts([Number.NaN])).toThrow(/NaN/);
    expect(() => assertSdkPorts([Number.POSITIVE_INFINITY])).toThrow(/Infinity/);
  });

  it('normalizes decimal strings and host-to-container mappings', () => {
    expect(parseDevcontainerPorts(
      '{ "forwardPorts": ["5173", "127.0.0.1:5174", "8080:5175", "localhost:5176"] }',
      '/repo/.devcontainer/devcontainer.json',
    ).ports).toEqual([5173, 5174, 5175, 5176, 6080]);
  });

  it('rejects three-field mappings and bracketed IPv6 mappings', () => {
    for (const value of [
      '127.0.0.1:8080:5173',
      '[::1]:5174',
      '[::1]:8081:5175',
    ]) {
      const parse = () => parseDevcontainerPorts(
        JSON.stringify({ forwardPorts: [value] }),
        '/repo/devcontainer.json',
      );
      expect(parse).toThrow('/repo/devcontainer.json');
      expect(parse).toThrow('forwardPorts[0]');
      expect(parse).toThrow(value);
    }
  });

  it('parses BOM, comments, trailing commas, and comment markers in strings', () => {
    const source = '\ufeff{\n'
      + '  // forward ports\n'
      + '  "forwardPorts": [5173,], /* keep */\n'
      + '  "portsAttributes": { "5173": { "label": "http://x", }, },\n'
      + '}';
    expect(parseDevcontainerPorts(source, '/repo/.devcontainer/devcontainer.json'))
      .toEqual({ ports: [5173, 6080], labels: { 5173: 'http://x' } });
  });

  it('parses the repository JSONC fixture and keeps the public-port invariants', async () => {
    const fixturePath = fileURLToPath(new URL('../.devcontainer/devcontainer.json', import.meta.url));
    const parsed = parseDevcontainerPorts(await readFile(fixturePath, 'utf8'), fixturePath);

    expect(parsed.ports.filter((port) => port === 6080)).toHaveLength(1);
    expect(parsed.ports).not.toContain(5900);
    expect(parsed.ports).not.toContain(6081);
  });

  it('rejects unsupported and malformed forwardPorts entries with actionable context', () => {
    const filePath = '/repo/.devcontainer/devcontainer.json';
    const invalid: Array<[unknown, RegExp]> = [
      [true, /integer or decimal/],
      [null, /integer or decimal/],
      [{}, /integer or decimal/],
      [[], /integer or decimal/],
      [5173.5, /integer in 1\.\.65535/],
      [-1, /integer in 1\.\.65535/],
      [0, /integer in 1\.\.65535/],
      [65_536, /integer in 1\.\.65535/],
      ['', /must not be empty/],
      ['+5173', /decimal port|host:containerPort/],
      ['0x10', /decimal port|host:containerPort/],
      [' 5173', /whitespace/],
      ['5173 ', /whitespace/],
      ['not-a-port', /decimal port|host:containerPort/],
      ['host:', /decimal port in 1\.\.65535/],
      [':5173', /malformed host/],
      ['host:abc', /decimal port in 1\.\.65535/],
      ['host:0', /integer in 1\.\.65535/],
      ['0:5173', /integer in 1\.\.65535/],
      ['99999:5173', /1\.\.65535/],
      ['127.0.0.1:bad:5173', /decimal port|host:containerPort/],
      ['::1:5173', /decimal port|host:containerPort/],
      ['[::1:5173', /decimal port|host:containerPort/],
    ];
    for (const [value, rule] of invalid) {
      const parse = () => parseDevcontainerPorts(JSON.stringify({ forwardPorts: [value] }), filePath);
      expect(parse).toThrow(filePath);
      expect(parse).toThrow('forwardPorts[0]');
      expect(parse).toThrow(JSON.stringify(value));
      expect(parse).toThrow(rule);
    }
  });

  it('deduplicates identical entries but rejects conflicting normalized duplicates', () => {
    expect(parseDevcontainerPorts('{ "forwardPorts": ["5173", "5173"] }').ports)
      .toEqual([5173, 6080]);
    expect(() => parseDevcontainerPorts('{ "forwardPorts": [5173, "5173"] }', '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*forwardPorts\[0\].*5173.*forwardPorts\[1\].*5173.*conflicting normalized duplicates/);
    expect(parseDevcontainerPorts(
      '{ "forwardPorts": ["5173", "\\u0035\\u0031\\u0037\\u0033"] }',
    ).ports).toEqual([5173, 6080]);
    expect(() => parseDevcontainerPorts('{ "forwardPorts": [{ "port": 5173 }] }', '/repo/devcontainer.json'))
      .toThrow(/forwardPorts\[0\].*\{"port":5173\}/);
  });

  it('keeps the internal noVNC port private', () => {
    expect(() => assertSdkPorts([DEVBOX_NOVNC_INTERNAL_PORT])).toThrow(/(?:internal|private)/i);
    expect(() => parseDevcontainerPorts(`{ "forwardPorts": [${DEVBOX_NOVNC_INTERNAL_PORT}] }`))
      .toThrow(/(?:internal|private)/i);
  });

  it('forbids the VNC port and consumes every declaration of the noVNC proxy port', () => {
    expect(() => parseDevcontainerPorts('{ "forwardPorts": [5900] }', '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*5900.*forbidden\/private/);
    expect(() => parseDevcontainerPorts('{ "forwardPorts": [5900, "host:5900"] }', '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*5900.*forbidden\/private/);
    expect(parseDevcontainerPorts('{ "forwardPorts": [6080, "6080", "host:6080"] }').ports)
      .toEqual([6080]);
  });

  it('limits the final SDK port array to the verified service maximum including noVNC', () => {
    const appPorts = Array.from({ length: 13 }, (_, index) => 3_000 + index);
    expect(parseDevcontainerPorts(JSON.stringify({ forwardPorts: appPorts }))).toEqual({
      ports: [...appPorts, 6080].sort((left, right) => left - right),
      labels: {},
    });

    const overflowingPorts = [...appPorts, 3_013];
    expect(() => parseDevcontainerPorts(JSON.stringify({ forwardPorts: overflowingPorts }), '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*verified service maximum is 14.*overflow ports: 3013/);
  });

  it('accepts labels only for normalized ports present in the resolved SDK array', () => {
    expect(parseDevcontainerPorts(
      '{ "forwardPorts": [5173], "portsAttributes": { "5173": { "label": "app" }, "6080": { "label": "proxy" } } }',
    ).labels).toEqual({ 5173: 'app', 6080: 'proxy' });

    const invalidLabels: Array<[string, RegExp]> = [
      ['5173x', /normalized decimal port strings/],
      ['0', /port must be in 1\.\.65535/],
      ['65536', /port must be in 1\.\.65535/],
      ['05173', /normalized decimal port strings/],
      ['9100', /not present in resolved SDK ports/],
    ];
    for (const [key, rule] of invalidLabels) {
      const parse = () => parseDevcontainerPorts(
        JSON.stringify({ forwardPorts: [5173], portsAttributes: { [key]: { label: 'bad' } } }),
        '/repo/devcontainer.json',
      );
      expect(parse).toThrow('/repo/devcontainer.json');
      expect(parse).toThrow(JSON.stringify(key));
      expect(parse).toThrow(rule);
    }
  });

  it('returns only noVNC and marks the config missing for an empty repository', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-vercel-missing-'));
    const result = await resolveDevcontainerPorts(repoRoot);
    expect(result).toEqual({ ports: [6080], labels: {}, fileMissing: true });
  });

  it('reports JSONC syntax errors with the source file and location', () => {
    expect(() => parseDevcontainerPorts('{ "forwardPorts": [5173, }', '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*invalid JSONC.*line/);
  });

  it('includes offending structural values in configuration errors', () => {
    expect(() => parseDevcontainerPorts('[]', '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*expected a JSON object.*\[\]/);
    expect(() => parseDevcontainerPorts('{ "forwardPorts": {} }', '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*forwardPorts.*\{\}.*array/);
    expect(() => parseDevcontainerPorts('{ "portsAttributes": [] }', '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*portsAttributes.*\[\].*object/);
    expect(() => parseDevcontainerPorts('{ "forwardPorts": [5173], "portsAttributes": { "5173": null } }', '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*portsAttributes key "5173".*null.*attribute value.*object/);
    expect(() => parseDevcontainerPorts('{ "forwardPorts": [5173], "portsAttributes": { "5173": { "label": 42 } } }', '/repo/devcontainer.json'))
      .toThrow(/\/repo\/devcontainer\.json.*portsAttributes key "5173".*42.*label.*string/);
  });

  it('passes lifecycle ports into the Vercel Sandbox create request', async () => {
    const remote = {
      host: 'github.com',
      owner: 'acme',
      repository: 'repo',
      canonical: 'github.com/acme/repo',
      url: 'https://github.com/acme/repo.git',
    };
    const source: GitHubSourcePlan = {
      remote,
      defaultBranch: 'main',
      requestedBranch: 'main',
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: {
        type: 'git',
        url: remote.url,
        revision: 'main',
        username: 'x-access-token',
        password: 'github-token',
      },
      warning: '',
    };
    const identity = createVercelIdentity({
      remote: remote.canonical,
      branch: 'main',
      scope: { teamId: 'team', projectId: 'project' },
    });
    const handle: VercelSandboxHandle = {
      name: identity.name,
      status: 'running',
      image: TEST_IMAGE_REFERENCE,
      persistent: true,
      tags: { ...identity.tags },
      openInteractive: async () => ({ url: 'wss://example.test', token: 'token' }),
      extendTimeout: async () => {},
      listSessions: async () => [],
      stop: async () => ({ id: 'session', status: 'stopped' }),
      delete: async () => {},
      runCommand: async () => ({ exitCode: 0 }),
      domain: (port: number) => `https://example.test/${port}`,
    };
    let request: VercelSandboxCreateRequest | undefined;
    const client = {
      getOrCreate: async (value: VercelSandboxCreateRequest) => {
        request = value;
        return handle;
      },
    } as unknown as VercelSandboxClient;
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-vercel-ports-'));
    const branchMetadataStore = createVercelBranchMetadataStore({ stateHome, repoKey: remote.canonical, branch: 'main' });
    const lifecycle = createVercelLifecycle({
      resolveImage: resolveTestImage,
      repoRoot: '/repo',
      branch: 'main',
      credentials: { token: 'token', teamId: 'team', projectId: 'project' },
      source,
      branchMetadataStore,
      client,
      ports: [5173],
    });

    await lifecycle.up();
    expect(request?.ports).toEqual([5173, 6080]);

    const invalidLifecycle = createVercelLifecycle({
      resolveImage: resolveTestImage,
      repoRoot: '/repo',
      branch: 'main',
      credentials: { token: 'token', teamId: 'team', projectId: 'project' },
      source,
      branchMetadataStore,
      client,
      ports: [5900],
    });
    await expect(invalidLifecycle.up()).rejects.toThrow(/5900.*(?:forbidden|private)/);

    const invalidInternalLifecycle = createVercelLifecycle({
      resolveImage: resolveTestImage,
      repoRoot: '/repo',
      branch: 'main',
      credentials: { token: 'token', teamId: 'team', projectId: 'project' },
      source,
      branchMetadataStore,
      client,
      ports: [DEVBOX_NOVNC_INTERNAL_PORT],
    });
    await expect(invalidInternalLifecycle.up()).rejects.toThrow(/6081.*(?:internal|private)/);
  });
});

describe('--expose-ports parsing and desired port sets', () => {
  it('accepts a comma-separated list with surrounding whitespace', () => {
    expect(parseExposePortsList(' 5173 , 3000,4000 ')).toEqual([5173, 3000, 4000]);
  });

  it('accepts a single port', () => {
    expect(parseExposePortsList('5173')).toEqual([5173]);
  });

  it.each([
    ['an empty value', '   ', /non-empty comma-separated list/],
    ['an empty entry', '5173,,3000', /empty port entry/],
    ['a trailing separator', '5173,', /empty port entry/],
    ['a non-decimal entry', '5173,web', /not a decimal port/],
    ['a hex entry', '0x1000', /not a decimal port/],
    ['a negative entry', '-1', /not a decimal port/],
    ['a zero entry', '0', /outside 1\.\.65535/],
    ['an out-of-range entry', '70000', /outside 1\.\.65535/],
    ['a duplicate entry', '5173,5173', /duplicate/],
    ['the private VNC port', '5900', /reserved; the VNC port stays private/],
    ['the internal noVNC port', '6081', /reserved; the internal noVNC port stays private/],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseExposePortsList(value)).toThrow(message);
  });

  it('permits the reserved noVNC port and keeps it once in the desired set', () => {
    expect(parseExposePortsList('6080')).toEqual([DEVBOX_NOVNC_PROXY_PORT]);
    expect(buildDesiredPortSet([DEVBOX_NOVNC_PROXY_PORT], [DEVBOX_NOVNC_PROXY_PORT]))
      .toEqual([DEVBOX_NOVNC_PROXY_PORT]);
  });

  it('unions configured and selected ports with the reserved noVNC port', () => {
    expect(buildDesiredPortSet([4000], [5173])).toEqual([4000, 5173, DEVBOX_NOVNC_PROXY_PORT]);
    expect(buildDesiredPortSet([], [])).toEqual([DEVBOX_NOVNC_PROXY_PORT]);
  });

  it('accepts the verified maximum total port count and rejects one more', () => {
    const maximum = Array.from(
      { length: MAX_VERCEL_SANDBOX_APP_PORTS },
      (_value, index) => 4000 + index,
    );
    expect(buildDesiredPortSet(maximum, [])).toHaveLength(MAX_VERCEL_SANDBOX_PORTS);
    expect(MAX_VERCEL_SANDBOX_PORTS).toBe(14);
    expect(MAX_VERCEL_SANDBOX_APP_PORTS).toBe(13);

    expect(() => buildDesiredPortSet(maximum, [5173]))
      .toThrow(/app port selection is invalid.*verified service maximum is 14.*at most 13 app ports/s);
  });

  it('reports a private port in the selection before any update', () => {
    expect(() => buildDesiredPortSet([4000], [DEVBOX_VNC_PORT])).toThrow(/forbidden\/private/);
    expect(() => buildDesiredPortSet([4000], [DEVBOX_NOVNC_INTERNAL_PORT])).toThrow(/internal\/private/);
  });

  it('separates app ports from the reserved noVNC port', () => {
    expect(appPortsOf([DEVBOX_NOVNC_PROXY_PORT, 5173, 4000, 5173])).toEqual([4000, 5173]);
    expect(appPortsOf([DEVBOX_NOVNC_PROXY_PORT])).toEqual([]);
  });

  it('compares port sets by content rather than order', () => {
    expect(samePortSet([5173, DEVBOX_NOVNC_PROXY_PORT], [DEVBOX_NOVNC_PROXY_PORT, 5173])).toBe(true);
    expect(samePortSet([5173], [5173, 4000])).toBe(false);
    expect(samePortSet([], [])).toBe(true);
  });
});
