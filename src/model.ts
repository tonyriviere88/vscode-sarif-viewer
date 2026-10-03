import * as path from 'path';
import * as vscode from 'vscode';
import * as Sarif from './sarifTypes';

export type Level = Sarif.Level;

export const LEVEL_ORDER: Level[] = ['error', 'warning', 'note', 'none'];

export function levelRank(level: Level): number {
  const index = LEVEL_ORDER.indexOf(level);
  return index === -1 ? LEVEL_ORDER.length : index;
}

/** A location, normalized away from the SARIF artifact/uriBaseId indirection. */
export interface SarifLocation {
  /** Raw `artifactLocation.uri` as written in the log (may be relative). */
  uri?: string;
  uriBaseId?: string;
  region?: Sarif.Region;
  /** Location-level message, e.g. the label of a code flow step. */
  message?: string;
  logicalName?: string;
  snippet?: string;
}

export type LocationKind = 'primary' | 'related' | 'flow';

export interface SarifLocationRef extends SarifLocation {
  kind: LocationKind;
  /** 1-based step number inside a code flow. */
  step?: number;
  label: string;
}

export interface SarifResultItem {
  /** Stable identity: log id + run index + result index. */
  id: string;
  logId: string;
  runIndex: number;
  resultIndex: number;
  ruleId: string;
  ruleName?: string;
  ruleShortDescription?: string;
  helpUri?: string;
  toolName: string;
  level: Level;
  kind: Sarif.Kind;
  message: string;
  suppressed: boolean;
  baselineState?: string;
  /** First physical location, if any: what the tree row points at. */
  primaryLocation?: SarifLocation;
  locations: SarifLocation[];
  relatedLocations: SarifLocation[];
  /** Flattened thread flow steps of the first code flow. */
  codeFlowSteps: SarifLocationRef[];
  /** Owning log, for path resolution. */
  log: SarifLogFile;
}

export interface RunInfo {
  toolName: string;
  toolVersion?: string;
  originalUriBaseIds?: Record<string, Sarif.ArtifactLocation>;
  artifacts: Sarif.Artifact[];
  informationUri?: string;
}

export interface SarifLogFile {
  id: string;
  uri: vscode.Uri;
  label: string;
  runs: RunInfo[];
  results: SarifResultItem[];
  /** Non-fatal problems found while reading the log. */
  warnings: string[];
}

export class SarifParseError extends Error {}

export function parseSarifLog(uri: vscode.Uri, raw: string): SarifLogFile {
  let json: Sarif.Log;
  try {
    json = JSON.parse(stripBom(raw)) as Sarif.Log;
  } catch (err) {
    throw new SarifParseError(`${uri.fsPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!json || typeof json !== 'object') {
    throw new SarifParseError(`${uri.fsPath} does not contain a SARIF object.`);
  }
  if (!Array.isArray(json.runs)) {
    throw new SarifParseError(`${uri.fsPath} has no "runs" array — is it a SARIF log?`);
  }

  const log: SarifLogFile = {
    id: uri.toString(),
    uri,
    label: path.basename(uri.fsPath),
    runs: [],
    results: [],
    warnings: [],
  };

  json.runs.forEach((run, runIndex) => {
    const driver = run.tool?.driver;
    const runInfo: RunInfo = {
      toolName: driver?.name ?? driver?.fullName ?? 'Unknown tool',
      toolVersion: driver?.semanticVersion ?? driver?.version,
      originalUriBaseIds: run.originalUriBaseIds,
      artifacts: run.artifacts ?? [],
      informationUri: driver?.informationUri,
    };
    log.runs.push(runInfo);

    const rules = collectRules(run);
    const results = run.results ?? [];
    results.forEach((result, resultIndex) => {
      log.results.push(convertResult(log, run, runInfo, rules, result, runIndex, resultIndex));
    });
  });

  return log;
}

interface RuleIndex {
  byId: Map<string, Sarif.ReportingDescriptor>;
  byIndex: Sarif.ReportingDescriptor[];
}

function collectRules(run: Sarif.Run): RuleIndex {
  const byIndex = run.tool?.driver?.rules ?? [];
  const byId = new Map<string, Sarif.ReportingDescriptor>();
  const components = [run.tool?.driver, ...(run.tool?.extensions ?? [])];
  for (const component of components) {
    for (const rule of component?.rules ?? []) {
      if (rule.id && !byId.has(rule.id)) {
        byId.set(rule.id, rule);
      }
    }
  }
  return { byId, byIndex };
}

function convertResult(
  log: SarifLogFile,
  run: Sarif.Run,
  runInfo: RunInfo,
  rules: RuleIndex,
  result: Sarif.Result,
  runIndex: number,
  resultIndex: number,
): SarifResultItem {
  const ruleId = result.ruleId ?? result.rule?.id ?? '';
  const ruleIndex = result.ruleIndex ?? result.rule?.index;
  const rule =
    (typeof ruleIndex === 'number' ? rules.byIndex[ruleIndex] : undefined) ??
    (ruleId ? rules.byId.get(ruleId) : undefined);

  const locations = (result.locations ?? [])
    .map((location) => toLocation(run, location))
    .filter((location): location is SarifLocation => location !== undefined);
  const relatedLocations = (result.relatedLocations ?? [])
    .map((location) => toLocation(run, location))
    .filter((location): location is SarifLocation => location !== undefined);

  return {
    id: `${log.id}#${runIndex}.${resultIndex}`,
    logId: log.id,
    runIndex,
    resultIndex,
    ruleId: ruleId || rule?.id || '(no rule id)',
    ruleName: rule?.name,
    ruleShortDescription: rule?.shortDescription?.text ?? rule?.fullDescription?.text,
    helpUri: rule?.helpUri ?? result.hostedViewerUri,
    toolName: runInfo.toolName,
    level: effectiveLevel(result, rule),
    kind: result.kind ?? 'fail',
    message: resolveMessage(result, rule),
    suppressed: isSuppressed(result),
    baselineState: result.baselineState,
    primaryLocation: locations[0],
    locations,
    relatedLocations,
    codeFlowSteps: collectCodeFlowSteps(run, result),
    log,
  };
}

/** SARIF 2.1.0 §3.27.10: level falls back to the rule configuration, then to the kind. */
function effectiveLevel(result: Sarif.Result, rule?: Sarif.ReportingDescriptor): Level {
  if (result.level) {
    return result.level;
  }
  const kind = result.kind ?? 'fail';
  if (kind !== 'fail') {
    return 'none';
  }
  return rule?.defaultConfiguration?.level ?? 'warning';
}

function isSuppressed(result: Sarif.Result): boolean {
  const suppressions = result.suppressions ?? [];
  if (suppressions.length === 0) {
    return false;
  }
  // A suppression that was rejected does not suppress anything.
  return suppressions.some((suppression) => suppression.status !== 'rejected');
}

/**
 * Resolves `message.text`, or a `messageStrings` entry referenced by
 * `message.id`, then substitutes the {0}, {1}... placeholders.
 */
function resolveMessage(result: Sarif.Result, rule?: Sarif.ReportingDescriptor): string {
  const message = result.message;
  let text = message?.text;
  if (!text && message?.id && rule?.messageStrings) {
    text = rule.messageStrings[message.id]?.text;
  }
  if (!text) {
    text = message?.markdown ?? rule?.shortDescription?.text ?? '(no message)';
  }
  const args = message?.arguments;
  if (args && args.length > 0) {
    text = text.replace(/\{(\d+)\}/g, (match, digits: string) => {
      const value = args[Number(digits)];
      return value === undefined ? match : value;
    });
  }
  return collapseWhitespace(text);
}

function toLocation(run: Sarif.Run, location?: Sarif.Location): SarifLocation | undefined {
  if (!location) {
    return undefined;
  }
  const physical = location.physicalLocation;
  const artifactLocation = resolveArtifactLocation(run, physical?.artifactLocation);
  const logical = location.logicalLocations?.[0];
  const logicalName = logical?.fullyQualifiedName ?? logical?.name;
  if (!artifactLocation?.uri && !logicalName) {
    return undefined;
  }
  return {
    uri: artifactLocation?.uri,
    uriBaseId: artifactLocation?.uriBaseId,
    region: physical?.region ?? physical?.contextRegion,
    message: location.message?.text ? collapseWhitespace(location.message.text) : undefined,
    logicalName,
    snippet: physical?.region?.snippet?.text?.trim(),
  };
}

/** Follows `artifactLocation.index` into `run.artifacts` when the uri is absent. */
function resolveArtifactLocation(
  run: Sarif.Run,
  artifactLocation?: Sarif.ArtifactLocation,
): Sarif.ArtifactLocation | undefined {
  if (!artifactLocation) {
    return undefined;
  }
  if (artifactLocation.uri) {
    return artifactLocation;
  }
  if (typeof artifactLocation.index === 'number') {
    const artifact = run.artifacts?.[artifactLocation.index];
    if (artifact?.location?.uri) {
      return artifact.location;
    }
  }
  return artifactLocation;
}

function collectCodeFlowSteps(run: Sarif.Run, result: Sarif.Result): SarifLocationRef[] {
  const threadFlows = result.codeFlows?.flatMap((flow) => flow.threadFlows ?? []) ?? [];
  const steps: SarifLocationRef[] = [];
  for (const threadFlow of threadFlows) {
    for (const threadFlowLocation of threadFlow.locations ?? []) {
      const location = toLocation(run, threadFlowLocation.location);
      if (!location) {
        continue;
      }
      const step = steps.length + 1;
      steps.push({
        ...location,
        kind: 'flow',
        step,
        label: location.message ?? location.logicalName ?? describeLocation(location),
      });
    }
  }
  return steps;
}

export function describeLocation(location: SarifLocation): string {
  const name = location.uri ? basenameOfUri(location.uri) : location.logicalName ?? 'unknown';
  const line = location.region?.startLine;
  return line ? `${name}:${line}` : name;
}

export function basenameOfUri(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0];
  const parts = withoutQuery.split(/[\\/]/);
  return decodeUriComponentSafe(parts[parts.length - 1] || withoutQuery);
}

export function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** Counts per level, used for the badges shown on group and log rows. */
export interface LevelCounts {
  error: number;
  warning: number;
  note: number;
  none: number;
}

export function countLevels(results: readonly SarifResultItem[]): LevelCounts {
  const counts: LevelCounts = { error: 0, warning: 0, note: 0, none: 0 };
  for (const result of results) {
    counts[result.level] += 1;
  }
  return counts;
}

export function highestLevel(results: readonly SarifResultItem[]): Level {
  let best: Level = 'none';
  for (const result of results) {
    if (levelRank(result.level) < levelRank(best)) {
      best = result.level;
    }
  }
  return best;
}

export function formatCounts(counts: LevelCounts): string {
  const parts: string[] = [];
  if (counts.error) {
    parts.push(`${counts.error} error${counts.error === 1 ? '' : 's'}`);
  }
  if (counts.warning) {
    parts.push(`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`);
  }
  const informational = counts.note + counts.none;
  if (informational) {
    parts.push(`${informational} note${informational === 1 ? '' : 's'}`);
  }
  return parts.join(', ') || 'no results';
}
