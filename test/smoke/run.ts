/**
 * Launches the smoke test: VS Code with the extension, on a fresh repository.
 *
 * @remarks
 * `@vscode/test-electron` downloads VS Code once into `.vscode-test/`, then
 * starts it with this project as the extension under development, and runs
 * `suite.ts` in its extension host. Run it with `npm run smoke`.
 *
 * @packageDocumentation
 */

import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Create the repository, and run the smoke test suite in VS Code.
 *
 * @remarks
 * The repository holds one committed file, `a.txt`, and no remote, so no
 * command needs the archive. VS Code opens it with every other extension
 * disabled.
 */
async function main() {
  // set in VS Code's own terminal: Electron would run as plain Node
  delete process.env.ELECTRON_RUN_AS_NODE;
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swh-smoke-')));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  git('init', '-q');
  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', '.');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
  await runTests({
    // out/test/smoke/ -> the project's root
    extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
    extensionTestsPath: path.resolve(__dirname, 'suite'),
    launchArgs: [repo, '--disable-extensions'],
  });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
