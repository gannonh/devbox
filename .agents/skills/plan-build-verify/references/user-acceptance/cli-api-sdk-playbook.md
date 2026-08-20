# CLI, TUI, API, and SDK Evidence Playbook

Use the changed interface directly and save outputs a human can inspect or rerun.

## Evidence priority

Every target first needs a passing public-boundary E2E/system test captured with command kind `e2e`.

CLI:

1. Terminal transcript with exact command and exit code.
2. Generated output files.
3. JSON or structured output.
4. Screenshot or recording when visual formatting matters.

TUI:

1. Required starting and final screenshots, plus key screens when a criterion needs intermediate proof.
2. Transcript, config, and output files where available.
3. Video or GIF of the terminal flow when practical.

API:

1. Request payload.
2. Response body and status code.
3. Logs showing the service handled the request.
4. Follow-up read that confirms persisted state.

SDK:

1. Minimal runnable example against the built package.
2. Command output.
3. Generated files or returned objects.
4. Logs when they clarify behavior.

## CLI workflow

1. Build or install the CLI as the repo documents.
2. Run the checked-in CLI E2E/system test and capture it with command kind `e2e`.
3. Run the command that exercises the changed behavior.
4. Save stdout, stderr, and exit code.
5. Save any generated files under `outputs/`.
6. Run one trust-check command that confirms the output.
7. For bugfixes, save a negative check that the old error or stale output is absent.

Prefer the bundled runner when practical because it records logs and exit codes in the manifest:

```bash
node scripts/user-acceptance/init-evidence.mjs --target cli --mode user-facing --visual false --scope "tasker JSON export"
node scripts/user-acceptance/run-capture-command.mjs --evidence <dir> --kind supporting --name export-json -- \
  tasker export --format json --output <dir>/outputs/tasks.json
node scripts/user-acceptance/run-capture-command.mjs --evidence <dir> --kind supporting --name validate-json -- \
  jq . <dir>/outputs/tasks.json
```

Manual fallback shape:

```bash
mkdir -p uat-evidence/cli-<timestamp>/logs uat-evidence/cli-<timestamp>/outputs
set -o pipefail
mytool process --input fixtures/sample.csv --format json \
  2>&1 | tee uat-evidence/cli-<timestamp>/logs/process.log
status=${PIPESTATUS[0]}
echo "$status" > uat-evidence/cli-<timestamp>/logs/process.exitcode
jq . uat-evidence/cli-<timestamp>/outputs/result.json > uat-evidence/cli-<timestamp>/logs/result-json.txt
```

## TUI workflow

1. Run the checked-in TUI E2E/system test and capture it with command kind `e2e`.
2. Start the TUI with a deterministic fixture or normal local state.
3. Exercise the changed keyboard or mouse flow.
4. Capture required starting/final screenshots, any criterion-specific key states, and written files.
5. Record exact keystrokes in `evidence.md` so the user can replay them.

Use `script` for transcripts, VHS for deterministic screenshots/GIF/MP4/WebM, or an installed computer-use CLI for a real terminal window. Video is ideal but optional: after one bounded recording fallback, skip and flag it rather than spinning.

## API workflow

1. Start the service locally or identify the target environment.
2. Run the checked-in public-API E2E/system test and capture it with command kind `e2e`.
3. Save request payloads under `responses/` or `payloads/`.
4. Execute the request with `curl`, repo scripts, or the documented client.
5. Save response body and status code.
6. Run a follow-up GET/list/read when persistence or side effects matter.
7. Save relevant logs.
8. Record blocked credentials or unavailable services as blocked slices rather than passing them from tests alone.

Example shape:

```bash
mkdir -p uat-evidence/api-<timestamp>/responses uat-evidence/api-<timestamp>/logs
cat > uat-evidence/api-<timestamp>/responses/create-request.json <<'JSON'
{"name":"UAT sample"}
JSON
curl -sS -X POST http://localhost:8080/api/items \
  -H 'Content-Type: application/json' \
  -d @uat-evidence/api-<timestamp>/responses/create-request.json \
  -w '\nHTTP_STATUS:%{http_code}\n' \
  | tee uat-evidence/api-<timestamp>/responses/create-response.txt
```

## SDK workflow

1. Run the checked-in SDK E2E/system test against the built package and capture it with command kind `e2e`.
2. Create a minimal example file in a temporary or evidence directory.
3. Import the local SDK build or package path.
4. Call the changed API with representative inputs.
5. Print structured output.
6. Save command output and any generated files.
7. Keep the example small and runnable so the human can copy it into their environment.

Example shape:

```bash
mkdir -p uat-evidence/sdk-<timestamp>/examples uat-evidence/sdk-<timestamp>/logs
cat > uat-evidence/sdk-<timestamp>/examples/uat-example.mjs <<'JS'
import { client } from '../../dist/index.js';
const result = await client.doThing({ name: 'UAT sample' });
console.log(JSON.stringify(result, null, 2));
JS
node uat-evidence/sdk-<timestamp>/examples/uat-example.mjs \
  2>&1 | tee uat-evidence/sdk-<timestamp>/logs/sdk-example.log
```

## Manual instructions

For CLI, API, and SDK targets, include copy-pasteable reproduction steps:

```markdown
Manual Run Instructions:
1. Build the project: `<command>`.
   Expected: build exits 0.
2. Run: `<command>`.
   Expected: output contains `<specific result>`.
3. Inspect: `<file or follow-up command>`.
   Expected: `<specific data>`.
```

For TUI targets, include launch command, keystrokes, visible screen names, and expected final state.
