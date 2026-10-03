// Exercises the parts of the extension that do not need a running editor:
// SARIF parsing and the SARIF-region -> VS Code-range conversion.
//
//   node scripts/verify.mjs
//
// The `vscode` module is aliased to scripts/vscodeStub.js at bundle time.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out', 'verify');
const outFile = path.join(outDir, 'bundle.cjs');

mkdirSync(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'verifyEntry.ts')],
  bundle: true,
  outfile: outFile,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'warning',
  alias: { vscode: path.join(root, 'scripts', 'vscodeStub.js') },
});

const require = createRequire(import.meta.url);
const {
  activate,
  parseSarifLog,
  regionToRange,
  formatPosition,
  countLevels,
  findCodeSpans,
  codeFragments,
  languageIdFor,
  messageToMarkdown,
  vscode,
} = require(outFile);

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
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
const waitFor = async (predicate, message, timeoutMs = 3000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const samplePath = path.join(root, 'samples', 'demo.sarif');
const log = parseSarifLog(vscode.Uri.file(samplePath), readFileSync(samplePath, 'utf8'));

console.log('parsing samples/demo.sarif');

check('reads every result of the run', () => {
  assert.equal(log.runs.length, 1);
  assert.equal(log.results.length, 7);
  assert.equal(log.runs[0].toolName, 'DemoLinter');
  assert.equal(log.runs[0].toolVersion, '1.4.2');
});

check('level falls back to the rule default configuration', () => {
  const unused = log.results.find((r) => r.message.startsWith("Variable 'syncView'"));
  assert.equal(unused.level, 'warning', 'DL0001 defaults to warning');
  const explicit = log.results.find((r) => r.ruleId === 'DL0004');
  assert.equal(explicit.level, 'error');
});

check('resolves messageStrings ids and substitutes arguments', () => {
  const note = log.results.find((r) => r.ruleId === 'DL0003');
  assert.equal(note.message, "Prefer 'as const' over an explicit type annotation on LEVEL_ORDER.");
  assert.equal(note.level, 'note');
});

check('carries rule metadata onto the result', () => {
  const nullDeref = log.results.find((r) => r.ruleId === 'DL0002' && r.level === 'error');
  assert.equal(nullDeref.ruleName, 'NullDereference');
  assert.equal(nullDeref.helpUri, 'https://example.com/demolinter/rules/DL0002');
  assert.equal(nullDeref.ruleShortDescription, 'A value that may be null is dereferenced.');
});

check('keeps related locations and their messages', () => {
  const nullDeref = log.results.find((r) => r.ruleId === 'DL0002' && r.level === 'error');
  assert.equal(nullDeref.relatedLocations.length, 1);
  assert.equal(nullDeref.relatedLocations[0].message, 'the value is created here');
  assert.equal(nullDeref.relatedLocations[0].region.startLine, 16);
});

check('flattens code flow steps in execution order', () => {
  const tainted = log.results.find((r) => r.ruleId === 'DL0004');
  assert.equal(tainted.codeFlowSteps.length, 3);
  assert.deepEqual(
    tainted.codeFlowSteps.map((step) => step.step),
    [1, 2, 3],
  );
  assert.equal(tainted.codeFlowSteps[0].label, 'the log is parsed from untrusted JSON');
  assert.match(tainted.codeFlowSteps[2].uri, /pathResolver\.ts$/);
});

check('detects suppressions', () => {
  const suppressed = log.results.filter((r) => r.suppressed);
  assert.equal(suppressed.length, 1);
  assert.match(suppressed[0].message, /suppressed/);
});

check('keeps the uriBaseId for path resolution', () => {
  assert.equal(log.results[0].primaryLocation.uriBaseId, '%SRCROOT%');
  assert.equal(log.runs[0].originalUriBaseIds['%SRCROOT%'].uri, 'file:///build/agent/work/1/s/');
});

check('counts levels for the tree badges', () => {
  const counts = countLevels(log.results);
  assert.equal(counts.error, 2);
  assert.equal(counts.warning, 3);
  assert.equal(counts.note, 2);
});

console.log('region conversion');

check('1-based inclusive start becomes 0-based', () => {
  const { range } = regionToRange({ startLine: 20, startColumn: 3, endColumn: 30 });
  assert.equal(range.start.line, 19);
  assert.equal(range.start.character, 2);
  assert.equal(range.end.line, 19);
  assert.equal(range.end.character, 29, 'endColumn is exclusive in SARIF');
});

check('a line-only region is a whole-line highlight', () => {
  const { range, wholeLine } = regionToRange({ startLine: 24 });
  assert.equal(wholeLine, true);
  assert.equal(range.start.line, 23);
  assert.equal(range.start.character, 0);
});

check('multi-line regions span from start to end', () => {
  const { range, wholeLine } = regionToRange({
    startLine: 71,
    startColumn: 3,
    endLine: 79,
    endColumn: 4,
  });
  assert.equal(wholeLine, false);
  assert.equal(range.start.line, 70);
  assert.equal(range.end.line, 78);
  assert.equal(range.end.character, 3);
});

check('a missing region does not throw', () => {
  const { range, wholeLine } = regionToRange(undefined);
  assert.equal(wholeLine, true);
  assert.equal(range.start.line, 0);
});

check('out-of-range line numbers are clamped, not negative', () => {
  const { range } = regionToRange({ startLine: 0, startColumn: 0 });
  assert.equal(range.start.line, 0);
  assert.equal(range.start.character, 0);
});

check('endLine before startLine is ignored', () => {
  const { range } = regionToRange({ startLine: 10, endLine: 4 });
  assert.equal(range.start.line, 9);
  assert.equal(range.end.line, 9);
});

check('character offsets resolve against a document', () => {
  const document = {
    positionAt: (offset) => new vscode.Position(0, offset),
    validateRange: (range) => range,
    lineAt: () => ({ range: new vscode.Range(0, 0, 0, 10) }),
    lineCount: 1,
  };
  const { range } = regionToRange({ charOffset: 5, charLength: 7 }, document);
  assert.equal(range.start.character, 5);
  assert.equal(range.end.character, 12);
});

check('positions are labelled like the Problems view', () => {
  assert.equal(formatPosition({ startLine: 12, startColumn: 5 }), 'Ln 12, Col 5');
  assert.equal(formatPosition({ startLine: 12 }), 'Ln 12');
  assert.equal(
    formatPosition({ startLine: 12, startColumn: 5, endLine: 14, endColumn: 2 }),
    'Ln 12, Col 5',
    'only the start is shown, as in the Problems view',
  );
  assert.equal(formatPosition({ charOffset: 512 }), 'Offset 512');
  assert.equal(formatPosition(undefined), undefined);
});

console.log('code inside tool messages');

// The real MSVC diagnostics this was built against.
const TEMPLATE_MESSAGE =
  "see reference to class template instantiation 'rsh::Tool::PrepareSelection<TDComp>' being compiled";
const OPERATOR_MESSAGE =
  "while compiling class template member function 'rsh::Details::PropertyT<int> &rsh::Details::PropertyT<int>::operator =(const rsh::Details::PropertyT<int> &)'";

check('a quoted C++ symbol is found', () => {
  const [span, ...rest] = findCodeSpans(TEMPLATE_MESSAGE);
  assert.deepEqual(rest, [], 'one fragment in this message');
  assert.equal(
    TEMPLATE_MESSAGE.slice(span[0], span[1]),
    'rsh::Tool::PrepareSelection<TDComp>',
    'the span must cover the code without its quotes',
  );
});

check('a quoted signature with spaces is found', () => {
  assert.equal(
    codeFragments(OPERATOR_MESSAGE)[0],
    'rsh::Details::PropertyT<int> &rsh::Details::PropertyT<int>::operator =(const rsh::Details::PropertyT<int> &)',
  );
});

check('a bare identifier counts as code', () => {
  assert.deepEqual(codeFragments("'document' may be undefined here."), ['document']);
});

check('quoted prose is left alone', () => {
  // MSVC quotes the static_assert text itself; that is a sentence, not code.
  assert.deepEqual(findCodeSpans("static_assert failed: 'TValue must be copy constructible'"), []);
  assert.deepEqual(findCodeSpans("the file 'was not found' anywhere"), []);
});

check('an apostrophe in prose does not produce a bogus span', () => {
  assert.deepEqual(findCodeSpans("the value's type is unclear"), []);
  assert.deepEqual(findCodeSpans("don't do that"), []);
});

check('several fragments are found in order', () => {
  const message = "cannot convert 'std::vector<int>' to 'QList<int>' here";
  const spans = findCodeSpans(message);
  assert.deepEqual(
    spans.map(([start, end]) => message.slice(start, end)),
    ['std::vector<int>', 'QList<int>'],
  );
  assert.ok(spans[0][1] <= spans[1][0], 'spans must not overlap');
});

check('backtick-quoted code is found too', () => {
  assert.deepEqual(codeFragments('consider using `std::move(value)` instead'), ['std::move(value)']);
});

check('every distinct fragment gets its own block, deduplicated and capped', () => {
  const both = "see the first reference to 'rsh::A::Fn' in 'rsh::B::Fn'";
  assert.deepEqual(codeFragments(both), ['rsh::A::Fn', 'rsh::B::Fn']);
  assert.deepEqual(codeFragments("'X::y' calls 'X::y' twice"), ['X::y'], 'no duplicate blocks');
  const many = "'A::a' 'B::b' 'C::c' 'D::d' 'E::e' 'F::f'";
  assert.equal(codeFragments(many).length, 4, 'a tooltip is not a listing');
  assert.equal(codeFragments(many, 2).length, 2);
});

check('the language is taken from the file extension', () => {
  assert.equal(languageIdFor('src/RshProperty.h'), 'cpp', 'headers colour as C++');
  assert.equal(languageIdFor('Src/Property/RshProperty.cpp'), 'cpp');
  assert.equal(languageIdFor('file:///D:/x/y.hxx'), 'cpp');
  assert.equal(languageIdFor('a/b/c.ts'), 'typescript');
  assert.equal(languageIdFor('main.PY'), 'python', 'extensions are case-insensitive');
  assert.equal(languageIdFor('notes.unknownext'), undefined);
  assert.equal(languageIdFor(undefined), undefined);
});

check('code survives markdown escaping as inline code', () => {
  const markdown = messageToMarkdown(TEMPLATE_MESSAGE);
  assert.ok(
    markdown.includes('`rsh::Tool::PrepareSelection<TDComp>`'),
    `angle brackets must not be escaped inside code: ${markdown}`,
  );
  assert.ok(!markdown.includes('\\<'), 'no backslashes inside the code span');
  // Prose around it is still escaped.
  assert.match(messageToMarkdown('use *this* and `that`'), /\\\*this\\\*/);
});

console.log('malformed input');

check('rejects invalid JSON with a clear message', () => {
  assert.throws(
    () => parseSarifLog(vscode.Uri.file('bad.sarif'), '{ not json'),
    /is not valid JSON/,
  );
});

check('rejects JSON that is not a SARIF log', () => {
  assert.throws(
    () => parseSarifLog(vscode.Uri.file('bad.sarif'), '{"hello": "world"}'),
    /has no "runs" array/,
  );
});

check('survives a run with no results, no tool and no rules', () => {
  const empty = parseSarifLog(vscode.Uri.file('empty.sarif'), '{"runs":[{}]}');
  assert.equal(empty.results.length, 0);
  assert.equal(empty.runs[0].toolName, 'Unknown tool');
});

check('survives results with no message, rule or location', () => {
  const odd = parseSarifLog(
    vscode.Uri.file('odd.sarif'),
    JSON.stringify({ runs: [{ results: [{}, { locations: [] }, { locations: [{}] }] }] }),
  );
  assert.equal(odd.results.length, 3);
  assert.equal(odd.results[0].message, '(no message)');
  assert.equal(odd.results[0].ruleId, '(no rule id)');
  assert.equal(odd.results[0].primaryLocation, undefined);
  assert.equal(odd.results[0].level, 'warning', 'kind fail with no rule config defaults to warning');
});

check('a non-fail result is informational, not a warning', () => {
  const passing = parseSarifLog(
    vscode.Uri.file('pass.sarif'),
    JSON.stringify({ runs: [{ results: [{ kind: 'pass', message: { text: 'all good' } }] }] }),
  );
  assert.equal(passing.results[0].level, 'none');
});

check('follows artifactLocation.index into run.artifacts', () => {
  const indexed = parseSarifLog(
    vscode.Uri.file('indexed.sarif'),
    JSON.stringify({
      runs: [
        {
          artifacts: [{ location: { uri: 'src/a.ts' } }, { location: { uri: 'src/b.ts' } }],
          results: [
            {
              message: { text: 'x' },
              locations: [{ physicalLocation: { artifactLocation: { index: 1 } } }],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(indexed.results[0].primaryLocation.uri, 'src/b.ts');
});

check('keeps logical-only locations addressable', () => {
  const logical = parseSarifLog(
    vscode.Uri.file('logical.sarif'),
    JSON.stringify({
      runs: [
        {
          results: [
            {
              message: { text: 'x' },
              locations: [{ logicalLocations: [{ fullyQualifiedName: 'My.Name.Space.Fn' }] }],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(logical.results[0].primaryLocation.logicalName, 'My.Name.Space.Fn');
  assert.equal(logical.results[0].primaryLocation.uri, undefined);
});

check('a rejected suppression does not suppress', () => {
  const rejected = parseSarifLog(
    vscode.Uri.file('supp.sarif'),
    JSON.stringify({
      runs: [
        {
          results: [
            { message: { text: 'x' }, suppressions: [{ kind: 'external', status: 'rejected' }] },
          ],
        },
      ],
    }),
  );
  assert.equal(rejected.results[0].suppressed, false);
});

check('handles a BOM at the start of the file', () => {
  const withBom = parseSarifLog(vscode.Uri.file('bom.sarif'), '﻿{"runs":[]}');
  assert.equal(withBom.results.length, 0);
});

console.log('manifest');

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const sources = ['extension.ts', 'model.ts', 'store.ts', 'tree.ts', 'highlight.ts', 'pathResolver.ts', 'region.ts']
  .map((file) => readFileSync(path.join(root, 'src', file), 'utf8'))
  .join('\n');

const declaredCommands = new Set(manifest.contributes.commands.map((command) => command.command));

check('the activity bar icon exists', () => {
  const icon = manifest.contributes.viewsContainers.activitybar[0].icon;
  assert.ok(existsSync(path.join(root, icon)), `${icon} is missing`);
});

check('the view lives in the activity bar container', () => {
  const container = manifest.contributes.viewsContainers.activitybar[0].id;
  assert.ok(manifest.contributes.views[container], `no views declared for "${container}"`);
  assert.equal(manifest.contributes.views[container][0].id, 'sarifViewer.results');
});

check('every command used in a menu is declared', () => {
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    for (const entry of entries) {
      assert.ok(declaredCommands.has(entry.command), `${menu}: ${entry.command} is not declared`);
    }
  }
});

check('every command linked from a welcome view is declared', () => {
  for (const welcome of manifest.contributes.viewsWelcome) {
    for (const [, id] of welcome.contents.matchAll(/command:([\w.]+)/g)) {
      assert.ok(declaredCommands.has(id), `${id} is linked but not declared`);
    }
  }
});

check('declared and registered commands match', () => {
  const registered = new Set(
    [...sources.matchAll(/register(?:Command)?\(\s*'(sarifViewer\.[\w.]+)'/g)].map((m) => m[1]),
  );
  for (const id of declaredCommands) {
    assert.ok(registered.has(id), `${id} is declared but never registered`);
  }
  for (const id of registered) {
    assert.ok(declaredCommands.has(id), `${id} is registered but not declared in package.json`);
  }
});

check('the manifest contributes nothing that can produce diagnostics', () => {
  // jsonValidation would have the JSON language service squiggle any .sarif
  // opened as text and file it in Problems, with no extension setting to gate
  // it. Same story for grammars, languages and problemMatchers.
  for (const point of ['jsonValidation', 'languages', 'grammars', 'problemMatchers', 'problemPatterns']) {
    assert.equal(
      manifest.contributes[point],
      undefined,
      `contributes.${point} can put errors in the editor outside our control`,
    );
  }
});

check('the empty view distinguishes a clean log from a filtered one', () => {
  const whens = manifest.contributes.viewsWelcome.map((entry) => entry.when);
  assert.ok(whens.includes('sarifViewer.hasLogs && sarifViewer.isEmpty && !sarifViewer.hasResults'));
  assert.ok(whens.includes('sarifViewer.hasLogs && sarifViewer.isEmpty && sarifViewer.hasResults'));
});

check('the opt-in settings default to off', () => {
  const properties = manifest.contributes.configuration.properties;
  // Both of these reach outside the viewer — one touches the filesystem at
  // startup, the other writes into a panel the user did not ask about.
  assert.equal(properties['sarifViewer.autoLoadWorkspaceLogs'].default, false);
  assert.equal(properties['sarifViewer.publishDiagnostics'].default, false);
});

check('code fallbacks agree with the manifest defaults', () => {
  const properties = manifest.contributes.configuration.properties;
  // get(key, fallback) hides a mismatch until the declaration is missing, so
  // check every inline fallback against what package.json promises.
  const found = [...sources.matchAll(/get<(?:boolean|string)>\(\s*'([\w.]+)',\s*('[^']*'|true|false)\)/g)];
  assert.ok(found.length >= 6, 'the fallback regex found suspiciously little');
  for (const [, key, raw] of found) {
    const declared = properties[`sarifViewer.${key}`]?.default;
    const fallback = raw === 'true' ? true : raw === 'false' ? false : raw.slice(1, -1);
    assert.equal(fallback, declared, `fallback for ${key} disagrees with package.json`);
  }
});

check('every setting read by the code is declared', () => {
  const declared = new Set(Object.keys(manifest.contributes.configuration.properties));
  const used = new Set(
    [...sources.matchAll(/get<[^>]+>\(\s*'([\w.]+)'/g)].map((m) => `sarifViewer.${m[1]}`),
  );
  assert.ok(used.size > 5, 'the settings regex found nothing — check it still matches the code');
  for (const key of used) {
    assert.ok(declared.has(key), `${key} is read but not declared in package.json`);
  }
});

check('the bundle entry point is the declared main', () => {
  assert.equal(manifest.main, './dist/extension.js');
  assert.ok(existsSync(path.join(root, 'src', 'extension.ts')));
});

console.log('activation and tree rendering');

const { __test } = vscode;
__test.setWorkspaceFolders([root]);
// No config overrides: activation must exercise the shipped defaults, which
// means no workspace scan and no diagnostics until asked.

/** Stands in for a vscode.Memento. */
const makeMemento = (initial = {}) => ({
  data: initial,
  get: (key, fallback) => (key in initial ? initial[key] : fallback),
  update: async (key, value) => {
    initial[key] = value;
  },
  keys: () => Object.keys(initial),
});

const workspaceState = makeMemento();
const globalState = makeMemento();
const context = {
  subscriptions: [],
  extensionUri: vscode.Uri.file(root),
  workspaceState,
  globalState,
};
activate(context);

const view = __test.treeViews[0];
const provider = view.options.treeDataProvider;

await checkAsync('activation registers every declared command', async () => {
  for (const id of declaredCommands) {
    assert.ok(__test.commands.has(id), `${id} was not registered at activation`);
  }
  assert.equal(view.id, 'sarifViewer.results');
});

await checkAsync('an empty viewer renders nothing and claims no results', async () => {
  assert.deepEqual(provider.getChildren(), []);
  assert.equal(view.badge, undefined);
});

await checkAsync('opening a log fills the tree', async () => {
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(samplePath));
  assert.deepEqual(__test.messages.error, [], 'the sample log must load without errors');
  // 6 of 7 results are visible: the suppressed one is hidden by default.
  assert.equal(view.badge.value, 6);
  assert.match(view.description, /demo\.sarif/);
  assert.match(view.description, /2 errors, 3 warnings, 1 note/);
});

let fileGroups;
await checkAsync('a single log is grouped by file at the root', async () => {
  fileGroups = provider.getChildren();
  assert.ok(fileGroups.length > 0);
  assert.ok(
    fileGroups.every((node) => node.kind === 'group'),
    'the lone log should not add a row of its own',
  );
  const labels = fileGroups.map((node) => node.label);
  assert.deepEqual(labels, ['does-not-exist.ts', 'extension.ts', 'model.ts', 'pathResolver.ts', 'tree.ts']);
  assert.ok(!labels.includes('highlight.ts'), 'the suppressed result must stay hidden');
});

await checkAsync('a relative uri under a foreign uriBaseId resolves to the real file', async () => {
  const group = fileGroups.find((node) => node.label === 'extension.ts');
  const item = await provider.getTreeItem(group);
  assert.equal(item.resourceUri.fsPath, path.join(root, 'src', 'extension.ts'));
  assert.equal(item.description, 'src · 1 error, 1 warning');
});

await checkAsync('file rows defer to the icon theme, and start expanded', async () => {
  for (const label of ['extension.ts', 'does-not-exist.ts']) {
    const item = await provider.getTreeItem(fileGroups.find((node) => node.label === label));
    // ThemeIcon.File, not a folder icon and not a hard-coded codicon: the active
    // file icon theme resolves the icon from resourceUri's extension.
    assert.equal(item.iconPath, vscode.ThemeIcon.File, `${label} must use the file theme icon`);
    assert.ok(item.resourceUri, `${label} needs a resourceUri for the icon theme to key on`);
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded, label);
  }
});

await checkAsync('expandGroups=false collapses the group rows again', async () => {
  await vscode.workspace.getConfiguration('sarifViewer').update('expandGroups', false);
  const item = await provider.getTreeItem(provider.getChildren()[0]);
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  await vscode.workspace.getConfiguration('sarifViewer').update('expandGroups', true);
});

await checkAsync('the log row uses the icon theme too', async () => {
  __test.config['sarifViewer.grouping'] = 'file';
  const logNode = { kind: 'log', log: provider.getChildren()[0].log, parent: undefined };
  const item = await provider.getTreeItem(logNode);
  assert.equal(item.iconPath, vscode.ThemeIcon.File);
  assert.equal(item.resourceUri.fsPath, samplePath);
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
});

await checkAsync('rule and severity rows keep their severity icon', async () => {
  __test.quickPickResponse = { value: 'severity' };
  await __test.execute('sarifViewer.setGrouping');
  const [errors, warnings] = provider.getChildren();
  assert.equal((await provider.getTreeItem(errors)).iconPath.id, 'error');
  assert.equal((await provider.getTreeItem(warnings)).iconPath.id, 'warning');
  __test.quickPickResponse = { value: 'file' };
  await __test.execute('sarifViewer.setGrouping');
  fileGroups = provider.getChildren();
});

await checkAsync('a file missing from the workspace is flagged in the tooltip', async () => {
  const group = fileGroups.find((node) => node.label === 'does-not-exist.ts');
  const item = await provider.getTreeItem(group);
  assert.match(item.tooltip.value, /not found in this workspace/);
});

let errorResult;
await checkAsync('result rows carry the rule, position and open command', async () => {
  const group = fileGroups.find((node) => node.label === 'extension.ts');
  const results = provider.getChildren(group);
  assert.equal(results.length, 2);
  errorResult = results[0]; // errors sort before warnings
  const item = await provider.getTreeItem(errorResult);
  assert.equal(item.label, "'document' may be undefined here.", 'a plain, unstyled label');
  // Problems-view formatting: grouped by file, so the file name is redundant.
  assert.equal(item.description, '(DL0002) [Ln 20, Col 3]');
  assert.equal(item.iconPath.id, 'error');
  assert.equal(item.command.command, 'sarifViewer.openResult');
  assert.equal(item.contextValue, 'sarifResult:help');
  assert.match(item.tooltip.value, /Rule documentation/);
});

await checkAsync('related locations and code flow steps become child rows', async () => {
  const related = provider.getChildren(errorResult);
  assert.equal(related.length, 1);
  const relatedItem = await provider.getTreeItem(related[0]);
  assert.equal(relatedItem.label, 'the value is created here');
  assert.equal(relatedItem.description, 'extension.ts [Ln 16, Col 9]');
  assert.equal(relatedItem.iconPath.id, 'link');

  const flowGroup = provider.getChildren().find((node) => node.label === 'pathResolver.ts');
  const tainted = provider.getChildren(flowGroup)[0];
  const steps = provider.getChildren(tainted);
  assert.equal(steps.length, 3);
  const first = await provider.getTreeItem(steps[0]);
  assert.equal(first.label, '1. the log is parsed from untrusted JSON');
  assert.equal(first.iconPath.id, 'debug-stackframe-dot');
});

console.log('clicking a result highlights the editor');

await checkAsync('the clicked region is revealed and decorated', async () => {
  await __test.execute('sarifViewer.openResult', errorResult);
  const editor = __test.editors.find((candidate) => candidate.document.fileName.endsWith('extension.ts'));
  assert.ok(editor, 'the result file must be opened in an editor');

  // The cursor lands on the start of the region without selecting it.
  assert.equal(editor.selection.start.line, 19);
  assert.equal(editor.selection.start.character, 2);
  assert.ok(editor.selection.isEmpty);
  assert.equal(editor.revealed.at(-1).range.start.line, 19);

  const applied = [...editor.decorations.entries()].filter(([, ranges]) => ranges.length > 0);
  assert.equal(applied.length, 2, 'one decoration for the result, one for its related location');

  const [primaryKey, primaryRanges] = applied.find(([key]) => key.includes('editorError'));
  assert.ok(primaryKey.includes('range'), 'a region with columns is not a whole-line highlight');
  assert.equal(primaryRanges.length, 1);
  assert.equal(primaryRanges[0].range.start.line, 19);
  assert.equal(primaryRanges[0].range.start.character, 2);
  // endColumn 30 is exclusive, so character 29 — clamped to the end of a shorter line.
  const lineLength = editor.document.lineAt(19).text.length;
  assert.equal(primaryRanges[0].range.end.character, Math.min(29, lineLength));

  const [, relatedRanges] = applied.find(([key]) => key.includes('editorInfo'));
  assert.equal(relatedRanges.length, 1);
  assert.equal(relatedRanges[0].range.start.line, 15, 'related location at SARIF line 16');
});

await checkAsync('a line-only region highlights the whole line', async () => {
  const group = provider.getChildren().find((node) => node.label === 'extension.ts');
  const warning = provider.getChildren(group)[1];
  await __test.execute('sarifViewer.openResult', warning);
  const editor = __test.editors.find((candidate) => candidate.document.fileName.endsWith('extension.ts'));
  const applied = [...editor.decorations.entries()].filter(([, ranges]) => ranges.length > 0);
  assert.equal(applied.length, 1);
  const [key, ranges] = applied[0];
  assert.ok(key.includes('line'), `expected a whole-line decoration, got ${key}`);
  assert.ok(key.includes('editorWarning'));
  assert.equal(ranges[0].range.start.line, 26, 'SARIF line 27 is line index 26');
  assert.equal(ranges[0].range.start.character, 0);
});

await checkAsync('a multi-line region spans every line it covers', async () => {
  const group = provider.getChildren().find((node) => node.label === 'tree.ts');
  await __test.execute('sarifViewer.openResult', provider.getChildren(group)[0]);
  const editor = __test.editors.find((candidate) => candidate.document.fileName.endsWith('tree.ts'));
  const ranges = [...editor.decorations.values()].flat();
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].range.start.line, 70);
  assert.equal(ranges[0].range.end.line, 78);
});

await checkAsync('clicking a code flow step marks it, and its siblings faintly', async () => {
  const group = provider.getChildren().find((node) => node.label === 'pathResolver.ts');
  const tainted = provider.getChildren(group)[0];
  const step = provider.getChildren(tainted)[1];
  await __test.execute('sarifViewer.openResult', step);
  const editor = __test.editors.find((candidate) => candidate.document.fileName.endsWith('pathResolver.ts'));
  const applied = [...editor.decorations.entries()].filter(([, ranges]) => ranges.length > 0);

  const [, primary] = applied.find(([key]) => key.includes('editorError'));
  assert.equal(primary.length, 1, 'the clicked step is the only primary range');
  assert.equal(primary[0].range.start.line, 29, 'step 2 sits at SARIF line 30');

  // The remaining step of the same flow in this file stays visible as context,
  // and the clicked step is not double-decorated.
  const [, flow] = applied.find(([key]) => key.includes('dashed'));
  assert.equal(flow.length, 1);
  assert.equal(flow[0].range.start.line, 59, 'step 3 sits at SARIF line 60');
});

await checkAsync('switching results clears the previous highlight', async () => {
  const treeEditor = __test.editors.find((candidate) => candidate.document.fileName.endsWith('tree.ts'));
  assert.deepEqual(
    [...treeEditor.decorations.values()].flat(),
    [],
    'the highlight in tree.ts must be gone once another result is selected',
  );
});

await checkAsync('clearHighlights removes every decoration', async () => {
  await __test.execute('sarifViewer.clearHighlights');
  for (const editor of __test.editors) {
    assert.deepEqual([...editor.decorations.values()].flat(), []);
  }
});

await checkAsync('an unresolvable file reports instead of throwing', async () => {
  const group = provider.getChildren().find((node) => node.label === 'does-not-exist.ts');
  await __test.execute('sarifViewer.openResult', provider.getChildren(group)[0]);
  assert.match(__test.messages.warning.at(-1), /could not find "src[\\/]does-not-exist\.ts"/);
  assert.deepEqual(__test.messages.error, []);
});

console.log('filtering, grouping and diagnostics');

await checkAsync('nothing reaches the Problems panel unless asked', async () => {
  await settle();
  assert.deepEqual(__test.diagnostics, [], 'publishDiagnostics is off by default');
  assert.equal(__test.diagnosticCollections.length, 1, 'the collection exists, just stays empty');
});

await checkAsync('turning publishDiagnostics on mirrors the results', async () => {
  await vscode.workspace.getConfiguration('sarifViewer').update('publishDiagnostics', true);
  await settle();
  const published = __test.diagnostics.find((entry) => entry.uri.fsPath.endsWith('extension.ts'));
  assert.ok(published, 'diagnostics must be published for the resolved file');
  assert.equal(published.items.length, 2);
  const error = published.items.find((item) => item.severity === 0);
  assert.equal(error.message, "'document' may be undefined here.");
  assert.equal(error.code.value, 'DL0002');
  assert.equal(error.relatedInformation.length, 1);
  assert.equal(error.source, 'sarif (DemoLinter)');
});

await checkAsync('turning it back off empties the Problems panel again', async () => {
  await vscode.workspace.getConfiguration('sarifViewer').update('publishDiagnostics', false);
  await settle();
  assert.equal(__test.diagnosticCollections[0].entries.size, 0);
});

await checkAsync('a log that becomes clean flushes the errors it had published', async () => {
  const collection = __test.diagnosticCollections[0];
  const rebuiltPath = path.join(outDir, 'rebuilt.sarif');
  const withError = (results) => ({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'MSVC' } }, results }],
  });

  await __test.execute('sarifViewer.closeAllLogs');
  await vscode.workspace.getConfiguration('sarifViewer').update('publishDiagnostics', true);

  // A failing build.
  writeFileSync(
    rebuiltPath,
    JSON.stringify(
      withError([
        {
          ruleId: 'C2338',
          level: 'error',
          message: { text: 'static_assert failed' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'src/store.ts' },
                region: { startLine: 7, startColumn: 1 },
              },
            },
          ],
        },
      ]),
    ),
  );
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(rebuiltPath));
  await settle();
  assert.equal(view.badge.value, 1);
  assert.equal(collection.entries.size, 1, 'the error is in the Problems panel');

  // The next build is clean: the log still exists, it just has no results.
  writeFileSync(rebuiltPath, JSON.stringify(withError([])));
  await __test.execute('sarifViewer.reloadLogs');
  await settle();

  assert.equal(collection.entries.size, 0, 'the stale error must be flushed, not cached');
  assert.deepEqual(provider.getChildren(), [], 'and the tree must be empty');
  assert.equal(view.badge, undefined);
  assert.match(view.description, /rebuilt\.sarif — no results/, 'the log stays loaded');

  // The empty view must say "clean", not "everything is filtered out".
  const contexts = __test.executedCommands.filter((entry) => entry.command === 'setContext');
  const lastValue = (key) => contexts.filter((entry) => entry.args[0] === key).at(-1)?.args[1];
  assert.equal(lastValue('sarifViewer.hasLogs'), true);
  assert.equal(lastValue('sarifViewer.isEmpty'), true);
  assert.equal(lastValue('sarifViewer.hasResults'), false, 'so the "no issues" welcome shows');

  // And an error that comes back is published again.
  writeFileSync(
    rebuiltPath,
    JSON.stringify(
      withError([
        {
          ruleId: 'C2338',
          level: 'error',
          message: { text: 'static_assert failed again' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'src/store.ts' },
                region: { startLine: 9, startColumn: 1 },
              },
            },
          ],
        },
      ]),
    ),
  );
  await __test.execute('sarifViewer.reloadLogs');
  await settle();
  assert.equal(collection.entries.size, 1);
  assert.equal([...collection.entries.values()][0][0].message, 'static_assert failed again');

  await vscode.workspace.getConfiguration('sarifViewer').update('publishDiagnostics', false);
  await settle();
  await __test.execute('sarifViewer.closeAllLogs');
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(samplePath));
});

await checkAsync('grouping by severity relabels the roots', async () => {
  __test.quickPickResponse = { value: 'severity' };
  await __test.execute('sarifViewer.setGrouping');
  assert.deepEqual(
    provider.getChildren().map((node) => node.label),
    ['Errors', 'Warnings', 'Notes'],
  );
});

await checkAsync('grouping by rule shows the rule name', async () => {
  __test.quickPickResponse = { value: 'rule' };
  await __test.execute('sarifViewer.setGrouping');
  const groups = provider.getChildren();
  const labels = groups.map((node) => node.label);
  assert.ok(labels.includes('DL0002 (NullDereference)'), labels.join(', '));
  assert.ok(labels.includes('DL0004 (TaintedInput)'));

  // The rule is already the group, so the row shows file and position only.
  const item = await provider.getTreeItem(provider.getChildren(groups[0])[0]);
  assert.equal(item.description, 'extension.ts [Ln 20, Col 3]');
});

await checkAsync('a flat list keeps every visible result', async () => {
  __test.quickPickResponse = { value: 'none' };
  await __test.execute('sarifViewer.setGrouping');
  const nodes = provider.getChildren();
  assert.equal(nodes.length, 6);
  assert.ok(nodes.every((node) => node.kind === 'result'));
  assert.deepEqual(
    nodes.map((node) => node.result.level),
    ['error', 'error', 'warning', 'warning', 'warning', 'note'],
    'results sort by severity first',
  );

  // Ungrouped, a row carries all three parts, like a Problems view entry.
  const item = await provider.getTreeItem(nodes[0]);
  assert.equal(item.description, 'extension.ts (DL0002) [Ln 20, Col 3]');
  const lineOnly = await provider.getTreeItem(
    nodes.find((node) => node.result.message.startsWith("Variable 'syncView'")),
  );
  assert.equal(lineOnly.description, 'extension.ts (DL0001) [Ln 27]', 'no column, no Col part');
});

await checkAsync('the text filter narrows the tree and the badge', async () => {
  __test.inputBoxResponse = 'tainted';
  await __test.execute('sarifViewer.setTextFilter');
  assert.equal(view.badge.value, 1);
  assert.equal(provider.getChildren()[0].result.ruleId, 'DL0004');
  assert.match(view.description, /filter: "tainted"/);
});

await checkAsync('showing suppressed results reveals the hidden one', async () => {
  __test.inputBoxResponse = '';
  await __test.execute('sarifViewer.setTextFilter');
  __test.config['sarifViewer.showSuppressed'] = true;
  await vscode.workspace.getConfiguration('sarifViewer').update('showSuppressed', true);
  assert.equal(view.badge.value, 7);
  const suppressed = provider.getChildren().find((node) => node.result.suppressed);
  const item = await provider.getTreeItem(suppressed);
  assert.equal(item.iconPath.id, 'circle-slash');
  assert.match(item.description, /suppressed/);
});

await checkAsync('the severity filter hides levels', async () => {
  __test.quickPickResponse = [{ level: 'error' }];
  await __test.execute('sarifViewer.setLevelFilter');
  assert.equal(view.badge.value, 2, 'only the two errors remain');
  await __test.execute('sarifViewer.clearFilters');
  assert.equal(view.badge.value, 7, 'clearFilters restores every level');
});

await checkAsync('copying a message includes the rule id', async () => {
  const result = provider.getChildren().find((node) => node.result.ruleId === 'DL0002');
  await __test.execute('sarifViewer.copyMessage', result);
  assert.equal(await vscode.env.clipboard.readText(), "DL0002: 'document' may be undefined here.");
});

await checkAsync('reloading keeps the same content', async () => {
  await __test.execute('sarifViewer.reloadLogs');
  assert.equal(view.badge.value, 7);
  assert.deepEqual(__test.messages.error, []);
});

await checkAsync('closing the log empties the viewer', async () => {
  await __test.execute('sarifViewer.closeAllLogs');
  assert.deepEqual(provider.getChildren(), []);
  assert.equal(view.badge, undefined);
  assert.equal(view.description, undefined);
});

await checkAsync('several logs each get their own row', async () => {
  __test.quickPickResponse = { value: 'file' };
  await __test.execute('sarifViewer.setGrouping');
  const secondPath = path.join(outDir, 'second.sarif');
  writeFileSync(
    secondPath,
    JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'OtherTool', version: '9.0' } },
          results: [
            {
              ruleId: 'OT1',
              level: 'error',
              message: { text: 'from the second log' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/store.ts' },
                    region: { startLine: 5 },
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
  );

  await __test.execute('sarifViewer.openLog', undefined, [vscode.Uri.file(samplePath), vscode.Uri.file(secondPath)]);
  const roots = provider.getChildren();
  assert.equal(roots.length, 2);
  assert.ok(roots.every((node) => node.kind === 'log'));
  assert.deepEqual(
    roots.map((node) => node.log.label),
    ['demo.sarif', 'second.sarif'],
  );
  assert.equal(view.badge.value, 8, 'both logs contribute to the badge');
  assert.equal(view.title, 'Analysis Results (2 logs)');

  const secondLog = roots[1];
  const item = await provider.getTreeItem(secondLog);
  assert.equal(item.description, '1 error');
  assert.match(item.tooltip.value, /OtherTool 9\.0/);
  const secondGroups = provider.getChildren(secondLog);
  assert.equal(secondGroups.length, 1, 'grouped by file under its own log row');
  assert.equal(secondGroups[0].label, 'store.ts');
  assert.equal(provider.getParent(secondGroups[0]), secondLog);

  // Closing one log collapses the root back to the survivor's groups.
  await __test.execute('sarifViewer.closeLog', secondLog);
  const remaining = provider.getChildren();
  assert.ok(remaining.every((node) => node.kind === 'group'), 'no log row for a lone log');
  assert.ok(remaining.some((node) => node.label === 'extension.ts'));
  await __test.execute('sarifViewer.closeAllLogs');
});

await checkAsync('a log that is not SARIF is reported, not swallowed', async () => {
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(path.join(root, 'package.json')));
  assert.match(__test.messages.error.at(-1), /has no "runs" array/);
  assert.deepEqual(provider.getChildren(), []);
});

console.log('opening a log in an editor');

check('the extension claims no editor for .sarif', () => {
  // Claiming *.sarif with a custom editor would compete with any other SARIF
  // extension — VS Code would ask the user which editor to use on every open.
  assert.equal(manifest.contributes.customEditors, undefined);
  assert.ok(
    !manifest.activationEvents.some((event) => event.startsWith('onCustomEditor:')),
    'and nothing activates on a custom editor',
  );
});

await checkAsync('opening a log in an editor loads it into the tree', async () => {
  await __test.execute('sarifViewer.closeAllLogs');
  assert.deepEqual(provider.getChildren(), [], 'start from an empty viewer');

  __test.executedCommands = [];
  __test.openDocument(vscode.Uri.file(samplePath));
  await waitFor(() => view.badge !== undefined, 'the opened log to reach the tree');

  assert.equal(view.badge.value, 7);
  assert.ok(provider.getChildren().length > 0);
  assert.match(__test.statusMessages.at(-1), /demo\.sarif — 7 results/);
});

check('and does not touch the editor or steal focus', () => {
  // Passive by design: whatever editor VS Code opened stays exactly as it is,
  // so another SARIF extension's editor is never closed or replaced.
  for (const command of ['vscode.openWith', 'workbench.action.closeActiveEditor', 'vscode.open']) {
    assert.ok(
      !__test.executedCommands.some((entry) => entry.command === command),
      `${command} must not be used when a log is merely opened`,
    );
  }
  assert.ok(
    !__test.executedCommands.some((entry) => entry.command === 'workbench.view.extension.sarifViewer'),
    'the tree must not be brought forward: the user opened a file, not the viewer',
  );
});

await checkAsync('other files and other schemes are ignored', async () => {
  await __test.execute('sarifViewer.closeAllLogs');
  __test.messages.error = [];

  __test.openDocument(vscode.Uri.file(path.join(root, 'package.json')));
  __test.openDocument(vscode.Uri.file(path.join(root, 'src', 'store.ts')));
  await settle();
  assert.deepEqual(provider.getChildren(), [], 'a non-SARIF file loads nothing');

  // A git-scheme .sarif is a stale revision, not the working copy.
  const gitCopy = vscode.Uri.parse(`git:${samplePath}?ref=HEAD`);
  __test.openDocument(gitCopy);
  await settle();
  assert.deepEqual(provider.getChildren(), [], 'only file: URIs are loaded');
  assert.deepEqual(__test.messages.error, [], 'and none of this reports an error');
});

await checkAsync('a .sarif that is not a log opens quietly', async () => {
  // The file is on screen in the editor, so a popup would only restate it.
  const notALog = path.join(outDir, 'broken.sarif');
  writeFileSync(notALog, '{ "this": "is not sarif" }');
  __test.messages.error = [];
  __test.openDocument(vscode.Uri.file(notALog));
  await settle();
  assert.deepEqual(__test.messages.error, []);
  assert.deepEqual(provider.getChildren(), []);
});

await checkAsync('loadOpenedLogs=false leaves opened logs alone', async () => {
  await vscode.workspace.getConfiguration('sarifViewer').update('loadOpenedLogs', false);
  __test.openDocument(vscode.Uri.file(samplePath));
  await settle();
  assert.equal(view.badge, undefined, 'nothing is loaded');
  await vscode.workspace.getConfiguration('sarifViewer').update('loadOpenedLogs', true);
});

console.log('absolute paths from a build agent (MSVC-style)');

await checkAsync('an absolute file: uri resolves and shows a workspace-relative folder', async () => {
  await __test.execute('sarifViewer.closeAllLogs');
  const agentLogPath = path.join(outDir, 'agent.sarif');
  const absoluteUri = `file:///${root.replace(/\\/g, '/')}/src/store.ts`;
  writeFileSync(
    agentLogPath,
    JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'MSVC',
              // Rules carrying nothing but an id and a help link, as MSVC emits.
              rules: [{ id: 'C2338', helpUri: 'https://learn.microsoft.com/search/?terms=C2338' }],
            },
          },
          columnKind: 'utf16CodeUnits',
          results: [
            {
              ruleId: 'C2338',
              level: 'error',
              message: { text: "static_assert failed: 'TValue must be copy constructible'" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: absoluteUri },
                    region: { startLine: 5, startColumn: 3 },
                  },
                },
              ],
              relatedLocations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: absoluteUri },
                    region: { startLine: 5, startColumn: 3 },
                  },
                  message: { text: 'the template instantiation context is' },
                },
                {
                  physicalLocation: {
                    artifactLocation: { uri: absoluteUri },
                    region: { startLine: 9, startColumn: 1 },
                  },
                  message: { text: 'while compiling class template member function' },
                },
              ],
            },
          ],
        },
      ],
    }),
  );

  __test.messages.error = []; // an earlier check deliberately provoked one
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(agentLogPath));
  assert.deepEqual(__test.messages.error, []);

  const [group] = provider.getChildren();
  const groupItem = await provider.getTreeItem(group);
  assert.equal(groupItem.label, 'store.ts');
  assert.equal(groupItem.resourceUri.fsPath, path.join(root, 'src', 'store.ts'));
  assert.equal(
    groupItem.description,
    'src · 1 error',
    'an absolute agent path is shown relative to the workspace, not as D:\\...',
  );

  const [result] = provider.getChildren(group);
  const item = await provider.getTreeItem(result);
  assert.equal(item.description, '(C2338) [Ln 5, Col 3]');
  assert.equal(item.contextValue, 'sarifResult:help', 'helpUri survives a rule with no name');

  // A related location on the same range as the result must not double-decorate.
  await __test.execute('sarifViewer.openResult', result);
  const editor = __test.editors.find((candidate) => candidate.document.fileName.endsWith('store.ts'));
  const applied = [...editor.decorations.entries()].filter(([, ranges]) => ranges.length > 0);
  assert.equal(applied.length, 2);
  const [, primary] = applied.find(([key]) => key.includes('editorError'));
  const [, related] = applied.find(([key]) => key.includes('dotted'));
  assert.deepEqual(primary.map((entry) => entry.range.start.line), [4]);
  assert.deepEqual(
    related.map((entry) => entry.range.start.line),
    [8],
    'the related location duplicating the result range is dropped',
  );
});

console.log('C++ code in the tree and tooltips');

await checkAsync('a compiler diagnostic keeps plain rows and colours code in the tooltip', async () => {
  await __test.execute('sarifViewer.closeAllLogs');
  const cppLogPath = path.join(outDir, 'msvc.sarif');
  writeFileSync(
    cppLogPath,
    JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'MSVC', rules: [{ id: 'C2338' }] } },
          results: [
            {
              ruleId: 'C2338',
              level: 'error',
              message: { text: "static_assert failed: 'TValue must be copy constructible'" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'Helios/RshAppCore/Property/RshProperty.h' },
                    region: { startLine: 333, startColumn: 22 },
                  },
                },
              ],
              relatedLocations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'Helios/RshAppCore/Property/RshProperty.cpp' },
                    region: { startLine: 146, startColumn: 44 },
                  },
                  message: { text: TEMPLATE_MESSAGE },
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  __test.messages.error = [];
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(cppLogPath));
  assert.deepEqual(__test.messages.error, []);

  const [group] = provider.getChildren();
  const [result] = provider.getChildren(group);
  const resultItem = await provider.getTreeItem(result);

  // static_assert's text is quoted prose, so there is nothing to colour.
  assert.equal(typeof resultItem.label, 'string');
  assert.ok(
    !resultItem.tooltip.value.includes('```'),
    'does not fabricate a code block out of a sentence',
  );

  const [related] = provider.getChildren(result);
  const relatedItem = await provider.getTreeItem(related);
  // Rows carry no styling at all: a plain string, never a TreeItemLabel, so
  // nothing paints a background behind the text.
  assert.equal(typeof relatedItem.label, 'string');
  assert.equal(relatedItem.label, TEMPLATE_MESSAGE);
  assert.match(relatedItem.tooltip.value, /```cpp\nrsh::Tool::PrepareSelection<TDComp>\n```/);
  assert.equal(
    (relatedItem.tooltip.value.match(/```cpp/g) ?? []).length,
    1,
    'one block per distinct fragment',
  );
  assert.ok(
    relatedItem.tooltip.value.includes('`rsh::Tool::PrepareSelection<TDComp>`'),
    'and appears inline in the message, unescaped',
  );
});

await checkAsync('no tree row is ever styled', async () => {
  // A regression guard: TreeItemLabel.highlights is what draws the accent
  // background, so no row may use it.
  const walk = async (nodes) => {
    for (const node of nodes) {
      const item = await provider.getTreeItem(node);
      assert.equal(
        typeof item.label,
        'string',
        `${JSON.stringify(item.label)} must be a plain string`,
      );
      await walk(provider.getChildren(node));
    }
  };
  await walk(provider.getChildren());
});

await checkAsync('a snippet is preferred over the quoted fragment', async () => {
  // demo.sarif carries a real source snippet on its tree.ts result.
  await __test.execute('sarifViewer.closeAllLogs');
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(samplePath));
  const group = provider.getChildren().find((node) => node.label === 'tree.ts');
  const item = await provider.getTreeItem(provider.getChildren(group)[0]);
  assert.match(
    item.tooltip.value,
    /```typescript\ngetChildren\(element\?: TreeNode\): TreeNode\[\] \{\n```/,
    'the .ts snippet colours as TypeScript',
  );
});

console.log('session restore (per workspace)');

// Isolate restore from the "load what is already open" sweep, which the last
// section left documents behind for.
__test.closeAllDocuments();

const OPEN_LOGS_KEY = 'sarifViewer.openLogs';

await checkAsync('open logs are remembered in workspace state', async () => {
  await __test.execute('sarifViewer.closeAllLogs');
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(samplePath));
  assert.deepEqual(workspaceState.get(OPEN_LOGS_KEY), [vscode.Uri.file(samplePath).toString()]);
  assert.deepEqual(globalState.keys(), [], 'the session is per workspace, not global');
});

await checkAsync('closing a log forgets it', async () => {
  await __test.execute('sarifViewer.closeAllLogs');
  assert.deepEqual(workspaceState.get(OPEN_LOGS_KEY), []);
  await __test.execute('sarifViewer.openLog', vscode.Uri.file(samplePath));
  assert.equal(workspaceState.get(OPEN_LOGS_KEY).length, 1);
});

await checkAsync('shutting the extension down does not erase the session', async () => {
  // dispose() closes every log; persisting that would wipe what we want back.
  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }
  assert.deepEqual(
    workspaceState.get(OPEN_LOGS_KEY),
    [vscode.Uri.file(samplePath).toString()],
    'deactivation must leave the remembered logs alone',
  );
});

await checkAsync('a reload restores the remembered log', async () => {
  const reloaded = {
    subscriptions: [],
    extensionUri: vscode.Uri.file(root),
    workspaceState,
    globalState,
  };
  activate(reloaded);
  const reloadedView = __test.treeViews.at(-1);
  const reloadedProvider = reloadedView.options.treeDataProvider;

  await waitFor(() => reloadedView.badge !== undefined, 'the restored log to reach the tree');
  assert.equal(reloadedView.badge.value, 7);
  assert.match(reloadedView.description, /demo\.sarif/);
  assert.ok(reloadedProvider.getChildren().length > 0);
  assert.match(__test.statusMessages.at(-1), /restored 1 log/);
  for (const subscription of reloaded.subscriptions) {
    subscription.dispose();
  }
});

await checkAsync('restoreLogsOnStartup=false starts empty', async () => {
  __test.config['sarifViewer.restoreLogsOnStartup'] = false;
  const reloaded = {
    subscriptions: [],
    extensionUri: vscode.Uri.file(root),
    workspaceState,
    globalState,
  };
  activate(reloaded);
  const reloadedView = __test.treeViews.at(-1);
  await settle();
  assert.equal(reloadedView.badge, undefined, 'nothing should be restored');
  assert.deepEqual(reloadedView.options.treeDataProvider.getChildren(), []);
  // The remembered list survives, so turning the setting back on still works.
  assert.equal(workspaceState.get(OPEN_LOGS_KEY).length, 1);
  for (const subscription of reloaded.subscriptions) {
    subscription.dispose();
  }
  delete __test.config['sarifViewer.restoreLogsOnStartup'];
});

await checkAsync('a log already open in an editor is loaded at activation', async () => {
  // A window reload restores editor tabs; a .sarif among them should fill the
  // tree even when nothing was remembered.
  __test.closeAllDocuments();
  workspaceState.data[OPEN_LOGS_KEY] = [];
  __test.openDocument(vscode.Uri.file(samplePath));

  const reloaded = {
    subscriptions: [],
    extensionUri: vscode.Uri.file(root),
    workspaceState,
    globalState,
  };
  activate(reloaded);
  const reloadedView = __test.treeViews.at(-1);
  await waitFor(() => reloadedView.badge !== undefined, 'the already-open log to load');
  assert.equal(reloadedView.badge.value, 7);
  for (const subscription of reloaded.subscriptions) {
    subscription.dispose();
  }
  __test.closeAllDocuments();
});

await checkAsync('a remembered log that vanished is skipped quietly', async () => {
  workspaceState.data[OPEN_LOGS_KEY] = [
    vscode.Uri.file(path.join(root, 'samples', 'gone.sarif')).toString(),
    vscode.Uri.file(samplePath).toString(),
  ];
  __test.messages.error = [];
  const reloaded = {
    subscriptions: [],
    extensionUri: vscode.Uri.file(root),
    workspaceState,
    globalState,
  };
  activate(reloaded);
  const reloadedView = __test.treeViews.at(-1);
  await waitFor(() => reloadedView.badge !== undefined, 'the surviving log to load');
  assert.equal(reloadedView.badge.value, 7, 'the log that still exists is restored');
  assert.deepEqual(__test.messages.error, [], 'startup must not pop up errors');
  assert.deepEqual(
    workspaceState.get(OPEN_LOGS_KEY),
    [vscode.Uri.file(samplePath).toString()],
    'the missing entry is pruned once another log loads',
  );
  for (const subscription of reloaded.subscriptions) {
    subscription.dispose();
  }
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${checks} checks passed`);
