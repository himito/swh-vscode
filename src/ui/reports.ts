/**
 * Read-only report documents, such as the visits list and citations, and
 * clickable links on the SWHIDs found in documents.
 *
 * @remarks
 * Reports are virtual documents of the {@link REPORT_SCHEME} scheme: they
 * live in memory, open beside the editor, and never ask to be saved. Their
 * name's extension (`.txt`, `.bib`) lets VS Code pick a language for them.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { config } from './helpers';
import { findSwhids } from '#core';

/** The URI scheme of the report documents. */
export const REPORT_SCHEME = 'swh-report';

/**
 * Provides the content of the report documents, and shows them.
 *
 * @remarks
 * Registered for {@link REPORT_SCHEME}. Showing a report again with the same
 * name replaces its content in place.
 */
export class Reports implements vscode.TextDocumentContentProvider, vscode.Disposable {
  /** The content of each report, by URI path. */
  private contents = new Map<string, string>();
  /** Fires when a report's content changes. */
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  /** Tells VS Code that a report's content changed, so open editors update. */
  readonly onDidChange = this.emitter.event;

  /**
   * Gives VS Code the content of a report.
   *
   * @param uri - The report's URI.
   * @returns Its content, or an empty string for an unknown report.
   */
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }

  /**
   * Shows a report beside the active editor, without taking the focus.
   *
   * @param name - The report's name, e.g. `"swh cite.bib"`; its extension sets
   * the language.
   * @param text - The report's content.
   */
  async show(name: string, text: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: REPORT_SCHEME, path: '/' + name });
    this.contents.set(uri.path, text);
    this.emitter.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
  }

  /** Forgets the reports and stops telling VS Code of changes. */
  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

/**
 * A command URI that opens a SWHID in the archive.
 *
 * @remarks
 * Used as the target of document links and Markdown tooltip links. Going
 * through the `swh.openSwhid` command keeps the SWHID's percent-encoded
 * qualifiers intact, which an `https:` URI would not.
 *
 * The query is built with `Uri.from`, not `Uri.parse`: VS Code's command
 * opener runs `decodeURIComponent` on the URI's already decoded query, so a
 * query that `Uri.parse` decodes once would be decoded twice, turning e.g.
 * `path=/a%3Bb` into `path=/a;b`.
 *
 * @param swhid - The SWHID, with or without qualifiers.
 * @returns A `command:swh.openSwhid?…` URI.
 */
export const openSwhidUri = (swhid: string) =>
  vscode.Uri.from({ scheme: 'command', path: 'swh.openSwhid', query: encodeURIComponent(JSON.stringify([swhid])) });

/**
 * Makes the SWHIDs in documents clickable links that open them in the archive.
 *
 * @remarks
 * Does nothing when the `swh.documentLinks.enabled` setting is off.
 */
export class SwhidLinks implements vscode.DocumentLinkProvider {
  /**
   * Finds the SWHIDs of a document and links each to the archive.
   *
   * @param doc - The document to scan.
   * @returns One link per SWHID, qualifiers included.
   */
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
