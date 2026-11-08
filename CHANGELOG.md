# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.1.1](https://github.com/himito/vscode-swh/releases/tag/v0.1.1) - 2026-11-08

### Changed

- A save request refused for a non-public origin now names the origin.

### Fixed

- Files no longer show as not archived when **Refresh** or a save request runs while the archive is being asked, e.g. during a scan.
- **Cite** opens the citation report at once, without waiting for the save request it offers to be answered, and still opens it when that request fails.
- **Visits** no longer says an origin is not archived when **Status** says it is: it tells when the archive holds the origin but lists no visit of it that can be shown.
- The status bar no longer shows the status of a file left before its check ended.
- The **Scan** view no longer counts submodules as files.
- Markdown links escape the file name, e.g. `__init__.py`, and the parentheses of the URL, so that the link renders as it should.
- Minimal BibTeX entries escape LaTeX's special characters, e.g. `_` or `&` in a title, so that they compile.
- SWHIDs with a blank, or with malformed qualifiers, are no longer taken as valid.
- A Git index that cannot be read is reported, instead of being taken as empty.
- **Visits** without a repository no longer asks about the directory VS Code was started from.
- A blank `swh.archiveUrl` or `swh.gitPath`, as left by clearing the field in the Settings UI, means the default again, instead of breaking every request and link.

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
