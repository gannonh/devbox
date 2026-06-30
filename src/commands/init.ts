/**
 * devbox init — scaffold .devbox/ + .devcontainer/ in the current repo.
 *
 * Copies template files from the package's templates/ directory into the
 * current working directory, applying token replacement for the repo name.
 *
 * Idempotency rule:
 *   - If .devbox/ doesn't exist: create everything.
 *   - If .devbox/ exists and all files match the templates (after token
 *     replacement): no-op, exit 0 with an info message.
 *   - If .devbox/ exists and any file differs: error, exit non-zero, instruct
 *     the user to pass --force or diff manually.
 *   - --force: overwrite unconditionally.
 */
import { mkdir, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Writable } from 'node:stream';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceTokens } from '../lib/tokens.js';

export interface InitOptions {
  force: boolean;
  stderr?: Writable;
}

// Template files that go into .devbox/
const DEVBOX_FILES = [
  'Dockerfile',
  'provision.sh',
  'start-display.sh',
  'post-create.sh',
  'README.md',
] as const;

// Template file that goes into .devcontainer/
const DEVCONTAINER_FILES = ['devcontainer.json'] as const;

// Files that should be executable
const EXECUTABLE_FILES = new Set(['provision.sh', 'start-display.sh', 'post-create.sh']);

/** Resolve the templates/ directory relative to this module.
 *
 * In production (dist/commands/init.js), templates/ is at ../templates/.
 * In tests (src/commands/init.ts via vitest), templates/ is at ../../templates/.
 * Try both locations.
 */
function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'templates'), // dist/commands -> dist/templates
    join(here, '..', '..', 'templates'), // src/commands -> templates/
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fallback to the production path (will error clearly if missing)
  return candidates[0];
}

/** Read a template file and apply token replacement. */
async function readTemplate(name: string, repoName: string): Promise<string> {
  const raw = await readFile(join(templatesDir(), name), 'utf-8');
  return replaceTokens(raw, { repoName });
}

/** Check if the existing file matches the template content (after token replacement). */
async function fileMatches(path: string, templateContent: string): Promise<boolean> {
  try {
    const existing = await readFile(path, 'utf-8');
    return existing === templateContent;
  } catch {
    return false;
  }
}

export async function init(options: InitOptions): Promise<number> {
  const out = options.stderr ?? process.stderr;
  const cwd = process.cwd();
  const repoName = basename(cwd);
  const devboxDir = join(cwd, '.devbox');
  const devcontainerDir = join(cwd, '.devcontainer');

  // Check if .devbox/ already exists
  let devboxExists = false;
  try {
    await stat(devboxDir);
    devboxExists = true;
  } catch {
    devboxExists = false;
  }

  // Idempotency check (when not --force and .devbox/ exists)
  if (devboxExists && !options.force) {
    let allMatch = true;
    for (const file of DEVBOX_FILES) {
      const content = await readTemplate(file, repoName);
      if (!(await fileMatches(join(devboxDir, file), content))) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      for (const file of DEVCONTAINER_FILES) {
        const content = await readTemplate(file, repoName);
        if (!(await fileMatches(join(devcontainerDir, file), content))) {
          allMatch = false;
          break;
        }
      }
    }

    if (allMatch) {
      out.write('[devbox] .devbox/ already exists and all files match — nothing to do.\n');
      return 0;
    }

    out.write(
      '[devbox] .devbox/ exists but some files differ from the templates.\n' +
        '  Pass --force to overwrite, or diff manually to merge your changes.\n',
    );
    return 1;
  }

  // Create directories
  await mkdir(devboxDir, { recursive: true });
  await mkdir(devcontainerDir, { recursive: true });

  // Copy .devbox/ files with token replacement
  for (const file of DEVBOX_FILES) {
    const content = await readTemplate(file, repoName);
    await writeFile(join(devboxDir, file), content);
    if (EXECUTABLE_FILES.has(file)) {
      await chmod(join(devboxDir, file), 0o755);
    }
  }

  // Copy .devcontainer/ files with token replacement
  for (const file of DEVCONTAINER_FILES) {
    const content = await readTemplate(file, repoName);
    await writeFile(join(devcontainerDir, file), content);
  }

  // Success message
  const created: string[] = [];
  for (const f of DEVBOX_FILES) created.push(`.devbox/${f}`);
  for (const f of DEVCONTAINER_FILES) created.push(`.devcontainer/${f}`);
  out.write('[devbox] created:\n');
  for (const f of created) out.write(`  ${f}\n`);
  out.write('\n');
  writeNextSteps(out);
  out.write('[devbox] ready. Boot a box with: npx @gannonh/devbox <branch>\n');

  return 0;
}

/** Post-init customization guide. Points at the real repo-specific surfaces
 * rather than implying every generated file needs editing. The templates are
 * mostly generic by design; only a few hooks are meant for per-repo edits. */
function writeNextSteps(out: Writable): void {
  out.write('[devbox] next, tailor the box to this repo (skip anything that already fits):\n');
  out.write('\n');
  out.write('  1. Repo setup hook — .devbox/post-create.sh\n');
  out.write('     Add repo-specific steps that run once after deps + agent setup:\n');
  out.write('     migrations, native builds, seed data, extra tool installs.\n');
  out.write('     No-op by default; leave it as-is if you have nothing custom.\n');
  out.write('\n');
  out.write('  2. Dev server ports — .devcontainer/devcontainer.json\n');
  out.write('     forwardPorts/portsAttributes default to Vite (5173), RPC (9100),\n');
  out.write('     noVNC (6080). Adjust to your repo\'s dev servers.\n');
  out.write('\n');
  out.write('  3. Secrets — .env in the repo root\n');
  out.write('     provision.sh links it into the box as /home/node/.env. Add any keys\n');
  out.write('     your code or agent needs (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY).\n');
  out.write('\n');
  out.write('  4. Agent — .devbox/provision.sh\n');
  out.write('     Pi is active by default. To use Claude Code or Codex instead,\n');
  out.write('     comment out the Pi block (4a) and uncomment 4b/4c, then remove the\n');
  out.write('     ~/.pi mount from devcontainer.json.\n');
  out.write('\n');
  out.write('  5. Extra system packages — .devbox/Dockerfile (rarely needed)\n');
  out.write('     Add apt lines only if your repo needs something beyond the defaults.\n');
  out.write('\n');
  out.write(`  Full per-file guide: .devbox/README.md\n`);
  out.write('\n');
}
