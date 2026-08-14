#!/usr/bin/env node
/** Verify a Vercel project-list response belongs to the expected scope. */
let input = '';
for await (const chunk of process.stdin) input += chunk;
let value;
try {
  const start = input.indexOf('{');
  if (start < 0) throw new Error('no JSON object');
  value = JSON.parse(input.slice(start));
} catch {
  throw new Error('Vercel project inspection did not return JSON');
}

function option(name, envName) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : process.env[envName];
}
const expected = {
  teamId: option('expected-team-id', 'EXPECTED_TEAM_ID'),
  teamSlug: option('expected-team-slug', 'EXPECTED_TEAM_SLUG'),
  projectId: option('expected-project-id', 'EXPECTED_PROJECT_ID'),
  projectSlug: option('expected-project-slug', 'EXPECTED_PROJECT_SLUG'),
};
for (const [name, item] of Object.entries(expected)) {
  if (!item) throw new Error(`expected ${name} is required for project identity verification`);
}

function collect(node, context = 'root', result = {
  teamIds: new Set(), teamSlugs: new Set(), projectIds: new Set(), projectSlugs: new Set(),
}) {
  if (!node || typeof node !== 'object') return result;
  for (const [key, child] of Object.entries(node)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, '');
    if (typeof child === 'string') {
      if (['teamid', 'ownerid', 'accountid'].includes(normalized)) result.teamIds.add(child);
      if (normalized === 'projectid') result.projectIds.add(child);
      if (['teamslug', 'ownerslug', 'team'].includes(normalized)) result.teamSlugs.add(child);
      if (['projectslug', 'project', 'name'].includes(normalized) && context === 'project') result.projectSlugs.add(child);
      if (normalized === 'id' && context === 'team') result.teamIds.add(child);
      if (normalized === 'id' && context === 'project') result.projectIds.add(child);
      if (normalized === 'slug' && context === 'team') result.teamSlugs.add(child);
      if (normalized === 'slug' && context === 'project') result.projectSlugs.add(child);
    }
    const nextContext = ['team', 'teams', 'owner', 'account'].includes(normalized)
      ? 'team'
      : ['project', 'projects'].includes(normalized)
        ? 'project'
        : context;
    collect(child, nextContext, result);
  }
  return result;
}

const identity = collect(value);
if (!identity.projectIds.has(expected.projectId)) throw new Error('Vercel project identity does not match the expected project ID');
if (!identity.projectSlugs.has(expected.projectSlug)) throw new Error('Vercel project identity does not match the expected project slug');
if (!identity.teamIds.has(expected.teamId)) throw new Error('Vercel project identity does not include the expected team ID');
if (!identity.teamSlugs.has(expected.teamSlug)) throw new Error('Vercel project identity does not include the expected team slug');
console.log('Vercel project identity: verified');
