#!/usr/bin/env node
/**
 * Verify correlated Vercel project/team responses.
 *
 * The project must directly name the expected team through accountId, and the
 * separately returned team object must directly match the expected ID/slug.
 * Independent unions of IDs and slugs are intentionally not accepted.
 */
let input = '';
for await (const chunk of process.stdin) input += chunk;
let value;
try {
  const start = input.indexOf('{');
  if (start < 0) throw new Error('no JSON object');
  value = JSON.parse(input.slice(start));
} catch {
  throw new Error('Vercel project/team inspection did not return JSON');
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

function listFrom(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value[key])) return value[key];
  if (value && typeof value === 'object' && typeof value.id === 'string') return [value];
  return [];
}

const projectResponse = value.projects ?? value.projectList ?? value;
const teamResponse = value.teams ?? value.teamList ?? {};
const projects = listFrom(projectResponse, 'projects');
const teams = listFrom(teamResponse, 'teams');
const matchingProjects = projects.filter((project) => project && project.id === expected.projectId);
if (matchingProjects.length !== 1) {
  throw new Error('Vercel project response does not contain exactly one expected project');
}
const project = matchingProjects[0];
if (project.name !== expected.projectSlug) {
  throw new Error('Vercel project name does not match the expected project slug');
}
if (project.accountId !== expected.teamId) {
  throw new Error('Vercel project account does not match the expected team ID');
}
const matchingTeams = teams.filter((team) => team && team.id === expected.teamId);
if (matchingTeams.length !== 1) {
  throw new Error('Vercel team response does not contain exactly one expected team');
}
if (matchingTeams[0].slug !== expected.teamSlug) {
  throw new Error('Vercel team slug does not match the expected team');
}
console.log('Vercel project/team identity: verified');
