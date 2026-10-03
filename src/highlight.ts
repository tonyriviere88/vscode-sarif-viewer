import * as vscode from 'vscode';
import { Level } from './model';

type DecorationKey = `${Level}|${'line' | 'range'}` | 'related' | 'flow';

export interface HighlightRange {
  range: vscode.Range;
  wholeLine: boolean;
  kind: 'primary' | 'related' | 'flow';
  hoverMessage?: vscode.MarkdownString | string;
}

interface Highlight {
  documentUri: string;
  level: Level;
  primary: readonly HighlightRange[];
  secondary: readonly HighlightRange[];
}

/**
 * Owns the editor decorations that mark the selected result.
 *
 * Only one result is highlighted at a time. Decorations belong to a
 * `TextEditor`, not to a document, so the current highlight is kept and
 * re-applied whenever the document shows up in another editor (split, reopened
 * tab); editors showing anything else are wiped, since an editor that was
 * merely hidden keeps its decorations.
 */
export class HighlightManager implements vscode.Disposable {
  private readonly types = new Map<DecorationKey, vscode.TextEditorDecorationType>();
  private current?: Highlight;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          if (editor.document.uri.toString() === this.current?.documentUri) {
            this.paint(editor, this.current);
          } else {
            this.wipe(editor);
          }
        }
      }),
    );
  }

  /** Replaces every current highlight with the given ranges in `editor`. */
  apply(
    editor: vscode.TextEditor,
    level: Level,
    primary: readonly HighlightRange[],
    secondary: readonly HighlightRange[] = [],
  ): void {
    this.clear();
    this.current = { documentUri: editor.document.uri.toString(), level, primary, secondary };
    this.paint(editor, this.current);
  }

  clear(): void {
    this.current = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      this.wipe(editor);
    }
  }

  private paint(editor: vscode.TextEditor, highlight: Highlight): void {
    const buckets = new Map<DecorationKey, vscode.DecorationOptions[]>();
    const add = (key: DecorationKey, item: HighlightRange) => {
      const list = buckets.get(key) ?? [];
      list.push({ range: item.range, hoverMessage: item.hoverMessage });
      buckets.set(key, list);
    };

    for (const item of highlight.primary) {
      add(`${highlight.level}|${item.wholeLine ? 'line' : 'range'}`, item);
    }
    for (const item of highlight.secondary) {
      add(item.kind === 'flow' ? 'flow' : 'related', item);
    }

    // Types not in `buckets` must be reset explicitly, or the previous
    // highlight's decorations linger in this editor.
    for (const [key, type] of this.types) {
      editor.setDecorations(type, buckets.get(key) ?? []);
    }
    for (const [key, options] of buckets) {
      if (!this.types.has(key)) {
        editor.setDecorations(this.decorationType(key), options);
      }
    }
  }

  private wipe(editor: vscode.TextEditor): void {
    for (const type of this.types.values()) {
      editor.setDecorations(type, []);
    }
  }

  private decorationType(key: DecorationKey): vscode.TextEditorDecorationType {
    const existing = this.types.get(key);
    if (existing) {
      return existing;
    }
    const created = vscode.window.createTextEditorDecorationType(optionsFor(key));
    this.types.set(key, created);
    return created;
  }

  dispose(): void {
    this.clear();
    for (const type of this.types.values()) {
      type.dispose();
    }
    this.types.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function optionsFor(key: DecorationKey): vscode.DecorationRenderOptions {
  if (key === 'related' || key === 'flow') {
    return {
      isWholeLine: false,
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
      borderWidth: '0 0 1px 0',
      borderStyle: key === 'flow' ? 'dashed' : 'dotted',
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
    };
  }

  const [level, shape] = key.split('|') as [Level, 'line' | 'range'];
  const accent = new vscode.ThemeColor(accentColorId(level));
  return {
    isWholeLine: shape === 'line',
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    borderWidth: shape === 'line' ? '0 0 0 3px' : '0 0 2px 0',
    borderStyle: 'solid',
    borderColor: accent,
    borderRadius: shape === 'line' ? '0' : '2px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    overviewRulerColor: accent,
  };
}

function accentColorId(level: Level): string {
  switch (level) {
    case 'error':
      return 'editorError.foreground';
    case 'warning':
      return 'editorWarning.foreground';
    default:
      return 'editorInfo.foreground';
  }
}
