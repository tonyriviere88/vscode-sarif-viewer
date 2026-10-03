// Smoke-tests the artifact that actually ships: the minified production bundle
// that vsce put in the .vsix. `npm run verify` covers the sources; this catches
// what only breaks after bundling and minification.
//
//   node scripts/verifyPackage.mjs

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(root, 'dist', 'extension.js');
const stubPath = path.join(root, 'scripts', 'vscodeStub.js');

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};
const checkAsync = async (name, fn) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsixName = `${manifest.name}-${manifest.version}.vsix`;

console.log('the packaged artifact');

check('the .vsix exists and is not empty', () => {
  const vsix = path.join(root, vsixName);
  assert.ok(existsSync(vsix), `${vsixName} not found — run \`npm run vsix\` first`);
  const { size } = statSync(vsix);
  assert.ok(size > 5_000, `${vsixName} is suspiciously small (${size} bytes)`);
});

check('only one .vsix is lying around', () => {
  const all = readdirSync(root).filter((entry) => entry.endsWith('.vsix'));
  assert.deepEqual(all, [vsixName], `stale packages would be ambiguous: ${all.join(', ')}`);
});

check('the packaged bundle is a release build, not the dev one', () => {
  assert.ok(existsSync(bundlePath), 'dist/extension.js is missing');
  const code = readFileSync(bundlePath, 'utf8');
  // The dev build is the failure mode to catch: it ends with a sourceMappingURL
  // comment and emits a .map beside itself. Line count is no signal — the
  // webview's CSS template literal keeps its newlines through minification.
  assert.ok(!code.includes('sourceMappingURL'), 'a release build ships no source map link');
  assert.ok(!existsSync(`${bundlePath}.map`), 'dist/extension.js.map means --production was skipped');
  assert.ok(code.length > 10_000, `bundle looks truncated (${code.length} bytes)`);
  assert.equal(manifest.dependencies, undefined, 'everything must be bundled');
});

check('sources and samples stay out of the package', () => {
  const ignore = readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  for (const pattern of ['src/**', 'scripts/**', 'samples/**', 'node_modules/**', '**/*.map']) {
    assert.ok(ignore.includes(pattern), `.vscodeignore should exclude ${pattern}`);
  }
});

console.log('the minified bundle still works');

// Make `require('vscode')` inside the bundle resolve to the fake editor host.
const require = createRequire(import.meta.url);
const load = Module._load;
Module._load = (request, parent, isMain) =>
  request === 'vscode' ? require(stubPath) : load(request, parent, isMain);

const vscode = require(stubPath);
const extension = require(bundlePath);
const { __test } = vscode;

const state = {
  data: {},
  get: (key, fallback) => (key in state.data ? state.data[key] : fallback),
  update: async (key, value) => {
    state.data[key] = value;
  },
  keys: () => Object.keys(state.data),
};

await checkAsync('it activates and registers its commands', async () => {
  assert.equal(typeof extension.activate, 'function');
  assert.equal(typeof extension.deactivate, 'function');
  __test.setWorkspaceFolders([root]);
  extension.activate({
    subscriptions: [],
    extensionUri: vscode.Uri.file(root),
    workspaceState: state,
    globalState: { ...state, data: {} },
  });
  for (const command of manifest.contributes.commands) {
    assert.ok(__test.commands.has(command.command), `${command.command} not registered`);
  }
  assert.equal(__test.treeViews.length, 1);
});

await checkAsync('it loads a log and highlights a result end to end', async () => {
  const samplePath = path.join(root, 'samples', 'demo.sarif');
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(samplePath));
  assert.deepEqual(__test.messages.error, []);

  const view = __test.treeViews[0];
  const provider = view.options.treeDataProvider;
  const group = provider.getChildren().find((node) => node.label === 'extension.ts');
  assert.ok(group, 'the sample should group by file');

  const [result] = provider.getChildren(group);
  const item = await provider.getTreeItem(result);
  assert.equal(item.description, '(DL0002) [Ln 20, Col 3]');

  await __test.execute('sarifViewer.openResult', result);
  const editor = __test.editors.find((candidate) => candidate.document.fileName.endsWith('extension.ts'));
  const ranges = [...editor.decorations.values()].flat();
  assert.ok(ranges.length > 0, 'the minified build must still paint decorations');
  assert.equal(editor.selection.start.line, 19);

  assert.deepEqual(
    state.get('sarifViewer.openLogs'),
    [vscode.Uri.file(samplePath).toString()],
    'the session is remembered for the next reload',
  );
});

await checkAsync('opening a log in an editor loads it in the minified build', async () => {
  await __test.execute('sarifViewer.closeAllLogs');
  __test.executedCommands = [];
  __test.openDocument(vscode.Uri.file(path.join(root, 'samples', 'demo.sarif')));

  const started = Date.now();
  while (__test.treeViews[0].badge === undefined) {
    if (Date.now() - started > 3000) {
      throw new Error('timed out waiting for the opened log to load');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(__test.treeViews[0].badge.value > 0, 'the log must reach the tree');
  assert.ok(
    !__test.executedCommands.some((entry) => entry.command === 'vscode.openWith'),
    'and the editor must be left alone',
  );
});

console.log(`\n${checks} checks passed — ${vsixName} is good to install`);
