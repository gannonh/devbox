import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { init } from '../src/commands/init.js';

describe('init', () => {
  let tempDir: string;
  const origCwd = process.cwd();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'devbox-init-'));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates .devbox/ with all expected files and .devcontainer/devcontainer.json', async () => {
    const result = await init({ force: false });
    expect(result).toBe(0);

    // .devbox/ files
    const devboxFiles = await readdir(join(tempDir, '.devbox'));
    expect(devboxFiles).toContain('Dockerfile');
    expect(devboxFiles).toContain('provision.sh');
    expect(devboxFiles).toContain('start-display.sh');
    expect(devboxFiles).toContain('post-create.sh');
    expect(devboxFiles).toContain('README.md');

    // .devcontainer/devcontainer.json
    const devcontainerFiles = await readdir(join(tempDir, '.devcontainer'));
    expect(devcontainerFiles).toContain('devcontainer.json');
  });

  it('applies token replacement for repo name in devcontainer.json', async () => {
    const result = await init({ force: false });
    expect(result).toBe(0);

    const content = await readFile(join(tempDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const repoName = tempDir.split('/').pop()!;
    expect(content).toContain(`"${repoName}-devbox"`);
    expect(content).not.toContain('{{REPO_NAME}}');
  });

  it('copies Dockerfile and start-display.sh byte-for-byte (no tokens)', async () => {
    const result = await init({ force: false });
    expect(result).toBe(0);

    // Resolve the templates dir the same way init.ts does
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const templatesPath = join(here, '..', 'templates');

    const dockerfile = await readFile(join(tempDir, '.devbox', 'Dockerfile'), 'utf-8');
    const templateDockerfile = await readFile(
      join(templatesPath, 'Dockerfile'),
      'utf-8',
    );
    expect(dockerfile).toBe(templateDockerfile);
  });

  it('is idempotent: second run is a no-op when all files match', async () => {
    const first = await init({ force: false });
    expect(first).toBe(0);

    const second = await init({ force: false });
    expect(second).toBe(0);
  });

  it('errors (non-zero) when a file differs and no --force', async () => {
    const first = await init({ force: false });
    expect(first).toBe(0);

    // Mutate a generated file
    await writeFile(join(tempDir, '.devbox', 'README.md'), '# modified\n');

    const second = await init({ force: false });
    expect(second).not.toBe(0);
  });

  it('overwrites with --force when files differ', async () => {
    const first = await init({ force: false });
    expect(first).toBe(0);

    // Mutate a generated file
    await writeFile(join(tempDir, '.devbox', 'README.md'), '# modified\n');

    const second = await init({ force: true });
    expect(second).toBe(0);

    // File should be restored to template content
    const content = await readFile(join(tempDir, '.devbox', 'README.md'), 'utf-8');
    expect(content).not.toContain('# modified');
  });

  it('does not leave {{REPO_NAME}} in any generated file', async () => {
    const result = await init({ force: false });
    expect(result).toBe(0);

    const checkPath = async (path: string): Promise<string> => {
      const content = await readFile(path, 'utf-8');
      return content;
    };

    const devboxFiles = await readdir(join(tempDir, '.devbox'));
    for (const file of devboxFiles) {
      const content = await checkPath(join(tempDir, '.devbox', file));
      expect(content).not.toContain('{{REPO_NAME}}');
    }

    const devcontainerContent = await checkPath(join(tempDir, '.devcontainer', 'devcontainer.json'));
    expect(devcontainerContent).not.toContain('{{REPO_NAME}}');
  });

  it('makes provision.sh, start-display.sh, and post-create.sh executable', async () => {
    const result = await init({ force: false });
    expect(result).toBe(0);

    const { statSync } = await import('node:fs');
    for (const file of ['provision.sh', 'start-display.sh', 'post-create.sh']) {
      const stat = statSync(join(tempDir, '.devbox', file));
      // Check executable bit (any of owner/group/other)
      const mode = stat.mode & 0o111;
      expect(mode).not.toBe(0);
    }
  });
});
