# Software Heritage for VS Code

[![Release](https://github.com/himito/vscode-swh/actions/workflows/release.yml/badge.svg)](https://github.com/himito/vscode-swh/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/himito/vscode-swh?sort=semver)](https://github.com/himito/vscode-swh/releases)
[![Visual Studio Marketplace](https://badgen.net/vs-marketplace/v/himito.vscode-swh)](https://marketplace.visualstudio.com/items?itemName=himito.vscode-swh)
[![Open VSX](https://img.shields.io/open-vsx/v/himito/vscode-swh?label=Open%20VSX)](https://open-vsx.org/extension/himito/vscode-swh)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
[![Archived in Software Heritage](https://archive.softwareheritage.org/badge/origin/https://github.com/himito/vscode-swh/)](https://archive.softwareheritage.org/browse/origin/?origin_url=https://github.com/himito/vscode-swh)

A [Software Heritage](https://www.softwareheritage.org) (SWH) client for VS Code. Use it to archive your code, cite it with a [SWHID](https://www.swhid.org), and see which of your files are already archived.

This project is inspired by [swh.el](https://github.com/bzg/swh.el), the Software Heritage client for Emacs.

Install it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=himito.vscode-swh), or from [Open VSX](https://open-vsx.org/extension/himito/vscode-swh) for VSCodium and other editors that use it. In VS Code: open the Extensions view, search for *Software Heritage*, and install it. From a terminal: `code --install-extension himito.vscode-swh`.

## Contents

- [The side bar](#the-side-bar)
- [Commands](#commands)
  - [Context or no context](#context-or-no-context)
  - [Status bar](#status-bar)
  - [Scan view](#scan-view)
  - [SWHID links](#swhid-links)
- [Token or no token](#token-or-no-token)
- [Settings](#settings)
- [Requirements](#requirements)
- [Contributing](#contributing)
- [License](#license)

## The side bar

The activity bar has a Software Heritage icon (the SWH logo). It opens two views:

- **Menu**: the commands below, in groups. Click one to run it on the current file, selection or folder. Click *Without context* to switch `swh.swhidWithoutContext` on or off; its filter icon is filled when it is on.
- **Scan**: the scan of the repository (see [Scan view](#scan-view)).

## Commands

All commands are in the Command Palette under **Software Heritage:**. Most of them are also in the *Software Heritage* submenu of the editor's and the Explorer's context menus.

| Command | What it does |
|---|---|
| **Menu…** | A menu of the commands below, with the *without context* switch |
| **Status** | Is the repo archived, and its upstream commit too? If not, offers to save it |
| **Visits** | When was it last visited by SWH? |
| **Save** | Save your repository to SWH now |
| **SWHID: copy** | Copy the SWHID of the current file, selected lines, or directory |
| **SWHID: copy the archived version** | Copy the SWHID of the version the archive holds |
| **SWHID: copy the archive link** | Copy the permalink to it in the archive |
| **SWHID: open in the archive** | Open it in the archive |
| **SWHID: copy as a Markdown link** | Copy `[file, lines A-B](permalink)` |
| **Cite** | Copy a BibTeX entry citing the code and show it |
| **Scan** | Show the repository's tracked files as a tree, archived or not |
| **Refresh** | Forget what may have changed in the SWH archive |
| **Open a SWHID in the archive…** | Prompt for a SWHID and open it |
| **Toggle SWHIDs without context** | Switch `swh.swhidWithoutContext` on or off |
| **Set API token** / **Clear API token** | Store the token in VS Code's secret storage |

**Status**, **Visits**, **Save** and **Cite** ask for the URL of a public repository when there is no public origin here. To ask about another repository anyway, use the **… of another repository…** variants.

In the Explorer, the commands act on the file or folder you clicked. In an editor, they act on the file and its selected lines. With no file open, they act on the workspace folder.

### Context or no context

By default, the SWHID commands give a *qualified* SWHID, with its context: `origin`, `visit`, `anchor`, `path` and `lines`. Set `swh.swhidWithoutContext` to get bare SWHIDs instead. In the **Menu…**, the *Without context* item toggles this setting for that one use. Keybindings can also choose:

```jsonc
// keybindings.json
{ "key": "ctrl+alt+s", "command": "swh.menu" },
{ "key": "ctrl+alt+i", "command": "swh.swhidCopy", "args": { "bare": true } }
```

### Status bar

The status bar shows whether the current file is archived, with the same icons as the Scan view. With no file open, it shows the same for the workspace folder:

- a check mark, archived
- a cross, not archived
- an empty circle, not archived, but the origin is
- a spinner, checking
- a warning sign, the check failed

The status is checked when you switch to a file and each time you save it. An archived file that has not changed is not checked again; any other status is, as it may have changed since. Click the item to copy the SWHID. Without a token, the item also shows how many API requests you have used this hour, e.g. `SWH 48/120`.

### Scan view

**Scan** fills the *Scan* view of the Software Heritage side bar with the tracked working tree. Each file and directory is marked as archived, partially archived or not archived, and each directory shows how many of its files are archived. Archived directories start folded. Click a file to open it. Each item's context menu lets you:

- open the file
- open the item in the archive, when it is archived
- copy its SWHID

### SWHID links

SWHIDs in any document become clickable links that open in the archive. This includes the *Visits* and *Cite* reports. Turn it off with `swh.documentLinks.enabled`.

## Token or no token

Without a token, the archive allows 120 requests per hour. With a token [from your archive account](https://archive.softwareheritage.org/api/#authentication), it allows 1200.

Either set the `SWH_API_TOKEN` environment variable, or run **Software Heritage: Set API token**. That stores the token in VS Code's secret storage, not in your settings.

## Settings

| Setting | Default | |
|---|---|---|
| `swh.archiveUrl` | `https://archive.softwareheritage.org` | The archive's web root. SWHIDs resolve there, and its Web API is at `/api/1` |
| `swh.swhidWithoutContext` | `false` | SWHID commands give bare SWHIDs |
| `swh.statusBar.enabled` | `true` | Show the archival status in the status bar |
| `swh.statusBar.lighters` | `$(pass) SWH` … | The status bar texts, by status; `$(name)` shows the [codicon](https://code.visualstudio.com/api/references/icons-in-labels#icon-listing) of that name |
| `swh.documentLinks.enabled` | `true` | Make SWHIDs in documents clickable |
| `swh.gitPath` | `git` | The git executable |

## Requirements

You need VS Code 1.90 or later and `git`. Only local files are supported: remote and virtual workspaces are not. SWHIDs are SHA-1-based, so repositories that use SHA-256 are not supported either.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) to report a bug, suggest a feature, or set up the project: the branches (Git Flow), the commit messages (Conventional Commits), the tests, the changelog, the releases, and the architecture.

## License

This project is licensed under GPL-3.0. See [LICENSE](LICENSE).
