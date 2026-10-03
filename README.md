# SARIF Viewer

A VS Code extension that browses [SARIF](https://sarifweb.azurewebsites.net/) static analysis
logs in a tree view on the activity bar, and highlights the offending lines in the editor when
you click a result.

## Features

- **Its own activity bar tab.** A dedicated container (the magnifier-over-document icon) holds
  the *Analysis Results* tree, with a badge showing how many results are visible. File rows use
  your active file icon theme — the same icon the Explorer shows for that extension — and start
  expanded.
- **Opening a log fills the tree.** Open a `.sarif` however you like and its results appear in the
  view. The extension claims no editor for `.sarif`, so the file opens exactly as it would
  otherwise — as text, or in another SARIF extension's editor if you have one. Nothing is opened,
  closed or replaced on your behalf, and the tree does not steal focus.
- **Code in messages.** Compiler diagnostics quote source constructs
  (`see reference to class template instantiation 'rsh::Tool::PrepareSelection<TDComp>' being
  compiled`). Hovering a row renders those fragments as real syntax-coloured code blocks, using the
  grammar for *that row's* file — a `.h` colours as C++, a `.ts` as TypeScript, a `.py` as Python.
  Quoted prose, like the text of a failed `static_assert`, is left alone. Rows themselves stay plain
  text: `TreeItem` labels support no token colouring, only a single accent highlight, which would
  read as a search match rather than as syntax.
- **Problems-view formatting.** Rows read like Problems panel entries — `(C2338) [Ln 333, Col 22]`
  — with the file name in front when the tree is not grouped by file, and paths shown relative to
  the workspace even when the log contains absolute build-agent paths.
- **Click to highlight.** Selecting a result opens the file, scrolls to the region and paints it:
  a coloured underline for a precise region, a full-line highlight when the log only gives a line
  number, and a marker in the overview ruler. The colour follows the severity.
- **Multi-location results.** Related locations and code flow steps (taint traces from CodeQL and
  friends) appear as child rows and are drawn faintly alongside the main result. Clicking a single
  step highlights just that step.
- **Grouping and filtering.** Group by file, rule or severity, or show a flat list; filter by
  severity level or by free text over messages, rule ids and paths.
- **Quiet by default.** Nothing is written to the Problems panel and nothing is squiggled in the
  editor unless you turn on `sarifViewer.publishDiagnostics`. The extension contributes no
  `jsonValidation`, `languages`, `grammars` or `problemMatchers` either, so it cannot flag anything
  outside that one setting. When the setting is on, results are mirrored as diagnostics with
  squiggles and Problems entries; reloading a log that no longer reports anything flushes them, and
  the view says the log is clean rather than pretending a filter hid something.
- **Path recovery.** Logs produced on a build agent rarely contain paths that exist on your
  machine. URIs are resolved against `originalUriBaseIds`, the workspace folders and the log's own
  directory, foreign absolute paths are rebased onto the workspace, and as a last resort the file
  is looked up by name. Unresolvable files are marked in the tree rather than failing silently.
- **Live reload.** A log is re-read when it changes on disk, so re-running your analyser refreshes
  the tree.
- **Session restore.** The logs you had open come back after a window reload, remembered per
  workspace. A log that no longer exists is skipped without complaint and stays on the list, so it
  reappears once your next build regenerates it.

## Getting started

```sh
npm install
npm run compile
```

Then press <kbd>F5</kbd> ("Run Extension") to launch an Extension Development Host.

In that window, open the SARIF tab in the activity bar and then open
[samples/demo.sarif](samples/demo.sarif) from the Explorer — its results appear in the tree. The log
points at this extension's own source files, so every result resolves to real code you can click
through. It deliberately includes
a result pointing at a missing file to show the not-found handling, and a suppressed result that
stays hidden until you enable `sarifViewer.showSuppressed`.

Nothing is loaded until you ask for it — set `sarifViewer.autoLoadWorkspaceLogs` if you would
rather have workspace logs picked up at startup, or run **SARIF: Scan Workspace for SARIF Logs**
when you want them.

To load a log by hand, use **SARIF: Open SARIF Log...**, the `+` button on the view, or
right-click a `.sarif` file in the Explorer.

### Ways to load a log

| How | Effect on your editors |
| --- | --- |
| Open a `.sarif` in an editor | None — the file opens as usual, the tree just fills |
| Right-click a `.sarif` → **Open SARIF Log** | No editor is opened at all |
| **SARIF: Open SARIF Log...**, or the `+` button | No editor is opened at all |
| **SARIF: Scan Workspace for SARIF Logs** | No editor is opened at all |
| A loaded log changes on disk | Reloaded in place |

### Coexisting with other SARIF extensions

This extension contributes no `customEditors`, so it never competes for `.sarif` files. If you also
have an extension that does provide a SARIF editor, it keeps handling double-clicks as it always
did, and VS Code never asks you to choose. The tree fills only when a log is opened as a text
document; when another extension's editor handles the file instead, load it with the `+` button or
the Explorer context menu.

Set `sarifViewer.loadOpenedLogs` to `false` if you would rather opening a `.sarif` did nothing at
all.

## Commands

| Command | What it does |
| --- | --- |
| `SARIF: Open SARIF Log...` | Load one or more logs |
| `SARIF: Scan Workspace for SARIF Logs` | Load every log matching `sarifViewer.workspaceLogGlob` |
| `SARIF: Reload SARIF Logs` | Re-read the open logs from disk |
| `SARIF: Group Results By...` | Switch between file / rule / severity / flat |
| `SARIF: Filter by Severity...` | Choose which levels to show |
| `SARIF: Filter Results by Text...` | Free-text filter |
| `SARIF: Clear Filters` | Drop the text and severity filters |
| `SARIF: Clear Highlights` | Remove the editor decorations |
| `SARIF: Close All Logs` | Empty the viewer |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `sarifViewer.restoreLogsOnStartup` | `true` | Reopen the logs that were loaded in this workspace |
| `sarifViewer.autoLoadWorkspaceLogs` | `false` | Load workspace logs at startup |
| `sarifViewer.workspaceLogGlob` | `**/*.{sarif,sarif.json}` | Which files count as logs |
| `sarifViewer.grouping` | `file` | Tree grouping |
| `sarifViewer.expandGroups` | `true` | Expand group rows when the tree is built |
| `sarifViewer.loadOpenedLogs` | `true` | Load a log into the tree when it is opened in an editor |
| `sarifViewer.levels` | all | Severity levels shown |
| `sarifViewer.showSuppressed` | `false` | Show results the tool suppressed |
| `sarifViewer.publishDiagnostics` | `false` | Mirror results into the Problems panel |
| `sarifViewer.highlightWholeLine` | `false` | Always highlight whole lines |
| `sarifViewer.highlightRelatedLocations` | `true` | Also mark related locations and flow steps |
| `sarifViewer.keepFocusInTree` | `true` | Keep focus in the tree so you can browse with the arrow keys |
| `sarifViewer.watchLogs` | `true` | Reload a log when it changes on disk |

## SARIF support

Targets SARIF 2.1.0. The loader is defensive: every field is treated as optional, and a malformed
log produces a message instead of a broken view.

- `result.level`, falling back to the rule's `defaultConfiguration.level`, then to `result.kind`
  as the specification requires (§3.27.10)
- `message.text`, or `message.id` looked up in the rule's `messageStrings`, with `{0}`-style
  argument substitution
- rule metadata from `tool.driver.rules` and `tool.extensions[].rules`, resolved by
  `ruleIndex`/`rule.index` or by id, including `helpUri`
- physical locations, `region` (line/column *and* `charOffset`/`charLength`), and `contextRegion`
- `artifactLocation.index` into `run.artifacts`, plus `uriBaseId` / `originalUriBaseIds`
- `relatedLocations`, `codeFlows` → `threadFlows` → `locations`
- `logicalLocations` for results with no physical location
- `suppressions` (a `rejected` suppression does not suppress), `baselineState`, `region.snippet`

Column semantics follow the spec: lines and columns are 1-based, and `endColumn` points at the
character *after* the region, so it maps to an exclusive VS Code range end.

## Development

```sh
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
npm run verify     # logic, manifest and end-to-end checks
npm test           # typecheck + verify
npm run vsix       # test, then build sarif-viewer-<version>.vsix and verify it
```

### Installing the .vsix

```sh
code --install-extension sarif-viewer-0.1.0.vsix
```

Or in VS Code: **Extensions → ... → Install from VSIX...**. Reload the window afterwards.

`npm run vsix` runs the test suite, packages with
`vsce package --allow-missing-repository --skip-license --no-rewrite-relative-links`, then runs
`scripts/verifyPackage.mjs`, which loads the *minified* bundle through the same fake editor host and
replays activation, a log load, a click-to-highlight and a custom-editor render — so the artifact
that ships is exercised, not just the sources it was built from. It also fails if the dev build
(source-mapped, unminified) ended up in `dist/`.

Two flags are worth knowing about: `--allow-missing-repository` and `--no-rewrite-relative-links`
are needed because this project has no git remote for vsce to resolve README links against, and
`--skip-license` because `package.json` declares MIT without a `LICENSE` file yet — add one with
the correct copyright holder and the flag can go.

`npm run verify` runs `scripts/verify.mjs`, which bundles the extension with the `vscode` module
aliased to a fake editor host (`scripts/vscodeStub.js`). It activates the real extension, opens
the sample log, walks the tree and asserts on the decorations the click handler produced — so the
parsing, path resolution, grouping, filtering and highlighting are all covered without launching
an editor. It also checks the manifest against the code: every command declared in `package.json`
is registered, and every setting read by the code is declared.

### Layout

| File | Responsibility |
| --- | --- |
| [src/extension.ts](src/extension.ts) | Activation, commands, and the click → open-and-highlight path |
| [src/store.ts](src/store.ts) | Loaded logs, filters, file watching, diagnostics |
| [src/tree.ts](src/tree.ts) | `TreeDataProvider`: nodes, labels, icons, tooltips |
| [src/model.ts](src/model.ts) | Normalizes a SARIF log into a flat result list |
| [src/pathResolver.ts](src/pathResolver.ts) | Maps SARIF URIs onto files that exist locally |
| [src/region.ts](src/region.ts) | SARIF region → `vscode.Range` |
| [src/codeSpans.ts](src/codeSpans.ts) | Finds the code quoted in a message, and its language |
| [src/highlight.ts](src/highlight.ts) | Editor decorations for the selected result |
| [src/sarifTypes.ts](src/sarifTypes.ts) | The subset of the SARIF schema that is read |

| Script | Responsibility |
| --- | --- |
| [scripts/verify.mjs](scripts/verify.mjs) | Source-level checks: parsing, manifest, end-to-end tree and highlighting |
| [scripts/verifyPackage.mjs](scripts/verifyPackage.mjs) | Smoke-tests the minified bundle that ships in the `.vsix` |
| [scripts/vscodeStub.js](scripts/vscodeStub.js) | The fake editor host both scripts run against |
