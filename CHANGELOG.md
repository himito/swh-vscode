# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.1.0](https://github.com/himito/vscode-swh/releases/tag/v0.1.0) - 2026-11-08

### Added

- **Status**, **Visits** and **Save** commands: is the repository archived, and its upstream commit too; its last archival visits; and a save request to Software Heritage. Each has a variant for another repository.
- **SWHID** commands: copy the SWHID of the current file, selected lines or directory, the SWHID of the version the archive holds, the archive permalink or a Markdown link, or open it in the archive.
- Qualified SWHIDs, with their `origin`, `visit`, `anchor`, `path` and `lines` context, or bare ones with the `swh.swhidWithoutContext` setting or the `bare` keybinding argument.
- **Cite** command: a BibTeX entry, made by the archive from `codemeta.json` or `CITATION.cff`, or a minimal one.
- Status bar item: whether the current file, or the workspace folder, is archived. Click it to copy the SWHID.
- **Scan** view: the tracked working tree, each file and directory marked archived, partially archived or not archived.
- Clickable SWHIDs in every document, opening them in the archive.
- The Software Heritage side bar with the **Menu** view, and a Quick Pick menu of the commands.
- API token from the `SWH_API_TOKEN` environment variable or VS Code's secret storage; without one, the status bar shows the API requests used this hour.
- Settings: `swh.archiveUrl`, `swh.swhidWithoutContext`, `swh.statusBar.enabled`, `swh.statusBar.lighters`, `swh.documentLinks.enabled` and `swh.gitPath`.
