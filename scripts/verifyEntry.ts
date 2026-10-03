// Bundle entry for scripts/verify.mjs: re-exports the logic under test plus the
// stubbed `vscode` module (aliased at bundle time), so the test can both drive
// the extension and observe what it did.
import * as vscode from 'vscode';

export { activate, deactivate } from '../src/extension';
export { parseSarifLog, countLevels, formatCounts, highestLevel, levelRank } from '../src/model';
export { regionToRange, formatPosition } from '../src/region';
export { findCodeSpans, codeFragments, languageIdFor, messageToMarkdown } from '../src/codeSpans';
export { vscode };
