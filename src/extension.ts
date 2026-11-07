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
  command,
  CommandArg,
  Commands,
  config,
  envToken,
  info,
  MenuView,
  REPORT_SCHEME,
  Reports,
  ScanView,
  StatusBar,
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
  const scan = new ScanView(swh, () => commands.repoRoot());

  // registers a command whose errors are reported to the user
  const reg = (id: string, fn: (...args: any[]) => Promise<unknown>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, command(fn)));

  // the archive: status, visits, save
  reg('swh.menu', () => commands.menu());
  reg('swh.status', () => commands.status());
  reg('swh.statusOther', () => commands.status(true));
  reg('swh.visits', () => commands.visits());
  reg('swh.visitsOther', () => commands.visits(true));
  reg('swh.save', () => commands.save());
  reg('swh.saveOther', () => commands.save(true));
  // SWHIDs and citations: a Uri from a context menu, or options from a keybinding or the menu
  reg('swh.swhidCopy', (arg?: CommandArg) => commands.swhidCopy('swhid', arg));
  reg('swh.swhidCopyArchived', (arg?: CommandArg) => commands.swhidCopy('archived', arg));
  reg('swh.swhidCopyLink', (arg?: CommandArg) => commands.swhidCopy('link', arg));
  reg('swh.swhidCopyMarkdown', (arg?: CommandArg) => commands.swhidCopy('markdown', arg));
  reg('swh.swhidOpen', (arg?: CommandArg) => commands.swhidCopy('open', arg));
  reg('swh.cite', (arg?: CommandArg) => commands.cite(false, arg));
  reg('swh.citeOther', () => commands.cite(true));
  reg('swh.refresh', () => commands.refresh());
  reg('swh.openSwhid', (swhid?: string) => commands.openSwhid(swhid));
  // a click on the status bar item: the SWHID of what it shows
  reg('swh.statusBarCopy', async () => {
    const current = statusBar?.current;
    if (!current) return;
    await commands.swhidCopy('swhid', current.dir ? { path: current.path } : undefined);
  });
  // the API token, in VS Code's secret storage
  reg('swh.setToken', async () => {
    const value = await vscode.window.showInputBox({
      prompt: 'Software Heritage API token, from your archive account (https://archive.softwareheritage.org/oidc/profile/)',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (!(await apiToken.store(value))) {
      info('Software Heritage API token cleared: the value was blank');
      return;
    }
    info(
      envToken()
        ? 'Token stored; SWH_API_TOKEN, set in the environment, still takes precedence'
        : 'Software Heritage API token stored',
    );
  });
  reg('swh.clearToken', async () => {
    await apiToken.clear();
    info('Software Heritage API token cleared');
  });

  // the Scan view and the actions on its items
  reg('swh.scan', () => scan.run());
  reg('swh.scan.openInArchive', (i?: ScanItem) => scan.openInArchive(i));
  reg('swh.scan.copySwhid', (i?: ScanItem) => scan.copySwhid(i));
  reg('swh.scan.openFile', (i?: ScanItem) => scan.openFile(i));

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
 * Deactivates the extension.
 *
 * @remarks
 * Nothing to do: VS Code disposes of everything in the context's
 * subscriptions.
 */
export function deactivate() {
  // everything is in the context's subscriptions
}
