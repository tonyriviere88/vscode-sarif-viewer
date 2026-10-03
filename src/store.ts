import * as vscode from 'vscode';
import {
  Level,
  LEVEL_ORDER,
  SarifLogFile,
  SarifParseError,
  SarifResultItem,
  parseSarifLog,
} from './model';
import { PathResolver } from './pathResolver';
import { regionToRange } from './region';

export type Grouping = 'file' | 'rule' | 'severity' | 'none';

/** Key under which the open logs are remembered, per workspace. */
const OPEN_LOGS_KEY = 'sarifViewer.openLogs';

export interface Filters {
  levels: ReadonlySet<Level>;
  text: string;
  showSuppressed: boolean;
}

/**
 * Holds the loaded logs, the active filters and the derived diagnostics.
 * The tree provider renders whatever this exposes; it never parses anything.
 */
export class SarifStore implements vscode.Disposable {
  readonly resolver = new PathResolver();

  private readonly logsById = new Map<string, SarifLogFile>();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('sarif');
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private textFilter = '';
  private publishToken = 0;
  private disposing = false;

  readonly onDidChange = this.changeEmitter.event;

  /**
   * @param state workspace-scoped storage used to remember which logs were open,
   *   so they come back after a window reload. Omit to disable persistence.
   */
  constructor(private readonly state?: vscode.Memento) {}

  get logs(): SarifLogFile[] {
    return [...this.logsById.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  get isEmpty(): boolean {
    return this.logsById.size === 0;
  }

  get grouping(): Grouping {
    return this.config.get<Grouping>('grouping', 'file');
  }

  get expandGroups(): boolean {
    return this.config.get<boolean>('expandGroups', true);
  }

  get filters(): Filters {
    const levels = this.config.get<Level[]>('levels', [...LEVEL_ORDER]);
    return {
      levels: new Set(levels.length ? levels : LEVEL_ORDER),
      text: this.textFilter,
      showSuppressed: this.config.get<boolean>('showSuppressed', false),
    };
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('sarifViewer');
  }

  setTextFilter(text: string): void {
    this.textFilter = text.trim();
    this.changeEmitter.fire();
  }

  get textFilterValue(): string {
    return this.textFilter;
  }

  /** Applies the active filters to a log's results, keeping the display order. */
  visibleResults(log: SarifLogFile): SarifResultItem[] {
    const { levels, text, showSuppressed } = this.filters;
    const needle = text.toLowerCase();
    return log.results
      .filter((result) => {
        if (!levels.has(result.level)) {
          return false;
        }
        if (result.suppressed && !showSuppressed) {
          return false;
        }
        if (!needle) {
          return true;
        }
        return (
          result.message.toLowerCase().includes(needle) ||
          result.ruleId.toLowerCase().includes(needle) ||
          (result.ruleName?.toLowerCase().includes(needle) ?? false) ||
          (result.primaryLocation?.uri?.toLowerCase().includes(needle) ?? false)
        );
      })
      .sort(compareResults);
  }

  get totalVisible(): number {
    return this.logs.reduce((total, log) => total + this.visibleResults(log).length, 0);
  }

  /** The logs that were open when this workspace was last used. */
  get rememberedLogs(): vscode.Uri[] {
    const stored = this.state?.get<string[]>(OPEN_LOGS_KEY, []) ?? [];
    const uris: vscode.Uri[] = [];
    for (const value of stored) {
      try {
        uris.push(vscode.Uri.parse(value, true));
      } catch {
        // A malformed entry from an older version: skip it.
      }
    }
    return uris;
  }

  private rememberOpenLogs(): void {
    // Never write while shutting down: dispose() closes every log, and
    // persisting that would erase the session we want to restore.
    if (this.disposing || !this.state) {
      return;
    }
    void this.state.update(
      OPEN_LOGS_KEY,
      this.logs.map((log) => log.uri.toString()),
    );
  }

  async loadLog(uri: vscode.Uri): Promise<SarifLogFile> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const log = parseSarifLog(uri, new TextDecoder('utf-8').decode(bytes));
    this.logsById.set(log.id, log);
    this.watch(log);
    this.resolver.clear();
    this.rememberOpenLogs();
    this.changeEmitter.fire();
    void this.publishDiagnostics();
    return log;
  }

  /** Loads several logs, returning the failures instead of throwing. */
  async loadLogs(uris: readonly vscode.Uri[]): Promise<{ loaded: SarifLogFile[]; errors: string[] }> {
    const loaded: SarifLogFile[] = [];
    const errors: string[] = [];
    for (const uri of uris) {
      try {
        loaded.push(await this.loadLog(uri));
      } catch (err) {
        errors.push(
          err instanceof SarifParseError ? err.message : `${uri.fsPath}: ${(err as Error).message}`,
        );
      }
    }
    return { loaded, errors };
  }

  closeLog(id: string): void {
    if (!this.logsById.delete(id)) {
      return;
    }
    this.watchers.get(id)?.dispose();
    this.watchers.delete(id);
    this.resolver.clear();
    this.rememberOpenLogs();
    this.changeEmitter.fire();
    void this.publishDiagnostics();
  }

  closeAll(): void {
    this.logsById.clear();
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
    this.resolver.clear();
    this.diagnostics.clear();
    this.rememberOpenLogs();
    this.changeEmitter.fire();
  }

  async reloadAll(): Promise<string[]> {
    const uris = this.logs.map((log) => log.uri);
    this.logsById.clear();
    this.resolver.clear();
    const { errors } = await this.loadLogs(uris);
    this.changeEmitter.fire();
    return errors;
  }

  /** Re-emits change + diagnostics after a settings change. */
  refresh(): void {
    this.changeEmitter.fire();
    void this.publishDiagnostics();
  }

  private watch(log: SarifLogFile): void {
    if (!this.config.get<boolean>('watchLogs', true) || this.watchers.has(log.id)) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(log.uri, '..'), basename(log.uri)),
    );
    const reload = async () => {
      if (!this.logsById.has(log.id)) {
        return;
      }
      try {
        await this.loadLog(log.uri);
      } catch {
        // A log being rewritten is briefly invalid; the next event will settle it.
      }
    };
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(() => this.closeLog(log.id));
    this.watchers.set(log.id, watcher);
  }

  /**
   * Mirrors the visible results into the Problems panel. URI resolution is
   * async, so a token guards against an older pass overwriting a newer one.
   */
  private async publishDiagnostics(): Promise<void> {
    const token = ++this.publishToken;
    this.diagnostics.clear();
    if (!this.config.get<boolean>('publishDiagnostics', false) || this.isEmpty) {
      return;
    }

    const byUri = new Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }>();
    for (const log of this.logs) {
      for (const result of this.visibleResults(log)) {
        if (!result.primaryLocation?.uri) {
          continue;
        }
        const uri = await this.resolver.resolve(result.primaryLocation, log);
        if (token !== this.publishToken) {
          return;
        }
        if (!uri || uri.scheme !== 'file') {
          continue;
        }
        const diagnostic = new vscode.Diagnostic(
          regionToRange(result.primaryLocation.region).range,
          result.message,
          severityOf(result.level),
        );
        diagnostic.source = `sarif (${result.toolName})`;
        diagnostic.code = result.helpUri
          ? { value: result.ruleId, target: vscode.Uri.parse(result.helpUri) }
          : result.ruleId;
        if (result.suppressed) {
          diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
        }
        diagnostic.relatedInformation = await this.relatedInformation(result, log);
        if (token !== this.publishToken) {
          return;
        }

        const key = uri.toString();
        const bucket = byUri.get(key) ?? { uri, items: [] };
        bucket.items.push(diagnostic);
        byUri.set(key, bucket);
      }
    }

    if (token !== this.publishToken) {
      return;
    }
    for (const { uri, items } of byUri.values()) {
      this.diagnostics.set(uri, items);
    }
  }

  private async relatedInformation(
    result: SarifResultItem,
    log: SarifLogFile,
  ): Promise<vscode.DiagnosticRelatedInformation[]> {
    const related: vscode.DiagnosticRelatedInformation[] = [];
    const sources = [
      ...result.relatedLocations.map((location) => ({ location, label: location.message })),
      ...result.codeFlowSteps.map((step) => ({
        location: step,
        label: `${step.step}. ${step.label}`,
      })),
    ].slice(0, 20);
    for (const { location, label } of sources) {
      const uri = await this.resolver.resolve(location, log);
      if (!uri) {
        continue;
      }
      related.push(
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(uri, regionToRange(location.region).range),
          label ?? 'related location',
        ),
      );
    }
    return related;
  }

  dispose(): void {
    this.disposing = true;
    this.closeAll();
    this.diagnostics.dispose();
    this.changeEmitter.dispose();
  }
}

function compareResults(a: SarifResultItem, b: SarifResultItem): number {
  const byLevel = LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level);
  if (byLevel !== 0) {
    return byLevel;
  }
  const pathA = a.primaryLocation?.uri ?? '';
  const pathB = b.primaryLocation?.uri ?? '';
  const byPath = pathA.localeCompare(pathB);
  if (byPath !== 0) {
    return byPath;
  }
  const lineA = a.primaryLocation?.region?.startLine ?? 0;
  const lineB = b.primaryLocation?.region?.startLine ?? 0;
  if (lineA !== lineB) {
    return lineA - lineB;
  }
  return a.resultIndex - b.resultIndex;
}

function severityOf(level: Level): vscode.DiagnosticSeverity {
  switch (level) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'note':
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Hint;
  }
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1];
}
