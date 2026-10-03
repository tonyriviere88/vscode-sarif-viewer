/**
 * Hand-rolled subset of the SARIF 2.1.0 schema (OASIS standard), covering only
 * the properties this viewer reads. Everything is optional on purpose: logs in
 * the wild are frequently incomplete, so the loader must never assume a shape.
 */

export type Level = 'none' | 'note' | 'warning' | 'error';

export type Kind = 'notApplicable' | 'pass' | 'fail' | 'review' | 'open' | 'informational';

export interface Log {
  $schema?: string;
  version?: string;
  runs?: Run[];
}

export interface Run {
  tool?: Tool;
  results?: Result[];
  artifacts?: Artifact[];
  originalUriBaseIds?: Record<string, ArtifactLocation>;
  invocations?: Invocation[];
  automationDetails?: { id?: string; description?: Message };
  columnKind?: 'utf16CodeUnits' | 'unicodeCodePoints';
}

export interface Tool {
  driver?: ToolComponent;
  extensions?: ToolComponent[];
}

export interface ToolComponent {
  name?: string;
  fullName?: string;
  version?: string;
  semanticVersion?: string;
  informationUri?: string;
  rules?: ReportingDescriptor[];
}

export interface ReportingDescriptor {
  id?: string;
  name?: string;
  shortDescription?: MultiformatMessageString;
  fullDescription?: MultiformatMessageString;
  help?: MultiformatMessageString;
  helpUri?: string;
  defaultConfiguration?: { level?: Level; enabled?: boolean; rank?: number };
  messageStrings?: Record<string, MultiformatMessageString>;
  properties?: Record<string, unknown>;
}

export interface MultiformatMessageString {
  text?: string;
  markdown?: string;
}

export interface Message {
  text?: string;
  markdown?: string;
  id?: string;
  arguments?: string[];
}

export interface Invocation {
  commandLine?: string;
  executionSuccessful?: boolean;
  startTimeUtc?: string;
  endTimeUtc?: string;
  workingDirectory?: ArtifactLocation;
}

export interface Artifact {
  location?: ArtifactLocation;
  description?: Message;
  mimeType?: string;
  roles?: string[];
}

export interface ArtifactLocation {
  uri?: string;
  uriBaseId?: string;
  index?: number;
  description?: Message;
}

export interface Region {
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  charOffset?: number;
  charLength?: number;
  byteOffset?: number;
  byteLength?: number;
  snippet?: ArtifactContent;
  message?: Message;
}

export interface ArtifactContent {
  text?: string;
  binary?: string;
  rendered?: MultiformatMessageString;
}

export interface PhysicalLocation {
  artifactLocation?: ArtifactLocation;
  region?: Region;
  contextRegion?: Region;
}

export interface LogicalLocation {
  name?: string;
  fullyQualifiedName?: string;
  decoratedName?: string;
  kind?: string;
}

export interface Location {
  id?: number;
  physicalLocation?: PhysicalLocation;
  logicalLocations?: LogicalLocation[];
  message?: Message;
  annotations?: Region[];
}

export interface ReportingDescriptorReference {
  id?: string;
  index?: number;
  guid?: string;
  toolComponent?: { name?: string; index?: number };
}

export interface Suppression {
  kind?: 'inSource' | 'external';
  status?: 'accepted' | 'underReview' | 'rejected';
  justification?: string;
}

export interface ThreadFlowLocation {
  location?: Location;
  module?: string;
  nestingLevel?: number;
  executionOrder?: number;
  importance?: 'important' | 'essential' | 'unimportant';
  state?: Record<string, unknown>;
}

export interface ThreadFlow {
  id?: string;
  message?: Message;
  locations?: ThreadFlowLocation[];
}

export interface CodeFlow {
  message?: Message;
  threadFlows?: ThreadFlow[];
}

export interface Result {
  ruleId?: string;
  ruleIndex?: number;
  rule?: ReportingDescriptorReference;
  level?: Level;
  kind?: Kind;
  message?: Message;
  locations?: Location[];
  relatedLocations?: Location[];
  analysisTarget?: ArtifactLocation;
  codeFlows?: CodeFlow[];
  suppressions?: Suppression[];
  baselineState?: 'new' | 'unchanged' | 'updated' | 'absent';
  rank?: number;
  hostedViewerUri?: string;
  fingerprints?: Record<string, string>;
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
}
