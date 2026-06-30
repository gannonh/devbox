# Bundle Update Log

## 2026-06-29
* **Initialization**: Created the OKF bundle root, specs roadmap, ADR scaffold, and AGENTS.md guidance.
* **Indexing**: Linked the implemented [@gannonh/devbox npm package](/specs/2026-06-28-devbox-npm-package-design.md) spec into the bundle map.

## 2026-06-30
* **Release access**: Marked the release workflow and package metadata public for npm publishing.

## 2026-06-30 (2)
* **Release workflow redesign**: Switched to publish-first single-trigger (manual dispatch only) so a failed `npm publish` leaves no tag or release page. Stage both `package.json` and `package-lock.json` in the version commit to avoid empty-commit failures on re-runs. Create a GitHub Release with `npx`/`npm install` instructions after publish succeeds. Reset repo version to `0.0.0` and deleted the dangling `v0.1.0` tag from the failed publish.
