/**
 * The smoke test suite, run inside VS Code's extension host by `run.ts`.
 *
 * @remarks
 * It runs the extension's commands for real, on a repository without a
 * remote, where nothing needs the archive, and checks what they copy to the
 * clipboard and show. Run it with `npm run smoke`.
 *
 * @packageDocumentation
 */

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Run the suite; the test fails when this rejects.
 *
 * @remarks
 * `@vscode/test-electron` calls it once the workspace, the temporary
 * repository, is open.
 */
export async function run() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'swh-vscode')!;
  await ext.activate();
  // every command the manifest declares is registered
  const all = await vscode.commands.getCommands(true);
  for (const c of ext.packageJSON.contributes.commands) assert.ok(all.includes(c.command), c.command);

  // the side bar's views
  await vscode.commands.executeCommand('swh.actions.focus');
  await vscode.commands.executeCommand('swh.scan.focus');

  const repo = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const file = path.join(repo, 'a.txt');
  const hash = execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim();
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));

  await vscode.commands.executeCommand('swh.swhidCopy');
  assert.equal(await vscode.env.clipboard.readText(), `swh:1:cnt:${hash}`);

  // the selection's lines
  editor.selection = new vscode.Selection(1, 0, 3, 0);
  await vscode.commands.executeCommand('swh.swhidCopy');
  assert.equal(await vscode.env.clipboard.readText(), `swh:1:cnt:${hash};lines=2-3`);
  await vscode.commands.executeCommand('swh.swhidCopyLink', { bare: true });
  assert.equal(await vscode.env.clipboard.readText(), `https://archive.softwareheritage.org/swh:1:cnt:${hash};lines=2-3`);
  await vscode.commands.executeCommand('swh.swhidCopyMarkdown');
  assert.equal(
    await vscode.env.clipboard.readText(),
    `[a.txt, lines 2-3](https://archive.softwareheritage.org/swh:1:cnt:${hash};lines=2-3)`,
  );

  // the directory, from the explorer's menu
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
  await vscode.commands.executeCommand('swh.swhidCopy', vscode.Uri.file(repo));
  assert.equal(await vscode.env.clipboard.readText(), `swh:1:dir:${tree}`);

  // a minimal citation, shown in a report
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.window.showTextDocument(editor.document);
  await vscode.commands.executeCommand('swh.cite');
  const cite = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'swh-report');
  assert.ok(cite, 'no citation report');
  assert.match(cite!.getText(), new RegExp(`^@codefragment\\{swh-cnt-${hash.slice(0, 7)},`));

  // links on SWHIDs
  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', cite!.uri);
  assert.ok(links.some((l) => l.target?.scheme === 'command'), 'no SWHID link');
  console.log('smoke: all good');
}
