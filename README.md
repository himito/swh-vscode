# Software Heritage for VS Code

A [Software Heritage](https://www.softwareheritage.org) (SWH) client for VS Code. Use it to archive your code, cite it with a [SWHID](https://www.swhid.org), and see which of your files are already archived.

This project is inspired by [swh.el](https://github.com/bzg/swh.el), the Software Heritage client for Emacs.

## The side bar

The activity bar has a Software Heritage icon (the SWH logo). It opens two views:

- **Menu**: the commands below, in groups. Click one to run it on the current file, selection or folder. The *Without context* checkbox switches `swh.swhidWithoutContext` on or off.
- **Scan**: the scan of the repository, see [Scan view](#scan-view).

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

The status bar shows whether the current file is archived. With no file open, it shows the same for the workspace folder:

- `SWH✓` archived
- `SWH✗` not archived
- `SWH~` not archived, but the origin is
- `SWH…` checking
- `SWH!` the check failed

The status is checked when you switch to a file and each time you save it. Click the item to copy the SWHID. Without a token, the item also shows how many API requests you have used this hour, e.g. `SWH✓ 48/120`.

### Scan view

**Scan** fills the *Scan* view of the Software Heritage side bar with the tracked working tree. Each file and directory is marked as archived, partially archived or not archived, and each directory shows how many of its files are archived. Archived directories start folded. Its context menu can:

- open the item in the archive
- copy its SWHID

### SWHID links

SWHIDs in any document become clickable links that open in the archive. This includes the *Visits* and *Cite* reports. Turn it off with `swh.documentLinks.enabled`.

## Token or not token

Without a token, the archive allows 120 requests per hour. With a token [from your archive account](https://archive.softwareheritage.org/api/#authentication), it allows 1200.

Either set the `SWH_API_TOKEN` environment variable (swhd reads it too), or run **Software Heritage: Set API token**. That stores the token in VS Code's secret storage, not in your settings.

## The swhd daemon

You can also run the local [swhd](https://github.com/bzg/swhd) daemon (0.8.0 or later). It caches SWHIDs. Whenever it answers at `swh.daemonUrl`, the extension goes through it, which saves on the API's rate limit. The scan view's header says which backend was used.

```shell
bbin install io.github.bzg/swhd
```

## Settings

| Setting | Default | |
|---|---|---|
| `swh.archiveUrl` | `https://archive.softwareheritage.org` | The archive's web root. SWHIDs resolve there, and its Web API is at `/api/1` |
| `swh.daemonUrl` | `http://127.0.0.1:8642` | swhd's URL. Empty: never use it |
| `swh.swhidWithoutContext` | `false` | SWHID commands give bare SWHIDs |
| `swh.statusBar.enabled` | `true` | Show the archival status in the status bar |
| `swh.statusBar.lighters` | `SWH✓` … | The status bar texts, by status |
| `swh.documentLinks.enabled` | `true` | Make SWHIDs in documents clickable |
| `swh.gitPath` | `git` | The git executable |

## Requirements

You need VS Code 1.90 or later and `git`. Only local files are supported: Remote and virtual workspaces are not. SWHIDs are SHA-1 based, so repositories that use SHA-256 are not supported either.

## Development

```shell
npm install
npm test        # unit tests, and the Git backend on a temporary repository
npm run smoke   # runs the commands in a real VS Code
```

To try the extension, press F5 in VS Code. To package it, run `npx @vscode/vsce package`.

### Project structure

```text
├── package.json         The extension manifest: commands, menus, views, settings
├── tsconfig.json
├── assets/
│   ├── swh-logo.svg     The activity bar icon (monochrome)
│   └── swh-logo-128.png The extension's icon
├── src/
│   ├── extension.ts     Activation: wires everything and registers the commands
│   ├── commands.ts      The commands: status, visits, save, SWHIDs, citations, menu
│   ├── backend.ts       The backend: the swhd daemon, else Git and the archive's Web API
│   ├── git.ts           Running git, and the temporary index copies
│   ├── http.ts          HTTP requests, and the error types
│   ├── swhid.ts         SWHIDs, origins and their encodings (pure functions)
│   ├── citation.ts      BibTeX entries
│   ├── scanModel.ts     The scan as a tree, and its figures (pure functions)
│   ├── scanView.ts      The Scan view
│   ├── menuView.ts      The Menu view
│   ├── statusBar.ts     The archival status in the status bar
│   ├── reports.ts       The read-only reports (visits, citations) and the SWHID links
│   └── ui.ts            Shared helpers: messages, progress, the current file or folder
└── test/
    ├── swhid.test.ts    Unit tests: SWHIDs, origins, citations, the scan model
    ├── backend.test.ts  Unit tests: the backend on a temporary repository, the archive mocked
    └── smoke/           Smoke test in a real VS Code
        ├── run.ts       Downloads VS Code and opens it on a temporary repository
        └── suite.ts     Runs the commands in the extension host
```

`npm test` runs only the `*.test.ts` files, with Node: the smoke test needs VS Code's extension host.

Only the modules that import `vscode` need VS Code: [extension.ts](src/extension.ts), [commands.ts](src/commands.ts), the views, [statusBar.ts](src/statusBar.ts), [reports.ts](src/reports.ts) and [ui.ts](src/ui.ts). The others are plain TypeScript, which is why the unit tests can run them with Node alone.

## License

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).
