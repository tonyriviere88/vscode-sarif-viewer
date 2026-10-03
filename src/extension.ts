import * as vscode from 'vscode';
import { HighlightManager, HighlightRange } from './highlight';
import {
  LEVEL_ORDER,
  SarifLocation,
  SarifLogFile,
  SarifResultItem,
  formatCounts,
  countLevels,
} from './model';
import { regionToRange } from './region';
import { Grouping, SarifStore } from './store';
import { LocationNode, ResultNode, SarifTreeProvider, TreeNode, displayPath } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  // workspaceState, not globalState: which logs are open is a property of the
  // workspace, and two windows must not overwrite each other's session.
  const store = new SarifStore(context.workspaceState);
  const highlights = new HighlightManager();
  const tree = new SarifTreeProvider(store);
  const view = vscode.window.createTreeView('sarifViewer.results', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const reveal = new ResultRevealer(store, highlights);

  context.subscriptions.push(store, highlights, view);

  const syncView = () => {
    const logs = store.logs;
    const total = store.totalVisible;
    // hasResults distinguishes "this log is clean" from "the filters hid
    // everything" — the two look identical in an empty tree.
    const reported = logs.reduce((sum, log) => sum + log.results.length, 0);
    void vscode.commands.executeCommand('setContext', 'sarifViewer.hasLogs', logs.length > 0);
    void vscode.commands.executeCommand('setContext', 'sarifViewer.isEmpty', total === 0);
    void vscode.commands.executeCommand('setContext', 'sarifViewer.hasResults', reported > 0);
    view.description = describeView(store, logs);
    view.badge = total > 0 ? { value: total, tooltip: `${total} SARIF results` } : undefined;
    view.title = logs.length > 1 ? `Analysis Results (${logs.length} logs)` : 'Analysis Results';
    tree.refresh();
  };

  context.subscriptions.push(
    store.onDidChange(syncView),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('sarifViewer')) {
        store.refresh();
      }
    }),
    // Opening a log in any editor fills the tree. This only observes: the editor
    // is left exactly as VS Code opened it, so the plain text editor and other
    // SARIF extensions keep behaving as they do without this extension.
    vscode.workspace.onDidOpenTextDocument((document) => void loadIfSarif(store, document)),
  );
  syncView();
  for (const document of vscode.workspace.textDocuments) {
    void loadIfSarif(store, document);
  }

  const register = (command: string, handler: (...args: never[]) => unknown) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, (...args: unknown[]) =>
        Promise.resolve(handler(...(args as never[]))).catch((err: unknown) => {
          void vscode.window.showErrorMessage(`SARIF Viewer: ${(err as Error).message}`);
        }),
      ),
    );
  };

  register('sarifViewer.openLog', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
    openLog(store, view, uris?.length ? uris : uri ? [uri] : undefined),
  );
  register('sarifViewer.scanWorkspace', () => scanWorkspace(store, { silent: false }));
  register('sarifViewer.reloadLogs', async () => {
    const errors = await store.reloadAll();
    reportErrors(errors);
  });
  register('sarifViewer.closeLog', (node?: TreeNode) => closeLog(store, node));
  register('sarifViewer.closeAllLogs', () => {
    store.closeAll();
    highlights.clear();
  });
  register('sarifViewer.setGrouping', () => pickGrouping(store));
  register('sarifViewer.setLevelFilter', () => pickLevels(store));
  register('sarifViewer.setTextFilter', () => pickTextFilter(store));
  register('sarifViewer.clearFilters', async () => {
    store.setTextFilter('');
    await updateConfig('levels', [...LEVEL_ORDER]);
  });
  register('sarifViewer.openResult', (node: ResultNode | LocationNode) => reveal.reveal(node));
  register('sarifViewer.clearHighlights', () => highlights.clear());
  register('sarifViewer.copyMessage', async (node?: TreeNode) => {
    if (node?.kind === 'result') {
      await vscode.env.clipboard.writeText(`${node.result.ruleId}: ${node.result.message}`);
    }
  });
  register('sarifViewer.openHelpUri', async (node?: TreeNode) => {
    const uri = node?.kind === 'result' ? node.result.helpUri : undefined;
    if (uri) {
      await vscode.env.openExternal(vscode.Uri.parse(uri));
    }
  });
  register('sarifViewer.revealLogFile', async (node?: TreeNode) => {
    if (node?.kind === 'log') {
      await vscode.window.showTextDocument(node.log.uri, { preview: true });
    }
  });

  void restoreSession(store);
}

export function deactivate(): void {
  // Everything is owned by context.subscriptions.
}

/** Opens the location of a tree node and paints the highlights. */
class ResultRevealer {
  constructor(
    private readonly store: SarifStore,
    private readonly highlights: HighlightManager,
  ) {}

  async reveal(node: ResultNode | LocationNode): Promise<void> {
    const result = node.result;
    const target: SarifLocation =
      node.kind === 'location' ? node.location : (result.primaryLocation ?? { uri: undefined });

    if (!target.uri) {
      void vscode.window.showInformationMessage(
        target.logicalName
          ? `This result only has a logical location: ${target.logicalName}`
          : 'This result has no location to open.',
      );
      return;
    }

    const uri = await this.store.resolver.resolve(target, result.log);
    if (!uri) {
      await this.reportMissingFile(target.uri);
      return;
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `SARIF Viewer: cannot open ${displayPath(target.uri)} — ${(err as Error).message}`,
      );
      return;
    }

    const { range } = regionToRange(target.region, document);
    const keepFocus = vscode.workspace
      .getConfiguration('sarifViewer')
      .get<boolean>('keepFocusInTree', true);
    const editor = await vscode.window.showTextDocument(document, {
      preserveFocus: keepFocus,
      preview: true,
      selection: new vscode.Selection(range.start, range.start),
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    const { primary, secondary } = await this.rangesFor(result, node, document);
    this.highlights.apply(editor, result.level, primary, secondary);
  }

  /**
   * Collects every range of the result that falls inside `document`: the
   * clicked location plus, optionally, its siblings, related locations and code
   * flow steps.
   */
  private async rangesFor(
    result: SarifResultItem,
    node: ResultNode | LocationNode,
    document: vscode.TextDocument,
  ): Promise<{ primary: HighlightRange[]; secondary: HighlightRange[] }> {
    const config = vscode.workspace.getConfiguration('sarifViewer');
    const wholeLineAlways = config.get<boolean>('highlightWholeLine', false);
    const withRelated = config.get<boolean>('highlightRelatedLocations', true);
    const documentKey = document.uri.toString();

    const primary: HighlightRange[] = [];
    const secondary: HighlightRange[] = [];
    const seen = new Set<string>();

    const add = (
      bucket: HighlightRange[],
      location: SarifLocation,
      kind: HighlightRange['kind'],
      hover?: string,
    ) => {
      const { range, wholeLine } = regionToRange(location.region, document);
      // Keyed on the range alone: primary ranges are added first, so a location
      // that is also a related/flow entry keeps its stronger decoration.
      const key = `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      bucket.push({
        range,
        wholeLine: wholeLine || wholeLineAlways,
        kind,
        hoverMessage: hover ? new vscode.MarkdownString(hover) : undefined,
      });
    };

    const inDocument = async (location: SarifLocation): Promise<boolean> => {
      if (!location.uri) {
        return false;
      }
      const resolved = await this.store.resolver.resolve(location, result.log);
      return resolved?.toString() === documentKey;
    };

    if (node.kind === 'location') {
      add(primary, node.location, 'primary', node.location.message);
    } else {
      for (const location of result.locations) {
        if (await inDocument(location)) {
          add(primary, location, 'primary', `**${result.ruleId}**: ${result.message}`);
        }
      }
      // A single-location result whose file failed to match still deserves a mark.
      if (primary.length === 0 && result.primaryLocation) {
        add(primary, result.primaryLocation, 'primary', result.message);
      }
    }

    if (withRelated) {
      for (const location of result.relatedLocations) {
        if (await inDocument(location)) {
          add(secondary, location, 'related', location.message);
        }
      }
      for (const step of result.codeFlowSteps) {
        if (await inDocument(step)) {
          add(secondary, step, 'flow', `${step.step}. ${step.label}`);
        }
      }
    }
    return { primary, secondary };
  }

  private async reportMissingFile(rawUri: string): Promise<void> {
    const path = displayPath(rawUri);
    const choice = await vscode.window.showWarningMessage(
      `SARIF Viewer: could not find "${path}" in this workspace.`,
      'Copy Path',
    );
    if (choice === 'Copy Path') {
      await vscode.env.clipboard.writeText(path);
    }
  }
}

/**
 * Loads a log that has just been opened in an editor.
 *
 * Deliberately passive: no editor is opened, closed or replaced, and the tree is
 * not brought forward, since the user was looking at a file rather than asking
 * for the viewer. Parse failures stay silent — the file is on screen, so a popup
 * would only repeat what the editor already shows.
 */
async function loadIfSarif(store: SarifStore, document: vscode.TextDocument): Promise<void> {
  const config = vscode.workspace.getConfiguration('sarifViewer');
  if (!config.get<boolean>('loadOpenedLogs', true)) {
    return;
  }
  // Only real files: `git`, `output` and diff schemes would load stale copies.
  if (document.uri.scheme !== 'file' || !/\.sarif(\.json)?$/i.test(document.uri.path)) {
    return;
  }
  try {
    const log = await store.loadLog(document.uri);
    void vscode.window.setStatusBarMessage(
      `SARIF: ${log.label} — ${log.results.length} result${log.results.length === 1 ? '' : 's'}`,
      5000,
    );
  } catch {
    // Not a log we can read; the editor is showing it anyway.
  }
}

/**
 * Brings back the logs that were open in this workspace before the window was
 * reloaded. Failures are silent: a log may legitimately be gone, or not rebuilt
 * yet, and startup is the wrong moment for a modal complaint. The entry is kept
 * so the log reappears once the file is regenerated.
 */
async function restoreSession(store: SarifStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('sarifViewer');
  const remembered = config.get<boolean>('restoreLogsOnStartup', true) ? store.rememberedLogs : [];

  if (remembered.length > 0) {
    const { loaded } = await store.loadLogs(remembered);
    if (loaded.length > 0) {
      void vscode.window.setStatusBarMessage(
        `SARIF: restored ${loaded.length} log${loaded.length === 1 ? '' : 's'}`,
        5000,
      );
      return;
    }
  }

  if (config.get<boolean>('autoLoadWorkspaceLogs', false)) {
    await scanWorkspace(store, { silent: true });
  }
}

async function openLog(
  store: SarifStore,
  view: vscode.TreeView<TreeNode>,
  preselected?: readonly vscode.Uri[],
): Promise<void> {
  let uris = preselected;
  if (!uris?.length) {
    uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Open SARIF Log',
      filters: { 'SARIF logs': ['sarif', 'json'], 'All files': ['*'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
  }
  if (!uris?.length) {
    return;
  }
  const { loaded, errors } = await store.loadLogs(uris);
  reportErrors(errors);
  if (loaded.length) {
    const total = loaded.reduce((sum, log) => sum + log.results.length, 0);
    void vscode.window.setStatusBarMessage(
      `SARIF: loaded ${total} result${total === 1 ? '' : 's'} from ${loaded.length} log${
        loaded.length === 1 ? '' : 's'
      }`,
      5000,
    );
    // Bring the view forward so the results are visible right away.
    if (!view.visible) {
      await vscode.commands.executeCommand('workbench.view.extension.sarifViewer');
    }
  }
}

async function scanWorkspace(store: SarifStore, options: { silent: boolean }): Promise<void> {
  const glob = vscode.workspace
    .getConfiguration('sarifViewer')
    .get<string>('workspaceLogGlob', '**/*.{sarif,sarif.json}');
  const found = await vscode.workspace.findFiles(glob, '**/node_modules/**', 100);
  if (!found.length) {
    if (!options.silent) {
      void vscode.window.showInformationMessage(
        `SARIF Viewer: no file matching "${glob}" was found in the workspace.`,
      );
    }
    return;
  }
  const { loaded, errors } = await store.loadLogs(found);
  if (!options.silent) {
    reportErrors(errors);
    void vscode.window.setStatusBarMessage(
      `SARIF: loaded ${loaded.length} log${loaded.length === 1 ? '' : 's'} from the workspace`,
      5000,
    );
  }
}

async function closeLog(store: SarifStore, node?: TreeNode): Promise<void> {
  if (node?.kind === 'log') {
    store.closeLog(node.log.id);
    return;
  }
  const logs = store.logs;
  if (logs.length === 0) {
    return;
  }
  if (logs.length === 1) {
    store.closeLog(logs[0].id);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    logs.map((log) => ({ label: log.label, detail: log.uri.fsPath, id: log.id })),
    { placeHolder: 'Select the SARIF log to close' },
  );
  if (picked) {
    store.closeLog(picked.id);
  }
}

async function pickGrouping(store: SarifStore): Promise<void> {
  const current = store.grouping;
  const options: { label: string; value: Grouping; description: string }[] = [
    { label: 'File', value: 'file', description: 'Group results by source file' },
    { label: 'Rule', value: 'rule', description: 'Group results by rule' },
    { label: 'Severity', value: 'severity', description: 'Group results by severity level' },
    { label: 'None', value: 'none', description: 'Flat list' },
  ];
  const picked = await vscode.window.showQuickPick(
    options.map((option) => ({
      ...option,
      label: option.value === current ? `$(check) ${option.label}` : option.label,
    })),
    { placeHolder: 'Group SARIF results by' },
  );
  if (picked) {
    await updateConfig('grouping', picked.value);
  }
}

async function pickLevels(store: SarifStore): Promise<void> {
  const active = store.filters.levels;
  const items = LEVEL_ORDER.map((level) => ({
    label: level,
    picked: active.has(level),
    level,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Severity levels to show',
  });
  if (picked) {
    await updateConfig('levels', picked.length ? picked.map((item) => item.level) : [...LEVEL_ORDER]);
  }
}

async function pickTextFilter(store: SarifStore): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: 'Show only results whose message, rule or path contains this text',
    value: store.textFilterValue,
    placeHolder: 'Leave empty to clear the filter',
  });
  if (value !== undefined) {
    store.setTextFilter(value);
  }
}

async function updateConfig(key: string, value: unknown): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('sarifViewer').update(key, value, target);
}

function describeView(store: SarifStore, logs: readonly SarifLogFile[]): string | undefined {
  if (logs.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (logs.length === 1) {
    parts.push(logs[0].label);
  }
  const visible = logs.flatMap((log) => store.visibleResults(log));
  parts.push(formatCounts(countLevels(visible)));
  if (store.textFilterValue) {
    parts.push(`filter: "${store.textFilterValue}"`);
  }
  return parts.join(' — ');
}

function reportErrors(errors: readonly string[]): void {
  if (errors.length === 1) {
    void vscode.window.showErrorMessage(`SARIF Viewer: ${errors[0]}`);
  } else if (errors.length > 1) {
    void vscode.window.showErrorMessage(
      `SARIF Viewer: ${errors.length} logs could not be loaded. ${errors[0]}`,
    );
  }
}
