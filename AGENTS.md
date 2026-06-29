# Global Agent Instructions

## Open Knowledge Format docs

This repository maintains an [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle at `./docs`.

- Read `./docs/index.md` before substantial work.
- Follow cross-links into relevant specs, ADRs, runbooks, guides, architecture notes, reference docs, and domain docs before changing related code.
- Keep `./docs/specs/index.md` current as the roadmap for active, planned, blocked, and completed work.
- Add or update ADRs in `./docs/adrs` for durable architecture decisions.
- After substantial work, PRs, behavior changes, architecture decisions, migrations, or documentation moves, update the OKF bundle and add concise entries to the relevant `log.md` files.
- Maintain Markdown cross-links between related OKF concepts so future agents can traverse decisions, specs, architecture, runbooks, guides, and references.
- Every non-reserved Markdown file under `./docs` should have OKF frontmatter with at least a non-empty `type` field. `index.md` and `log.md` are reserved navigation/history files.
