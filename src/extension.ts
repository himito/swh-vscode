/**
 * The extension's entry point: creates the backend, the views and the status
 * bar item, and registers every command.
 *
 * @remarks
 * VS Code calls {@link activate} once, after startup (see `activationEvents`
 * in `package.json`). Every command declared in `package.json` must be
 * registered here, and every view and provider created here. Everything
 * created is added to the
 * extension context's subscriptions, so VS Code disposes of it on
 * deactivation.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { Git, type ScanItem, Swh } from './core';
import {
  ApiToken,
  CommandArg,
  Commands,
  config,
  envToken,
  info,
  MenuView,
  registerCommands,
  REPORT_SCHEME,
  Reports,
  ScanView,
  StatusBar,
  type SwhidCommands,
  SwhidLinks,
} from './ui';
import type { Maybe } from './core/types';

/**
 * Activates the extension.
 *
 * @remarks
 * The API token comes from {@link ApiToken}: the `SWH_API_TOKEN` environment
 * variable, else VS Code's secret storage (see the `swh.setToken` command).
 * Settings are read on each use, so changing them needs no reload.
 *
 * @param context - The extension context, which owns everything registered.
 */
export function activate(context: vscode.ExtensionContext) {
  // the API token, in VS Code's secret storage
  const apiToken = new ApiToken(context.secrets);
  context.subscriptions.push(apiToken);

  // the backend, configured by the settings
  let statusBar: Maybe<StatusBar>;
  const swh = new Swh({
    archiveUrl: () => config().get<string>('archiveUrl', 'https://archive.softwareheritage.org'),
    token: () => apiToken.get(),
    onRateLimit: () => statusBar?.render(),
    git: new Git(() => config().get<string>('gitPath', 'git') || 'git'),
  });

  const reports = new Reports();
  statusBar = new StatusBar(swh);
  const commands = new Commands(swh, reports, () => statusBar?.forget());
  const scan = new ScanView(swh, () => commands.context.repoRoot());

  registerCommands(context, {
    // the archive: status, visits, save
    'swh.menu': () => commands.misc.menu(),
    'swh.status': () => commands.archive.status(),
    'swh.statusOther': () => commands.archive.status(true),
    'swh.visits': () => commands.archive.visits(),
    'swh.visitsOther': () => commands.archive.visits(true),
    'swh.save': () => commands.archive.save(),
    'swh.saveOther': () => commands.archive.save(true),
    'swh.refresh': () => commands.archive.refresh(),

    // SWHIDs and citations: a Uri from a context menu, or options from a keybinding or the menu
    'swh.swhidCopy': (arg?: CommandArg) => commands.swhid.swhidCopy('swhid', arg),
    'swh.swhidCopyArchived': (arg?: CommandArg) => commands.swhid.swhidCopy('archived', arg),
    'swh.swhidCopyLink': (arg?: CommandArg) => commands.swhid.swhidCopy('link', arg),
    'swh.swhidCopyMarkdown': (arg?: CommandArg) => commands.swhid.swhidCopy('markdown', arg),
    'swh.swhidOpen': (arg?: CommandArg) => commands.swhid.swhidCopy('open', arg),
    'swh.cite': (arg?: CommandArg) => commands.citation.cite(false, arg),
    'swh.citeOther': () => commands.citation.cite(true),
    'swh.openSwhid': (swhid?: string) => commands.misc.openSwhid(swhid),
    'swh.statusBarCopy': () => copyStatusBarSwhid(commands.swhid, statusBar),

    // the API token
    'swh.setToken': () => setToken(apiToken),
    'swh.clearToken': () => clearToken(apiToken),

    // the Scan view and the actions on its items
    'swh.scan': () => scan.run(),
    'swh.scan.openInArchive': (item?: ScanItem) => scan.openInArchive(item),
    'swh.scan.copySwhid': (item?: ScanItem) => scan.copySwhid(item),
    'swh.scan.openFile': (item?: ScanItem) => scan.openFile(item),
  });

  context.subscriptions.push(
    statusBar,
    scan,
    reports,
    new MenuView(),
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reports),
    vscode.languages.registerDocumentLinkProvider([{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: REPORT_SCHEME }], new SwhidLinks()),
  );

  void statusBar.update();
}

/**
 * Copies the SWHID of what the status bar item shows, when it is clicked.
 *
 * @remarks
 * A file is the active editor's, so it is copied as the Command Palette
 * would, with the selected lines. A folder is shown when no file editor is
 * open, so it must be given by its path.
 *
 * @param swhid - The SWHID commands, which copy the SWHID.
 * @param statusBar - The status bar item; nothing is copied when it shows nothing.
 */
async function copyStatusBarSwhid(swhid: SwhidCommands, statusBar: Maybe<StatusBar>): Promise<void> {
  const shown = statusBar?.current;
  if (!shown) return;

  const target: CommandArg = shown.dir ? { path: shown.path } : undefined;
  await swhid.swhidCopy('swhid', target);
}

/**
 * Asks the user for an API token and stores it; a blank one clears it.
 *
 * @param apiToken - Where the token is stored.
 */
async function setToken(apiToken: ApiToken): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: 'Software Heritage API token, from your archive account (https://archive.softwareheritage.org/oidc/profile/)',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return;

  // store the token, or clear it if blank
  if (!(await apiToken.store(value))) {
    info('Software Heritage API token cleared: the value was blank');
    return;
  }

  // if the token is set in the environment, it takes precedence, so warn the user
  info(
    envToken()
      ? 'Token stored; SWH_API_TOKEN, set in the environment, still takes precedence'
      : 'Software Heritage API token stored',
  );
}

/**
 * Removes the stored API token.
 *
 * @param apiToken - Where the token is stored.
 */
async function clearToken(apiToken: ApiToken): Promise<void> {
  await apiToken.clear();
  info('Software Heritage API token cleared');
}

/**
 * Deactivates the extension.
 *
 * @remarks
 * Nothing to do: VS Code disposes of everything in the context's
 * subscriptions.
 */
export function deactivate() {
  // everything is in the context's subscriptions
}
