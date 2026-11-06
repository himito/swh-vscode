// Software Heritage for VS Code.

import * as vscode from 'vscode';
import { Swh } from './backend';
import { CommandArg, Commands } from './commands';
import { Git } from './git';
import { MenuView } from './menuView';
import { REPORT_SCHEME, Reports, SwhidLinks } from './reports';
import { ScanView } from './scanView';
import { StatusBar } from './statusBar';
import { command, config, info } from './ui';
import type { ScanItem } from './scanModel';

const TOKEN_KEY = 'swh.apiToken';

export function activate(context: vscode.ExtensionContext) {
  const tokenOrUndefined = (t: string | undefined) => (t && t.trim() ? t.trim() : undefined);
  let stored: Promise<string | undefined> | undefined;
  const token = () =>
    Promise.resolve(tokenOrUndefined(process.env.SWH_API_TOKEN)).then(
      (env) => env ?? (stored ??= Promise.resolve(context.secrets.get(TOKEN_KEY)).then(tokenOrUndefined)),
    );
  context.secrets.onDidChange((e) => {
    if (e.key === TOKEN_KEY) stored = undefined;
  });

  let statusBar: StatusBar | undefined;
  const swh = new Swh({
    archiveUrl: () => config().get<string>('archiveUrl', 'https://archive.softwareheritage.org'),
    daemonUrl: () => config().get<string>('daemonUrl', 'http://127.0.0.1:8642'),
    token,
    warn: (m) => void vscode.window.showWarningMessage(m),
    onRateLimit: () => statusBar?.render(),
    git: new Git(() => config().get<string>('gitPath', 'git') || 'git'),
  });

  const reports = new Reports();
  statusBar = new StatusBar(swh);
  const commands = new Commands(swh, reports, () => statusBar?.forget());
  const scan = new ScanView(swh, () => commands.repoRoot());

  const reg = (id: string, fn: (...args: any[]) => Promise<unknown>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, command(fn)));

  reg('swh.menu', () => commands.menu());
  reg('swh.status', () => commands.status());
  reg('swh.statusOther', () => commands.status(true));
  reg('swh.visits', () => commands.visits());
  reg('swh.visitsOther', () => commands.visits(true));
  reg('swh.save', () => commands.save());
  reg('swh.saveOther', () => commands.save(true));
  reg('swh.swhidCopy', (arg?: CommandArg) => commands.swhidCopy('swhid', arg));
  reg('swh.swhidCopyArchived', (arg?: CommandArg) => commands.swhidCopy('archived', arg));
  reg('swh.swhidCopyLink', (arg?: CommandArg) => commands.swhidCopy('link', arg));
  reg('swh.swhidCopyMarkdown', (arg?: CommandArg) => commands.swhidCopy('markdown', arg));
  reg('swh.swhidOpen', (arg?: CommandArg) => commands.swhidCopy('open', arg));
  reg('swh.cite', (arg?: CommandArg) => commands.cite(false, arg));
  reg('swh.citeOther', () => commands.cite(true));
  reg('swh.refresh', () => commands.refresh());
  reg('swh.openSwhid', (swhid?: string) => commands.openSwhid(swhid));
  reg('swh.statusBarCopy', async () => {
    const current = statusBar?.current;
    if (!current) return;
    await commands.swhidCopy('swhid', current.dir ? { path: current.path } : undefined);
  });
  reg('swh.setToken', async () => {
    const value = await vscode.window.showInputBox({
      prompt: 'Software Heritage API token, from your archive account (https://archive.softwareheritage.org/oidc/profile/)',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    await context.secrets.store(TOKEN_KEY, value.trim());
    stored = undefined;
    info(
      process.env.SWH_API_TOKEN
        ? 'Token stored; SWH_API_TOKEN, set in the environment, still takes precedence'
        : 'Software Heritage API token stored',
    );
  });
  reg('swh.clearToken', async () => {
    await context.secrets.delete(TOKEN_KEY);
    stored = undefined;
    info('Software Heritage API token cleared');
  });

  reg('swh.scan', () => scan.run());
  reg('swh.scan.openInArchive', (i?: ScanItem) => scan.openInArchive(i));
  reg('swh.scan.copySwhid', (i?: ScanItem) => scan.copySwhid(i));
  reg('swh.scan.openFile', (i?: ScanItem) => scan.openFile(i));

  context.subscriptions.push(
    statusBar,
    scan,
    new MenuView(),
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reports),
    vscode.languages.registerDocumentLinkProvider([{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: REPORT_SCHEME }], new SwhidLinks()),
  );

  void statusBar.update();
}

export function deactivate() {
  // everything is in the context's subscriptions
}
