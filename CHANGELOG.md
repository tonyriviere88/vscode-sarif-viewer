# Changelog

## 0.2.0

- Dropped the `jsonValidation` contribution. It made the JSON language service validate every
  `.sarif` opened as text against a remote schema, putting squiggles in the editor and entries in the
  Problems panel with no extension setting to turn it off.
- An empty tree now tells a clean log apart from a filtered one: a log reporting nothing says so,
  instead of offering to clear filters that are not hiding anything.

- Code quoted inside a tool message — the C++ symbols in a compiler diagnostic, for instance — is
  rendered as a syntax-coloured code block in the row's tooltip, using the language of the file that
  row points at. Quoted prose is left as prose, and tree rows stay unstyled plain text.

- The logs open in a workspace are remembered and reloaded after a window reload
  (`sarifViewer.restoreLogsOnStartup`, on by default). Stored in workspace state, so windows do not
  overwrite each other; a log that has since disappeared is skipped silently and kept on the list so
  it returns after the next build.

- `sarifViewer.autoLoadWorkspaceLogs` and `sarifViewer.publishDiagnostics` now default to off, so
  the viewer stays inert until a log is opened and results stay out of the Problems panel unless
  asked for.

- Opening a `.sarif` in an editor loads it into the tree (`sarifViewer.loadOpenedLogs`). The
  extension contributes no custom editor, so it never claims `.sarif`, never competes with another
  SARIF extension for it, and never opens, closes or replaces an editor. Logs already open in
  editors are picked up at activation too.
- Rows are formatted like Problems panel entries: `(ruleId) [Ln 12, Col 5]`, with the file name in
  front when the tree is not grouped by file.
- File paths are shown relative to the workspace, so logs full of absolute build-agent paths stay
  readable.
- File and log rows use the active file icon theme instead of a generic icon, and group rows start
  expanded (`sarifViewer.expandGroups`).

## 0.1.0

First version.

- SARIF results in a tree view in a dedicated activity bar container.
- Clicking a result opens the file and highlights the region, whole-line when the log gives no
  columns, with severity-coloured decorations and overview ruler markers.
- Related locations and code flow steps as child rows, drawn faintly next to the main result.
- Grouping by file, rule or severity; filtering by severity level and by free text.
- Results mirrored into the Problems panel as diagnostics.
- URI resolution through `originalUriBaseIds`, workspace folders and the log directory, with
  rebasing of foreign absolute paths and a by-name workspace lookup as a fallback.
- Logs reloaded automatically when they change on disk.
