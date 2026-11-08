# Contributing to Software Heritage for VS Code

Thank you for taking the time to contribute! Bug reports, ideas, documentation and code are all welcome.

## Contents

- [Code of conduct](#code-of-conduct)
- [Reporting a bug](#reporting-a-bug)
- [Suggesting a feature](#suggesting-a-feature)
- [Reporting a security issue](#reporting-a-security-issue)
- [Development](#development)
  - [Setup](#setup)
  - [Branches: Git Flow](#branches-git-flow)
  - [Commits: Conventional Commits](#commits-conventional-commits)
  - [Pull requests](#pull-requests)
  - [Coding style](#coding-style)
  - [Tests](#tests)
  - [Documentation](#documentation)
  - [Changelog](#changelog)
  - [Releasing](#releasing)
  - [Project structure](#project-structure)
  - [Architecture](#architecture)
    - [Two halves: `core/` and `ui/`](#two-halves-core-and-ui)
    - [Packages](#packages)
    - [Imports](#imports)
    - [The client and the archive](#the-client-and-the-archive)
    - [Value objects](#value-objects)
    - [Commands](#commands)
- [License](#license)

## Code of conduct

Be respectful and constructive. Assume good faith, keep discussions about the code and the ideas, not the people, and welcome newcomers. Harassment of any kind is not tolerated.

## Reporting a bug

Search the [issues](https://github.com/himito/vscode-swh/issues) first: it may already be reported. If it is not, open one with:

- what you did, what you expected, and what happened instead;
- the versions of the extension, VS Code and Git, and your operating system;
- the messages in the *Software Heritage* output channel, or the error shown, if any;
- when you can, a public repository or the smallest steps that reproduce it.

Leave your API token out of the report.

## Suggesting a feature

Open an [issue](https://github.com/himito/vscode-swh/issues) that describes the problem it solves, before the solution. For a large change, discuss it in an issue before writing the code, so that the work fits the project.

## Reporting a security issue

Do not open a public issue for a vulnerability. Report it privately through [GitHub's security advisories](https://github.com/himito/vscode-swh/security/advisories/new), with the steps to reproduce it.

## Development

### Setup

You need Node.js, `git` and VS Code 1.90 or later.

```shell
npm install
npm test           # unit tests, and the client on a temporary Git repository
npm run smoke      # runs the commands in a real VS Code
npm run docs       # the API documentation, as HTML in docs/
npm run changelog  # what the commits since the last release would add to CHANGELOG.md
```

To try the extension, open the project in VS Code and press F5. To package it, run `npx @vscode/vsce package`.

### Branches: Git Flow

The project follows [Git Flow](https://nvie.com/posts/a-successful-git-branching-model/), for example with the [git-flow](https://github.com/nvie/gitflow) extension:

| Branch          | Purpose                                                | Branches from | Merges into          |
| --------------- | ------------------------------------------------------ | ------------- | -------------------- |
| `main`          | The released versions only, each tagged `vX.Y.Z`       |               |                      |
| `develop`       | The next release: where the features come together     | `main`        |                      |
| `feature/<name>`| A feature, a fix, or any change for the next release   | `develop`     | `develop`            |
| `release/X.Y.Z` | Prepares a release: version, changelog, last fixes     | `develop`     | `main` and `develop` |
| `hotfix/X.Y.Z`  | An urgent fix of a released version                    | `main`        | `main` and `develop` |

Never commit to `main` or `develop` directly: every change reaches them through a pull request. Name branches in lowercase, with hyphens: `feature/scan-filter`, `feature/fix-status-bar`.

### Commits: Conventional Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):

```text
<type>[(<scope>)][!]: <description>

[body]

[footer]
```

- The description is in the imperative, lowercase, with no final period: `feat: add a Markdown link command`.
- The scope is optional, and names the part changed: `fix(scan): count submodules as directories`.
- A breaking change has a `!` after the type or scope (`feat!: …`), or a `BREAKING CHANGE:` footer that says what to change.
- Keep each commit to one change, so that it can be reviewed and reverted alone.

The type tells whether users see the change, and the changelog is drafted from it (see [Changelog](#changelog)):

| Type             | Use it for                                    | Changelog section |
| ---------------- | --------------------------------------------- | ----------------- |
| `feat`           | A new feature                                 | Added             |
| `fix`            | A bug fix                                     | Fixed             |
| `fix(security)`  | A security fix                                | Security          |
| `perf`           | A performance improvement                     | Changed           |
| `revert`         | Reverting an earlier commit                   | Removed           |
| `refactor`       | A change of the code that changes no behavior | none              |
| `test`           | Adding or fixing tests                        | none              |
| `docs`           | Documentation only                            | none              |
| `style`          | Formatting only                               | none              |
| `build`          | The build, the dependencies, the packaging    | none              |
| `ci`             | The continuous integration                    | none              |
| `chore`          | Anything else that users do not see           | none              |

### Pull requests

1. Fork the repository, or create a branch if you can push to it, from `develop` (`feature/<name>`), or from `main` for a hotfix.
2. Make your change, with tests and documentation (see below).
3. Check that `npm test` passes, and run `npm run smoke` when the change touches the UI.
4. Open a pull request against `develop` (or `main` for a hotfix). Describe what it changes and why, and link the issue it closes (`Closes #12`).
5. Keep it focused on one change. Address the review with new commits; they may be squashed when merged.

### Coding style

- TypeScript, in strict mode. Use `type` for the shapes of data, and `interface` only where it is needed, or for ports: the contracts that classes implement, such as `ArchiveApi`.
- Prefer small functions with names that say what they do, and value objects (`Swhid`, `Qualifiers`, `LineRange`, `Citation`) to plain strings and tuples.
- Extract values to named local variables rather than calling methods inside array or object literals. A constant used only once stays a local variable, not a module-level one.
- Follow the import rules of [Architecture](#architecture): an alias between packages, a relative path within one, and a folder's `index.ts` holds only its exports.
- Keep the style of the code around your change.

### Tests

`npm test` compiles the project and runs the unit tests of `test/*.test.ts` with Node's test runner. A bug fix comes with a test that fails without it; a feature comes with tests of what it does. The tests of the client run on temporary Git repositories, with the archive faked or `fetch` mocked: they never reach the network.

`npm run smoke` downloads VS Code, and runs the commands in its extension host on a temporary repository.

### Documentation

- Every exported declaration has a [TSDoc](https://tsdoc.org) comment: what it is or does, its `@param`s in order, its `@returns`, and the `@throws` callers must handle. `npm run docs` must give no warning.
- A change users see goes in the [README](README.md) too: commands, settings, behavior.
- A change of the layout or of the architecture goes in [Project structure](#project-structure) and [Architecture](#architecture).

### Changelog

[CHANGELOG.md](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). It is written for users, so it is curated by hand, with [git-cliff](https://git-cliff.org) drafting each release from the commits (see [cliff.toml](cliff.toml)):

- Each commit type gives an entry in a section, or none (see [Commits](#commits-conventional-commits)). A breaking change is marked **BREAKING**.
- `npm run changelog` shows what the commits since the last release would add, without writing anything.
- The header of [cliff.toml](cliff.toml) must be exactly how `CHANGELOG.md` starts: git-cliff replaces it only then, and would otherwise write a second one.
- Released sections are never generated again: do not run `git cliff -o CHANGELOG.md`, which would replace them with the raw commits.

### Releasing

1. Start the release from `develop`: `git flow release start X.Y.Z`, following [Semantic Versioning](https://semver.org).
2. Set the version in `package.json`.
3. Run `npm run changelog:release`. It drafts the release at the top of `CHANGELOG.md`, right below its header: its heading and date, then the entries from the commits. Curate it: reword the entries for users, and add what the commits do not say. Commit it.
4. Finish the release: `git flow release finish X.Y.Z` merges it into `main` and `develop`, and tags it `vX.Y.Z`. Push `main`, `develop` and the tag.
5. Pushing the tag runs the [Release workflow](.github/workflows/release.yml): it runs the tests, checks that the tag matches `package.json`, packages the extension and creates the GitHub Release with the `.vsix`.

### Project structure

```text
├── package.json         The extension manifest: commands, menus, views, settings
├── CHANGELOG.md         The changes of each release (Keep a Changelog)
├── CONTRIBUTING.md      How to contribute
├── cliff.toml           How git-cliff drafts the releases of CHANGELOG.md
├── tsconfig.json
├── typedoc.json         The API documentation's settings (npm run docs)
├── assets/
│   ├── swh-logo.svg     The activity bar icon (monochrome)
│   └── swh-logo-128.png The extension's icon
├── src/
│   ├── extension.ts     Activation: wires everything and registers the commands
│   ├── core/            Plain TypeScript, no `vscode` import; one package per concern
│   │   ├── index.ts     The folder's public API: every package, re-exported
│   │   ├── shared/      What every package uses; it imports no other
│   │   │   ├── errors.ts      The error types: UserError, Cancelled
│   │   │   ├── encoding.ts    Percent-encoding, query strings, base URLs
│   │   │   ├── util.ts        Path ancestors, dates, time, and array helpers
│   │   │   └── types.ts       Shared type helpers, e.g. Maybe<T>
│   │   ├── origin.ts    Origins: normalizing remote URLs, and their encodings
│   │   ├── swhid/       SWHIDs, as value objects
│   │   │   ├── swhid.ts       Swhid: parsing, checking, canonical text; the scheme's version
│   │   │   ├── qualifiers.ts  Qualifiers: the context of a SWHID, filtered and checked
│   │   │   └── lineRange.ts   LineRange: the lines qualifier
│   │   ├── git.ts       Running Git, and the temporary index copies
│   │   ├── archive/     The Software Heritage client (class Swh): what the archive holds, with Git
│   │   │   ├── index.ts       The package's exports
│   │   │   ├── swh.ts         Swh itself: builds its parts; scans, refresh, why a file is not archived
│   │   │   ├── workingTree.ts WorkingTree: SWHIDs of files and directories, anchored on archived commits
│   │   │   ├── origins.ts     Origins: origins, visits, save requests
│   │   │   ├── holdings.ts    Holdings: which SWHIDs the archive holds
│   │   │   ├── archiveApi.ts  ArchiveApi: what the client asks the archive (an interface)
│   │   │   ├── adapters/      Implementations of ArchiveApi
│   │   │   │   ├── httpArchiveApi.ts  Over the archive's Web API: requests, token, rate limit
│   │   │   │   ├── http.ts            HTTP requests, through fetch
│   │   │   │   └── json.ts            The archive's JSON answers, checked and mapped
│   │   │   ├── memo.ts        Memo: the archive's answers, remembered as long as they are trusted
│   │   │   └── types.ts       The data it answers with, and what it needs from its host
│   │   ├── citation/    Citations
│   │   │   ├── bibtex.ts      BibtexEntry: the BibTeX format, its escaping
│   │   │   ├── citation.ts    Citation: the archive's entry, or a minimal one
│   │   │   └── citer.ts       Citer: cites files and repositories, with the archive and Git
│   │   └── scan.ts      The scan as a tree, and its figures (pure functions)
│   └── ui/              VS Code's side: everything here imports `vscode`
│       ├── index.ts     The folder's public API, re-exported
│       ├── apiToken.ts  The API token: the environment's, else the stored one
│       ├── commands/    The commands, by group (class Commands)
│       │   ├── index.ts     The folder's exports
│       │   ├── commands.ts  Commands: builds the groups on one context
│       │   ├── context.ts   What every group shares: the target, the repository, its origin
│       │   ├── archive.ts   Status, visits, save requests, refresh
│       │   ├── swhid.ts     SWHIDs, permalinks, Markdown links
│       │   ├── citation.ts  BibTeX citations
│       │   ├── misc.ts      Opening a SWHID, the Quick Pick menu
│       │   └── register.ts  Registering the commands, and reporting their errors
│       ├── menu.ts      The menu's entries, shared by the Menu view and the Quick Pick menu
│       ├── menuView.ts  The Menu view
│       ├── scanView.ts  The Scan view
│       ├── statusBar.ts The archival status in the status bar
│       ├── reports.ts   The read-only reports (visits, citations) and the SWHID links
│       └── helpers.ts   Shared helpers: settings, messages, progress, the current file or folder
└── test/
    ├── swhid.test.ts        Unit tests: SWHIDs, origins, citations, the scan model
    ├── citation.test.ts     Unit tests: citing files and repositories, on a stub client
    ├── json.test.ts         Unit tests: the archive's JSON answers, mapped
    ├── memo.test.ts         Unit tests: the memo's policies and stale answers, with a fake clock
    ├── fakeArchive.test.ts  Unit tests: the client on a fake ArchiveApi, without HTTP
    ├── repository.test.ts   Unit tests: the client on a temporary repository, and its HTTP adapter (batches, citations, rate limit), fetch mocked
    └── smoke/               Smoke test in a real VS Code
        ├── run.ts           Downloads VS Code and opens it on a temporary repository
        └── suite.ts         Runs the commands in the extension host
```

`npm test` runs only the `*.test.ts` files, with Node: the smoke test needs VS Code's extension host.

### Architecture

#### Two halves: `core/` and `ui/`

The code is split by whether it needs VS Code:

- [src/core/](src/core/) is plain TypeScript, with no `vscode` import. It holds everything that works without VS Code, so the unit tests can run it with Node alone.
- [src/ui/](src/ui/) and [extension.ts](src/extension.ts) are the only modules that import `vscode`. They hold the parts that need it: commands, views, the status bar.

When you add code, put it in `core/` unless it needs VS Code.

#### Packages

Within `core/`, each concern is a package: a folder with its own `index.ts` (`shared/`, `swhid/`, `archive/`, `citation/`), or a single file (`origin.ts`, `git.ts`, `scan.ts`).

The packages depend on each other in one direction only, so there is no cycle between them:

```text
shared ← origin ← swhid ← git ← archive ← citation, scan
```

A package may import those to its left, never one to its right.

#### Imports

- **Within a folder**, modules import each other with relative paths.
- **Between folders**, they import through an alias, never a relative path that leaves their folder:
  - `#core` and `#ui` for the whole of each: `import { Swh } from '#core'`;
  - `#core/<package>` between the core's packages: `import { Swhid } from '#core/swhid'`;
  - `#ui/<module>` or `#ui/commands` within the UI: `import { info } from '#ui/helpers'`.
- **A folder's `index.ts` holds only its exports**: the code lives in the other files.

The aliases are Node's [subpath imports](https://nodejs.org/api/packages.html#subpath-imports), defined in the `imports` field of [package.json](package.json). Each one points TypeScript at the sources (`types`) and Node at the compiled files in `out/` (`default`), which is why [tsconfig.json](tsconfig.json) uses `"module": "node16"`. Keep in mind that:

- a pattern such as `#core/*` maps a single file only: `#core/origin` is `origin.ts`;
- a folder needs an entry of its own, as Node does not look for its `index.ts`: add one with each new folder;
- if `outDir` or the folders change, update both paths of each entry.

#### The client and the archive

[`Swh`](src/core/archive/swh.ts) is the Software Heritage client. It is made of parts, each a small service that `Swh` builds and gives what it needs:

```text
Holdings ← Origins ← WorkingTree
```

- `Holdings`: which SWHIDs the archive holds.
- `Origins`: origins, their visits, and save requests.
- `WorkingTree`: the SWHIDs of files and directories.

Each part uses those to its left, through their public methods only. `Swh` keeps the methods callers use, most of them delegated to a part.

`Swh` never talks HTTP itself. It follows the "ports and adapters" (hexagonal) architecture:

- **The port**, [`ArchiveApi`](src/core/archive/archiveApi.ts), is what the client asks the archive, in its own terms: SWHIDs, origins, visits, save requests, citations.
- **The adapters**, in `adapters/`, implement it. [`HttpArchiveApi`](src/core/archive/adapters/httpArchiveApi.ts) does so over the archive's Web API, and [extension.ts](src/extension.ts) passes it to `Swh`. The tests pass a fake archive instead.

To reach the archive another way, implement `ArchiveApi`: nothing else changes.

#### Value objects

SWHIDs and citations are values, not strings.

[`Swhid`](src/core/swhid/swhid.ts):

- **Always valid.** `Swhid.of(type, hash)` and `Swhid.parse(text)` are the only ways to make one, and both check it.
- **Immutable.** `qualify({ origin, visit, anchor, path, lines })` gives a new one.
- **Qualified by values too.**
  - [`Qualifiers`](src/core/swhid/qualifiers.ts): `Qualifiers.of` keeps only those its context allows (an origin and its visit only when public, a path only with an anchor), and `Qualifiers.parse` checks each one.
  - [`LineRange`](src/core/swhid/lineRange.ts), the `lines`: checked when made, a range that starts at line 1 or later and ends at its first line or after.
- **Compared by value.** Two instances of the same SWHID are different objects: compare them with `equals`, and key maps by `toString()`, the canonical text.
- **Text only at the edges.** The `ArchiveApi` port takes their text, as the Web API does, and so do the clipboard and the URLs. A SWHID the user typed, or found in a document, is passed on as written.

Citations are split the same way:

- [`BibtexEntry`](src/core/citation/bibtex.ts) is the BibTeX format alone. It escapes each field as its kind needs, so that every entry is valid BibTeX: LaTeX's special characters in text such as the title, only the braces in the verbatim `url` and `swhid`.
- [`Citation`](src/core/citation/citation.ts) is what a citation command gives: the archive's own entry, or a minimal one made as the archive would make it, and where it comes from.
- [`Citer`](src/core/citation/citer.ts) is the service that gathers what a citation needs, from the archive and from Git.

#### Commands

The commands are grouped by concern in [src/ui/commands/](src/ui/commands/), one class per group, all built by `Commands`:

- the groups share one `CommandContext`: the client, the reports, the `Citer`, and how to find the target, its repository and its origin;
- a group gets the others it needs through its constructor: the citations use the SWHID commands, which use the archive commands to send save requests.

## License

By contributing, you agree that your contributions are licensed under the project's license, [GPL-3.0-or-later](LICENSE).
