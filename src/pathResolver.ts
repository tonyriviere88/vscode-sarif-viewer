import * as vscode from 'vscode';
import { SarifLocation, SarifLogFile, basenameOfUri, decodeUriComponentSafe } from './model';

/**
 * Turns a SARIF artifact URI into a URI that actually exists on this machine.
 *
 * SARIF logs are produced on build agents, so their URIs are routinely
 * relative, rooted at a `uriBaseId` we have to guess, or absolute paths from
 * another filesystem. Resolution is therefore a series of candidates, tried in
 * order of trustworthiness, with the outcome cached per log.
 */
export class PathResolver {
  private readonly cache = new Map<string, vscode.Uri | null>();
  /** Basename -> workspace matches, populated lazily by the last-resort search. */
  private readonly basenameIndex = new Map<string, vscode.Uri[]>();

  clear(): void {
    this.cache.clear();
    this.basenameIndex.clear();
  }

  async resolve(location: SarifLocation, log: SarifLogFile): Promise<vscode.Uri | undefined> {
    if (!location.uri) {
      return undefined;
    }
    const key = `${log.id}|${location.uriBaseId ?? ''}|${location.uri}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const resolved = await this.resolveUncached(location, log);
    this.cache.set(key, resolved ?? null);
    return resolved;
  }

  private async resolveUncached(
    location: SarifLocation,
    log: SarifLogFile,
  ): Promise<vscode.Uri | undefined> {
    const raw = location.uri!;

    // Non-file schemes we cannot map onto the filesystem, but can still open.
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)?.[1]?.toLowerCase();
    if (scheme && scheme !== 'file' && scheme.length > 1) {
      try {
        return vscode.Uri.parse(raw, true);
      } catch {
        return undefined;
      }
    }

    for (const candidate of this.candidates(location, log)) {
      if (await exists(candidate)) {
        return candidate;
      }
    }

    // Last resort: the log points somewhere that does not exist locally, so look
    // the file up by name inside the workspace.
    return this.findInWorkspace(raw);
  }

  private candidates(location: SarifLocation, log: SarifLogFile): vscode.Uri[] {
    const raw = location.uri!;
    const candidates: vscode.Uri[] = [];
    const push = (uri: vscode.Uri | undefined) => {
      if (uri && !candidates.some((existing) => existing.toString() === uri.toString())) {
        candidates.push(uri);
      }
    };

    if (raw.toLowerCase().startsWith('file:')) {
      try {
        push(vscode.Uri.parse(raw, true));
      } catch {
        /* fall through to the path-based candidates */
      }
    }

    const relative = normalizeRelative(raw);
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(relative) || relative.startsWith('/');
    if (isAbsolute) {
      push(vscode.Uri.file(relative));
      // An absolute path from another machine: keep trimming leading segments and
      // rebase what is left onto the local roots (a common CI-vs-local mismatch).
      for (const root of this.roots(log, location)) {
        for (const suffix of suffixes(relative)) {
          push(joinPath(root, suffix));
        }
      }
      return candidates;
    }

    for (const root of this.roots(log, location)) {
      push(joinPath(root, relative));
    }
    return candidates;
  }

  /** Roots to resolve relative URIs against, most specific first. */
  private roots(log: SarifLogFile, location: SarifLocation): vscode.Uri[] {
    const roots: vscode.Uri[] = [];
    const push = (uri: vscode.Uri | undefined) => {
      if (uri && !roots.some((existing) => existing.toString() === uri.toString())) {
        roots.push(uri);
      }
    };

    // 1. The uriBaseId declared by the run, when it maps to a real local path.
    if (location.uriBaseId) {
      for (const run of log.runs) {
        const base = run.originalUriBaseIds?.[location.uriBaseId];
        const baseUri = base?.uri;
        if (baseUri) {
          push(toDirectoryUri(baseUri));
        }
      }
    }
    // 2. Any other declared base, in case the id does not match.
    for (const run of log.runs) {
      for (const base of Object.values(run.originalUriBaseIds ?? {})) {
        if (base?.uri) {
          push(toDirectoryUri(base.uri));
        }
      }
    }
    // 3. Workspace folders.
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      push(folder.uri);
    }
    // 4. The directory holding the log itself, and its parent.
    const logDir = dirnameUri(log.uri);
    push(logDir);
    push(dirnameUri(logDir));
    return roots;
  }

  private async findInWorkspace(raw: string): Promise<vscode.Uri | undefined> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return undefined;
    }
    const basename = basenameOfUri(raw);
    if (!basename || basename.includes('*')) {
      return undefined;
    }
    let matches = this.basenameIndex.get(basename);
    if (!matches) {
      matches = await vscode.workspace.findFiles(
        `**/${escapeGlob(basename)}`,
        '**/{node_modules,.git,out,dist,bin,obj}/**',
        32,
      );
      this.basenameIndex.set(basename, matches);
    }
    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length === 1) {
      return matches[0];
    }
    // Several files share the name: prefer the one whose tail matches the log's
    // path most closely.
    const wanted = normalizeRelative(raw).replace(/\\/g, '/').toLowerCase();
    let best = matches[0];
    let bestScore = -1;
    for (const match of matches) {
      const score = commonSuffixLength(match.path.toLowerCase(), wanted);
      if (score > bestScore) {
        bestScore = score;
        best = match;
      }
    }
    return best;
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Strips a `file:` prefix, decodes escapes and drops leading `./` segments. */
function normalizeRelative(raw: string): string {
  let value = raw;
  if (/^file:/i.test(value)) {
    value = value.replace(/^file:(\/\/)?/i, '');
    // file:///C:/x -> C:/x
    value = value.replace(/^\/(?=[a-zA-Z]:)/, '');
  }
  value = decodeUriComponentSafe(value.split(/[?#]/)[0]);
  value = value.replace(/^\.\//, '');
  return value;
}

function toDirectoryUri(raw: string): vscode.Uri | undefined {
  const normalized = normalizeRelative(raw);
  if (!normalized) {
    return undefined;
  }
  try {
    return vscode.Uri.file(normalized.replace(/[\\/]+$/, ''));
  } catch {
    return undefined;
  }
}

function joinPath(root: vscode.Uri, relative: string): vscode.Uri | undefined {
  const segments = relative.split(/[\\/]/).filter((segment) => segment && segment !== '.');
  if (segments.length === 0) {
    return undefined;
  }
  try {
    return vscode.Uri.joinPath(root, ...segments);
  } catch {
    return undefined;
  }
}

/** `a/b/c.ts` -> [`b/c.ts`, `c.ts`], used to rebase foreign absolute paths. */
function suffixes(absolutePath: string): string[] {
  const segments = absolutePath.split(/[\\/]/).filter(Boolean);
  const result: string[] = [];
  // Skip the drive letter / root, and keep the search bounded.
  for (let start = 1; start < segments.length && result.length < 12; start += 1) {
    result.push(segments.slice(start).join('/'));
  }
  return result;
}

function dirnameUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: uri.path.replace(/\/[^/]*$/, '') || '/' });
}

function escapeGlob(value: string): string {
  return value.replace(/[[\]{}?*]/g, (char) => `[${char}]`);
}

function commonSuffixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[a.length - 1 - length] === b[b.length - 1 - length]) {
    length += 1;
  }
  return length;
}
