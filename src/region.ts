import * as vscode from 'vscode';
import * as Sarif from './sarifTypes';

export interface ResolvedRegion {
  range: vscode.Range;
  /** True when the region carried no column information, so the whole line applies. */
  wholeLine: boolean;
}

/**
 * Converts a SARIF text region to a VS Code range.
 *
 * SARIF lines and columns are 1-based, and `endColumn` points at the character
 * *after* the region (§3.30.6), whereas VS Code positions are 0-based with an
 * exclusive end — so both ends need adjusting. A missing `endLine` means the
 * region ends on `startLine`; a missing `endColumn` means it ends at the end of
 * that line.
 */
export function regionToRange(
  region: Sarif.Region | undefined,
  document?: vscode.TextDocument,
): ResolvedRegion {
  if (!region) {
    return { range: new vscode.Range(0, 0, 0, 0), wholeLine: true };
  }

  // Character-offset regions: only resolvable against the real document.
  if (region.startLine === undefined && region.charOffset !== undefined && document) {
    const start = document.positionAt(region.charOffset);
    const end = document.positionAt(region.charOffset + (region.charLength ?? 0));
    return { range: new vscode.Range(start, end), wholeLine: region.charLength === undefined };
  }

  const startLine = Math.max((region.startLine ?? 1) - 1, 0);
  const endLine = Math.max((region.endLine ?? region.startLine ?? 1) - 1, startLine);
  const hasColumns = region.startColumn !== undefined || region.endColumn !== undefined;

  const startCharacter = Math.max((region.startColumn ?? 1) - 1, 0);
  let endCharacter: number;
  if (region.endColumn !== undefined) {
    endCharacter = Math.max(region.endColumn - 1, 0);
  } else if (document && endLine < document.lineCount) {
    endCharacter = document.lineAt(endLine).range.end.character;
  } else {
    // No document to measure against: a large sentinel is clamped by validateRange.
    endCharacter = Number.MAX_SAFE_INTEGER;
  }

  let range = new vscode.Range(startLine, startCharacter, endLine, endCharacter);
  if (document) {
    range = document.validateRange(range);
    // A zero-length region (an insertion point) reads better as the whole line.
    if (range.isEmpty && !hasColumns) {
      range = document.lineAt(range.start.line).range;
    }
  }
  return { range, wholeLine: !hasColumns };
}

/**
 * Formats a region's start the way the Problems view labels a diagnostic:
 * `Ln 12, Col 5`. Like that view, only the start is shown — the extent of a
 * multi-line region is conveyed by the highlight, not by the label.
 */
export function formatPosition(region: Sarif.Region | undefined): string | undefined {
  if (!region) {
    return undefined;
  }
  if (region.startLine === undefined) {
    return region.charOffset !== undefined ? `Offset ${region.charOffset}` : undefined;
  }
  return region.startColumn !== undefined
    ? `Ln ${region.startLine}, Col ${region.startColumn}`
    : `Ln ${region.startLine}`;
}
