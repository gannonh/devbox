# Web Evidence Playbook

Use the actual web app and capture what a human would see. Tests can supplement this walkthrough after evidence is collected.

## Tool choice

- Prefer `agent-browser` for web apps and browser automation. Verify the installed CLI with `agent-browser --help` because command sets vary by version.
- Use `playwright` when the repo already uses Playwright, when traces are useful, or when `agent-browser` cannot complete the flow.
- Use `chrome-cdp` only when the user explicitly approved inspection of an already-open Chrome page.

If the needed skill or CLI is missing, install it with `npx agents install <skill-name>`, then follow that skill's installation instructions. Do not rely on `agent-browser skills get ...` unless the installed CLI confirms that command exists.

## Evidence priority

1. Passing E2E test through the browser-visible public interface.
2. Required starting and final screenshots, plus key-interaction screenshots when a criterion needs intermediate proof.
3. Video of the feature flow when practical, especially for interaction, transitions, timing, state changes, or error handling.
4. Accessibility, DOM, or body-text snapshots that confirm the state.
5. Console, network, or app logs when they explain behavior.
6. Negative evidence for bugfixes: saved searches showing the old error, flag, or stale wording is absent from logs and active source/docs.

If a preferred screenshot tool fails, use one fallback and save a note in `logs/`; if it also fails, mark the slice blocked. For video, use `agent-browser record start/stop` or existing Playwright video. After the preferred recorder and one bounded retry or fallback fail, add the standardized `Video: Skipped` note and continue.

## Web app workflow

1. Start the app with the repo's documented dev command.
2. Open the app in a real browser.
3. Navigate to the feature through the normal user path.
4. Run the checked-in browser E2E test and capture it with command kind `e2e`.
5. Capture a starting screenshot.
6. Start video when practical.
7. Perform the user actions: click, fill, select, scroll, upload, download, or navigate.
8. Capture the required final screenshot and any key checkpoint needed by an acceptance criterion.
9. Stop and save video, or record the standardized skip note after the bounded attempt.
10. Save logs or generated files that prove the result.

Example shape:

```bash
npm run dev 2>&1 | tee uat-evidence/web-<timestamp>/logs/dev-server.log
node scripts/user-acceptance/run-capture-command.mjs --evidence <dir> --kind e2e --name feature-e2e -- npm run test:e2e
agent-browser open http://localhost:3000
agent-browser snapshot -i > uat-evidence/web-<timestamp>/logs/start-snapshot.txt
agent-browser screenshot uat-evidence/web-<timestamp>/screenshots/01-start.png
agent-browser record start uat-evidence/web-<timestamp>/recordings/feature-flow.webm
# interact with the feature using current element refs
agent-browser screenshot uat-evidence/web-<timestamp>/screenshots/02-result.png
agent-browser record stop
agent-browser snapshot -i > uat-evidence/web-<timestamp>/logs/result-snapshot.txt
```

## Adversarial evidence review

After collecting artifacts, ask an adversarial review subagent to compare the evidence against the spec, acceptance criteria, requirements, PR description, or ticket when subagents are available. The review must return `Pass` or `Fail` for each criterion and cite exact artifact paths or log lines. Treat a missing/failed E2E test, missing screenshots, inaccessible required files, or ambiguous proof as a failed or blocked criterion. Missing video alone is acceptable only with the standardized skip note, unless the criterion explicitly requires temporal proof.

If subagents are unavailable, perform the same check inline and label it `Inline adversarial review`.

## Manual instructions

Write normal user steps first:

```markdown
Manual Run Instructions:
1. Start the app with `<command>`.
   Expected: the app opens at `<url>`.
2. Go to `<screen>`.
   Expected: `<visible state>`.
3. Click `<control>` and enter `<sample input>`.
   Expected: `<result>`.
```

Keep automation commands, seeded data, and test harnesses out of the primary UI path. If unavoidable, place them under `Fallback (Engineering Only)` and explain why.
