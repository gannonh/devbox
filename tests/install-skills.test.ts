import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const installSkillsPath = join(process.cwd(), 'scripts/install-skills.sh');
const agentsPath = join(process.cwd(), 'AGENTS.md');

describe('install-skills.sh plan-build-verify retarget', () => {
  const script = readFileSync(installSkillsPath, 'utf8');

  it('does not npx-add plan-build-verify from gannonh/skills', () => {
    expect(script).not.toMatch(/skills add[^\n]*plan-build-verify/);
    expect(script).not.toMatch(/add_skill gannonh\/skills --skill plan-build-verify/);
  });

  it('installs the plan-build-verify Cursor plugin from the canonical repo', () => {
    expect(script).toContain('install_plan_build_verify_plugin');
    expect(script).toContain('gannonh/plan-build-verify');
    expect(script).toContain('plugins/cursor');
    expect(script).toContain('~/.cursor/plugins/local/plan-build-verify'.replace('~', '${HOME}'));
  });

  it('keeps unrelated skill installs', () => {
    expect(script).toContain('add_skill gannonh/skills --skill thermo-run');
    expect(script).toContain('add_skill gannonh/skills --skill readme');
    expect(script).toContain('add_skill vercel/sandbox --skill sandbox');
  });
});

describe('AGENTS.md plan-build-verify plugin docs', () => {
  const agents = readFileSync(agentsPath, 'utf8');

  it('documents plugin install instead of the deleted pack path', () => {
    expect(agents).toContain('marketplace add gannonh/plan-build-verify');
    expect(agents).toMatch(/Do not `npx skills add gannonh\/skills --skill plan-build-verify`/);
  });

  it('keeps pstack as a separate Cursor plugin', () => {
    expect(agents).toContain('pstack');
    expect(agents).toMatch(/separate install/i);
  });
});
