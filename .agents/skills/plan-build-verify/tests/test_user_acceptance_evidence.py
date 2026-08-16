from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts" / "user-acceptance"
VERIFY = SCRIPTS / "verify-evidence.mjs"
INIT = SCRIPTS / "init-evidence.mjs"
CAPTURE = SCRIPTS / "run-capture-command.mjs"

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
VIDEO_SKIP = (
    "Video: Skipped — codec unavailable; attempted: agent-browser; "
    "suggested tooling: install a compatible WebM codec"
)


def create_evidence(
    root: Path,
    *,
    target: str = "web",
    mode: str = "user-facing",
    visual: bool | None = None,
    command_kind: str = "e2e",
    checkpoints: tuple[str, ...] = ("starting", "final"),
    valid_images: bool = True,
    video: bool = False,
    video_note: str | None = VIDEO_SKIP,
    slices: list[dict[str, object]] | None = None,
    include_technical_approval: bool = True,
) -> Path:
    root.mkdir()
    (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")

    command_log = root / "e2e.log"
    command_log.write_text("passed\n", encoding="utf-8")
    artifacts: list[dict[str, object]] = []
    screenshot_paths: list[str] = []
    for index, checkpoint in enumerate(checkpoints):
        screenshot = root / f"screenshot-{index}.png"
        screenshot.write_bytes(PNG_1X1 if valid_images else b"not an image")
        screenshot_paths.append(str(screenshot))
        artifacts.append(
            {
                "type": "screenshot",
                "checkpoint": checkpoint,
                "path": str(screenshot),
            }
        )
    if video:
        recording = root / "flow.webm"
        recording.write_bytes(b"webm")
        artifacts.append({"type": "video", "path": str(recording)})

    if visual is None:
        visual = target in {"web", "electron", "native", "tui", "mixed"}
    if slices is None:
        evidence_path = screenshot_paths[-1] if screenshot_paths else str(command_log)
        slices = [
            {
                "id": "feature-flow",
                "name": "Feature flow",
                "result": "Pass",
                "evidence": [evidence_path],
            }
        ]

    technical_enablement = None
    if mode == "technical-enablement" and include_technical_approval:
        technical_enablement = {
            "approval_ref": "https://github.com/acme/widgets/issues/1#issuecomment-1",
            "blocker": "The external contract must exist before the UI slice can start.",
            "minimum_scope": "Publish the bounded contract.",
            "unlocked_slice": "User completes the widget flow.",
            "dependency_ref": "https://github.com/acme/widgets/issues/2",
        }

    manifest = {
        "scope": "feature flow",
        "target": target,
        "mode": mode,
        "visual": visual,
        "technical_enablement": technical_enablement,
        "timestamp": "2026-08-16T00:00:00Z",
        "git_commit": "abc123",
        "artifacts": artifacts,
        "commands": [
            {
                "name": "feature-e2e",
                "kind": command_kind,
                "argv": ["npm", "run", "test:e2e"],
                "command": '"npm" "run" "test:e2e"',
                "exit_code": 0,
                "output_path": str(command_log),
            }
        ],
        "slices": slices,
        "notes": [video_note] if video_note else [],
    }
    (root / "evidence.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def verify(evidence: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(VERIFY), "--evidence", str(evidence)],
        capture_output=True,
        text=True,
    )


def test_visual_evidence_accepts_e2e_checkpoints_and_bounded_video_skip(tmp_path: Path) -> None:
    result = verify(create_evidence(tmp_path / "evidence"))

    assert result.returncode == 0, result.stderr


def test_visual_evidence_requires_distinct_starting_and_final_checkpoints(tmp_path: Path) -> None:
    result = verify(create_evidence(tmp_path / "evidence", checkpoints=("final", "final")))

    assert result.returncode == 1
    assert "starting screenshot" in result.stderr


def test_visual_evidence_rejects_same_file_for_starting_and_final(tmp_path: Path) -> None:
    evidence = create_evidence(tmp_path / "evidence")
    manifest_path = evidence / "evidence.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["artifacts"][1]["path"] = manifest["artifacts"][0]["path"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = verify(evidence)

    assert result.returncode == 1
    assert "distinct screenshot artifacts" in result.stderr


def test_visual_evidence_rejects_unreadable_screenshots(tmp_path: Path) -> None:
    result = verify(create_evidence(tmp_path / "evidence", valid_images=False))

    assert result.returncode == 1
    assert "not a readable PNG" in result.stderr


def test_visual_evidence_requires_complete_video_skip_metadata(tmp_path: Path) -> None:
    result = verify(
        create_evidence(
            tmp_path / "evidence",
            video_note="Video: Skipped — recorder failed",
        )
    )

    assert result.returncode == 1
    assert "suggested tooling" in result.stderr


def test_user_facing_evidence_requires_passing_e2e_command(tmp_path: Path) -> None:
    result = verify(
        create_evidence(
            tmp_path / "evidence",
            target="api",
            visual=False,
            checkpoints=(),
            command_kind="contract",
            video_note=None,
        )
    )

    assert result.returncode == 1
    assert "kind e2e" in result.stderr


def test_technical_enablement_requires_approved_exception_metadata(tmp_path: Path) -> None:
    result = verify(
        create_evidence(
            tmp_path / "evidence",
            target="api",
            mode="technical-enablement",
            visual=False,
            command_kind="contract",
            checkpoints=(),
            video_note=None,
            include_technical_approval=False,
        )
    )

    assert result.returncode == 1
    assert "technical_enablement needs approval_ref" in result.stderr


def test_technical_enablement_requires_github_approval_provenance(tmp_path: Path) -> None:
    evidence = create_evidence(
        tmp_path / "evidence",
        target="api",
        mode="technical-enablement",
        visual=False,
        command_kind="contract",
        checkpoints=(),
        video_note=None,
    )
    manifest_path = evidence / "evidence.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["technical_enablement"]["approval_ref"] = "approved somewhere"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = verify(evidence)

    assert result.returncode == 1
    assert "approval_ref must be a GitHub issue" in result.stderr


def test_technical_enablement_accepts_contract_with_approval_metadata(tmp_path: Path) -> None:
    result = verify(
        create_evidence(
            tmp_path / "evidence",
            target="api",
            mode="technical-enablement",
            visual=False,
            command_kind="contract",
            checkpoints=(),
            video_note=None,
        )
    )

    assert result.returncode == 0, result.stderr


def test_evidence_requires_nonempty_passing_acceptance_slices(tmp_path: Path) -> None:
    empty = verify(create_evidence(tmp_path / "empty", slices=[]))
    failed = verify(
        create_evidence(
            tmp_path / "failed",
            slices=[
                {
                    "id": "feature-flow",
                    "name": "Feature flow",
                    "result": "Fail",
                    "evidence": [str(tmp_path / "failed" / "e2e.log")],
                }
            ],
        )
    )

    assert empty.returncode == 1
    assert "non-empty array" in empty.stderr
    assert failed.returncode == 1
    assert "is Fail" in failed.stderr


def test_invalid_target_cannot_bypass_visual_evidence(tmp_path: Path) -> None:
    result = verify(
        create_evidence(
            tmp_path / "evidence",
            target="unknown",
            visual=False,
            checkpoints=(),
            video_note=None,
        )
    )

    assert result.returncode == 1
    assert "invalid target" in result.stderr


def test_capture_command_records_kind_and_argv(tmp_path: Path) -> None:
    evidence = tmp_path / "evidence"
    init = subprocess.run(
        [
            "node",
            str(INIT),
            "--target",
            "api",
            "--mode",
            "user-facing",
            "--visual",
            "false",
            "--scope",
            "API flow",
            "--dir",
            str(evidence),
        ],
        capture_output=True,
        text=True,
    )
    assert init.returncode == 0, init.stderr

    capture = subprocess.run(
        [
            "node",
            str(CAPTURE),
            "--evidence",
            str(evidence),
            "--kind",
            "e2e",
            "--name",
            "api-e2e",
            "--",
            "node",
            "-e",
            "console.log('passed')",
        ],
        capture_output=True,
        text=True,
    )
    assert capture.returncode == 0, capture.stderr

    manifest = json.loads((evidence / "evidence.json").read_text(encoding="utf-8"))
    assert manifest["mode"] == "user-facing"
    assert manifest["visual"] is False
    assert manifest["commands"][0]["kind"] == "e2e"
    assert manifest["commands"][0]["argv"] == ["node", "-e", "console.log('passed')"]
