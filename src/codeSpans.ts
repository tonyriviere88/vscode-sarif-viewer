/**
 * Finding the code inside a tool message.
 *
 * Compilers quote source constructs in their diagnostics — MSVC and clang both
 * write `see reference to class template instantiation 'rsh::Tool::Foo<T>' being
 * compiled`. Locating those fragments lets the tree emphasise them in the row and
 * render them as a real, syntax-coloured code block in the tooltip.
 */

/** A `[start, end)` range, in the offsets `TreeItemLabel.highlights` expects. */
export type Span = [number, number];

const QUOTED = /'([^'\n]{1,300})'|`([^`\n]{1,300})`/g;

/** Ranges of the quoted code fragments in `message`, in order. */
export function findCodeSpans(message: string): Span[] {
  const spans: Span[] = [];
  for (const match of message.matchAll(QUOTED)) {
    const content = match[1] ?? match[2];
    if (match.index === undefined || !looksLikeCode(content)) {
      continue;
    }
    const start = match.index + 1; // skip the opening quote
    spans.push([start, start + content.length]);
  }
  return spans;
}

/**
 * The distinct quoted code fragments, in the order they appear — one tooltip code
 * block each. A message like `see the first reference to 'X' in 'Y'` names two
 * symbols, and both are worth reading.
 */
export function codeFragments(message: string, limit = 4): string[] {
  const fragments: string[] = [];
  for (const [start, end] of findCodeSpans(message)) {
    const fragment = message.slice(start, end);
    if (!fragments.includes(fragment)) {
      fragments.push(fragment);
    }
    if (fragments.length === limit) {
      break;
    }
  }
  return fragments;
}

/**
 * Tells a quoted code fragment from quoted prose. Compilers quote both: the
 * identifier in `'document' may be undefined` is code, the assertion text in
 * `static_assert failed: 'TValue must be copy constructible'` is a sentence.
 *
 * A single token is taken as code; anything with spaces has to look like a
 * declaration to qualify. Being wrong only costs emphasis, so the rule stays
 * simple rather than trying to parse C++.
 */
function looksLikeCode(content: string): boolean {
  if (!content || content !== content.trim()) {
    // Leading or trailing space usually means an apostrophe in prose was
    // mistaken for an opening quote.
    return false;
  }
  if (!/[A-Za-z_]/.test(content)) {
    return false;
  }
  if (!/\s/.test(content)) {
    return true;
  }
  return /(::|\(|<|\*|&)/.test(content);
}

/**
 * The VS Code language id for a file, so tooltip code blocks are coloured by the
 * same grammar the editor would use. Extension-based because it has to be
 * synchronous — `getTreeItem` cannot wait for a document to open.
 */
export function languageIdFor(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  const extension = /\.([A-Za-z0-9+#]+)(?:[?#].*)?$/.exec(uri)?.[1]?.toLowerCase();
  return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  // C and C++: headers are far more often C++ in practice, and the grammars
  // overlap enough that the colouring holds up either way.
  c: 'c',
  h: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  inl: 'cpp',
  ipp: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  ino: 'cpp',
  m: 'objective-c',
  mm: 'objective-cpp',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  groovy: 'groovy',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  dart: 'dart',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  php: 'php',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  sql: 'sql',
  json: 'json',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  vb: 'vb',
  fs: 'fsharp',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  zig: 'zig',
  proto: 'proto',
  cmake: 'cmake',
  gradle: 'groovy',
  tf: 'terraform',
};

/**
 * Renders a message as markdown, with its code fragments as inline code so the
 * angle brackets and asterisks in a C++ signature survive intact.
 */
export function messageToMarkdown(message: string): string {
  const spans = findCodeSpans(message);
  if (spans.length === 0) {
    return escapeMarkdown(message);
  }
  let result = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    result += escapeMarkdown(message.slice(cursor, start));
    result += inlineCode(message.slice(start, end));
    cursor = end;
  }
  return result + escapeMarkdown(message.slice(cursor));
}

/** Wraps code in a fence longer than any backtick run inside it. */
function inlineCode(code: string): string {
  const longestRun = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${code}${padding}${fence}`;
}

/**
 * Escapes the characters that change inline rendering. Tool messages are always
 * embedded mid-line, so block-level markers (`#`, `-`, `+`) need no escaping and
 * escaping them would only show up as stray backslashes.
 */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]<>|]/g, (char) => `\\${char}`);
}
