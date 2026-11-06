// Read-only report documents (visits, citations) and links on SWHIDs.

import * as vscode from 'vscode';
import { config } from './ui';
import { findSwhids } from './swhid';

export const REPORT_SCHEME = 'swh-report';

export class Reports implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }

  /** Show TEXT in the report NAME, e.g. "swh cite.bib", beside the editor. */
  async show(name: string, text: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: REPORT_SCHEME, path: '/' + name });
    this.contents.set(uri.path, text);
    this.emitter.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
  }
}

/** Command URI that opens SWHID in the archive. */
export const openSwhidUri = (swhid: string) =>
  vscode.Uri.parse(`command:swh.openSwhid?${encodeURIComponent(JSON.stringify([swhid]))}`);

/** Makes the SWHIDs of documents links to the archive. */
export class SwhidLinks implements vscode.DocumentLinkProvider {
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    if (!config().get<boolean>('documentLinks.enabled', true)) return [];
    // a cheap test first: most documents hold no SWHID
    const text = doc.getText();
    if (!text.includes('swh:1:')) return [];
    return findSwhids(text).map(([start, swhid]) => {
      const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + swhid.length));
      const link = new vscode.DocumentLink(range, openSwhidUri(swhid));
      link.tooltip = 'Open in the Software Heritage archive';
      return link;
    });
  }
}
