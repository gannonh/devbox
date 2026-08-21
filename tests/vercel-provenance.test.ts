import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const provenancePath = 'images/vercel/provenance.json';
const dockerfilePath = 'images/vercel/Dockerfile';

async function readProvenance(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(provenancePath, 'utf8')) as Record<string, any>;
}

describe('Vercel Universal mirror provenance', () => {
  it('records the audited upstream recipe and observed managed VMI inventory', async () => {
    const provenance = await readProvenance();
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      platform: 'linux/amd64',
      upstream: {
        repository: 'https://github.com/vercel/sandbox',
        commit: '90fa48d5728d46d40fbfb6495c2d720aeb3f7a0f',
        ubuntuDockerfileSha256: 'afaa5535d925d4e6344ca2971c041c68a3f49722531115c9ab63462333f0656a',
        universalDockerfileSha256: 'e53e28f8c8d7b502340073127d0cc8c29f0b5765b10ba961a0ad6d153fabc69a',
      },
      observedManagedVmi: {
        digest: 'sha256:0e3e3617e824397f170fc7c43ccaa565dd7ac36518e83ead3d41e077cd9f6ec7',
        versions: {
          user: 'ubuntu',
          node: '24.19.0',
          npm: '11.17.0',
          pnpm: '11.20.0',
          bun: '1.3.14',
          python: '3.14.4',
          pip: '25.1.1',
          uv: '0.12.2',
          gh: expect.stringMatching(/^\d+\.\d+\.\d+$/),
          pi: expect.stringMatching(/^\d+\.\d+\.\d+$/),
          claude: expect.stringMatching(/^\d+\.\d+\.\d+$/),
          codex: expect.stringMatching(/^\d+\.\d+\.\d+$/),
          opencode: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        },
      },
      baseImages: {
        ubuntu: 'docker.io/library/ubuntu:26.04@sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03',
        bun: 'docker.io/oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4',
      },
      node: {
        version: '24.19.0',
        platform: 'linux-x64',
        sha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647',
      },
      chromium: {
        version: '152.0.7977.42',
        platform: 'linux64',
        url: 'https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.42/linux64/chrome-linux64.zip',
        sha256: 'cb77f4781cad7d5e06fcc78b4476e6a6375616e7278dc313abaa9db22ed4674e',
      },
      aptSnapshot: '20260801T000000Z',
      runtimePackages: {
        npm: '11.17.0',
        pnpm: '11.20.0',
        python: '3.14.4',
        pip: '25.1.1',
        uv: '0.12.2',
        gh: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        pi: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        claude: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        codex: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        opencode: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      },
    });

    // gh and the four agents drift with the refresh loop; exact agreement
    // with agents.json is enforced by the manifest contract test, so here we
    // assert shape and that both inventories record the same values.
    for (const name of ['gh', 'pi', 'claude', 'codex', 'opencode']) {
      expect(provenance.observedManagedVmi.versions[name]).toBe(provenance.runtimePackages[name]);
    }
  });

  it('builds from the pinned mirror inputs with exact runtime packages', async () => {
    const provenance = await readProvenance();
    const dockerfile = await readFile(dockerfilePath, 'utf8');
    expect(dockerfile).toContain(`FROM ${provenance.baseImages.ubuntu} AS ubuntu-base`);
    expect(dockerfile).toContain(`FROM ${provenance.baseImages.bun} AS bun`);
    expect(dockerfile).toContain(`node-v${provenance.node.version}-linux-x64.tar.xz`);
    expect(dockerfile).toContain(`https://nodejs.org/dist/v${provenance.node.version}/`);
    expect(dockerfile).toContain(provenance.node.sha256);
    expect(dockerfile).toContain(provenance.chromium.url);
    expect(dockerfile).toContain(provenance.chromium.sha256);
    expect(dockerfile).toContain(`ARG UBUNTU_SNAPSHOT=${provenance.aptSnapshot}`);
    const npmPackages: Record<string, string> = {
      npm: 'npm',
      pnpm: 'pnpm',
    };
    for (const [name, packageName] of Object.entries(npmPackages)) {
      expect(dockerfile).toContain(`${packageName}@${provenance.runtimePackages[name]}`);
    }
    // Coding-agent pins derive from agents.json at build time: a partial
    // update (Dockerfile bumped without the manifest) is rejected by
    // construction, and the manifest is the single source of truth.
    const agentPackages: Record<string, string> = {
      opencode: 'opencode-ai',
      claude: '@anthropic-ai/claude-code',
      codex: '@openai/codex',
      pi: '@earendil-works/pi-coding-agent',
    };
    expect(dockerfile).toContain('COPY agents.json /usr/local/share/devbox/agents.json');
    expect(dockerfile).toContain('jq -r --arg agent "$1" \'.agents[$agent].version\' /usr/local/share/devbox/agents.json');
    for (const [name, packageName] of Object.entries(agentPackages)) {
      expect(dockerfile).toContain(`"${packageName}@$(agent_version ${name})"`);
      expect(dockerfile).toContain(`${name} --version | grep -F "$(agent_version ${name})"`);
      // No literal agent version may live in the Dockerfile.
      expect(dockerfile).not.toMatch(new RegExp(`${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@\\d`));
    }
    expect(dockerfile).toContain(`pip==${provenance.runtimePackages.pip}`);
    expect(dockerfile).toContain(`uv==${provenance.runtimePackages.uv}`);
    for (const line of dockerfile.match(/^FROM\s+\S+/gm) ?? []) {
      const reference = line.split(/\s+/)[1];
      if (reference === 'ubuntu-base') continue;
      expect(reference, `unpinned external base image: ${line}`).toContain('@sha256:');
    }
    expect(dockerfile).not.toContain('vcr.vercel.com/vercel/sandbox/universal');
    expect(dockerfile).not.toContain('UNIVERSAL_BASE_DIGEST');
    expect(dockerfile).not.toMatch(/npm install -g(?![\s\S]*@\d)/);
  });
});
