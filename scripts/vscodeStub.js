// A fake `vscode` module, complete enough to activate the extension outside the
// editor: scripts/verify.mjs aliases `vscode` to this file, drives the real
// commands and asserts on what the extension did.
//
// Everything the test needs to observe or steer is exposed on `__test`.

const fs = require('node:fs');

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isEqual(other) {
    return this.line === other.line && this.character === other.character;
  }
  isBefore(other) {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    if (startLine instanceof Position) {
      this.start = startLine;
      this.end = startCharacter;
    } else {
      this.start = new Position(startLine, startCharacter);
      this.end = new Position(endLine, endCharacter);
    }
  }
  get isEmpty() {
    return this.start.isEqual(this.end);
  }
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
}

class Selection extends Range {}

class Uri {
  constructor(scheme, path, query = '', fragment = '') {
    this.scheme = scheme;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }
  static file(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return new Uri('file', normalized.startsWith('/') ? normalized : `/${normalized}`);
  }
  static parse(value) {
    // The query and fragment are not part of the path — `git:/x/y.sarif?ref=HEAD`
    // has path `/x/y.sarif`, which is what path-suffix checks must see.
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!match) {
      return Uri.file(value);
    }
    const [, scheme, rest, query = '', fragment = ''] = match;
    if (scheme === 'file') {
      const { path } = Uri.file(rest.replace(/^\/\//, ''));
      return new Uri('file', path, query, fragment);
    }
    return new Uri(scheme, rest, query, fragment);
  }
  static joinPath(base, ...segments) {
    return new Uri(base.scheme, [base.path.replace(/\/+$/, ''), ...segments].join('/'));
  }
  get fsPath() {
    return this.path.replace(/^\/(?=[a-zA-Z]:)/, '').replace(/\//g, '\\');
  }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString() {
    const query = this.query ? `?${this.query}` : '';
    const fragment = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}://${this.path}${query}${fragment}`;
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value;
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
  appendCodeblock(code, language = '') {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      // The real API's disposable actually removes the listener; a no-op here
      // would silently hide unsubscribe bugs.
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((candidate) => candidate !== listener);
        },
      };
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose() {
    this.listeners = [];
  }
}

/** Observable state + knobs for the test. */
const __test = {
  commands: new Map(),
  executedCommands: [],
  treeViews: [],
  editors: [],
  diagnostics: [],
  diagnosticCollections: [],
  statusMessages: [],
  messages: { info: [], warning: [], error: [] },
  config: {},
  workspaceFolders: undefined,
  /** Canned answer for the next showInputBox / showQuickPick. */
  inputBoxResponse: undefined,
  quickPickResponse: undefined,
  reset() {
    this.commands.clear();
    this.executedCommands = [];
    this.treeViews = [];
    this.editors = [];
    this.diagnostics = [];
    this.statusMessages = [];
    this.messages = { info: [], warning: [], error: [] };
  },
  execute(command, ...args) {
    const handler = this.commands.get(command);
    if (!handler) {
      throw new Error(`command not registered: ${command}`);
    }
    return handler(...args);
  },
  /** Forgets every open document, so a fresh activation sees no editors. */
  closeAllDocuments() {
    workspace.textDocuments = [];
  },
  /** Simulates the user opening a file in an editor. */
  openDocument(uri) {
    const document = makeDocument(uri);
    workspace.textDocuments = [...workspace.textDocuments, document];
    documentOpened.fire(document);
    return document;
  },
  setWorkspaceFolders(paths) {
    this.workspaceFolders = paths.map((folder, index) => ({
      uri: Uri.file(folder),
      name: `folder${index}`,
      index,
    }));
    workspace.workspaceFolders = this.workspaceFolders;
  },
};

const configListeners = new EventEmitter();

function makeDocument(uri) {
  // Only file: URIs come off disk. Virtual documents (git:, output:, ...) get
  // their content from a provider, so an empty buffer is the honest stand-in —
  // and a missing file: still throws, exactly as openTextDocument does.
  const text = uri.scheme === 'file' ? fs.readFileSync(uri.fsPath, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const lastLine = Math.max(lines.length - 1, 0);
  const clamp = (position) => {
    const line = Math.min(Math.max(position.line, 0), lastLine);
    const character = Math.min(Math.max(position.character, 0), lines[line]?.length ?? 0);
    return new Position(line, character);
  };
  return {
    uri,
    fileName: uri.fsPath,
    lineCount: lines.length,
    languageId: 'typescript',
    isDirty: false,
    getText: (range) => (range ? lines[range.start.line]?.slice(range.start.character, range.end.character) ?? '' : text),
    lineAt: (line) => ({
      lineNumber: line,
      text: lines[line] ?? '',
      range: new Range(line, 0, line, lines[line]?.length ?? 0),
    }),
    positionAt: (offset) => {
      let remaining = Math.max(offset, 0);
      for (let line = 0; line < lines.length; line += 1) {
        const width = lines[line].length + 1;
        if (remaining < width) {
          return new Position(line, remaining);
        }
        remaining -= width;
      }
      return new Position(lastLine, lines[lastLine]?.length ?? 0);
    },
    validateRange: (range) => new Range(clamp(range.start), clamp(range.end)),
    validatePosition: clamp,
  };
}

const documentOpened = new EventEmitter();

const workspace = {
  workspaceFolders: undefined,
  textDocuments: [],
  getConfiguration: (section) => ({
    get: (key, fallback) => {
      const full = section ? `${section}.${key}` : key;
      return __test.config[full] !== undefined ? __test.config[full] : fallback;
    },
    update: async (key, value) => {
      __test.config[section ? `${section}.${key}` : key] = value;
      configListeners.fire({ affectsConfiguration: () => true });
    },
  }),
  onDidChangeConfiguration: configListeners.event,
  onDidOpenTextDocument: documentOpened.event,
  onDidCloseTextDocument: new EventEmitter().event,
  onDidChangeTextDocument: new EventEmitter().event,
  fs: {
    stat: async (uri) => {
      const stat = fs.statSync(uri.fsPath); // throws when missing, like the real API
      return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: 0, mtime: 0 };
    },
    readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
  },
  findFiles: async () => [],
  openTextDocument: async (uri) => makeDocument(uri),
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose() {} }),
    onDidCreate: () => ({ dispose() {} }),
    onDidDelete: () => ({ dispose() {} }),
    dispose() {},
  }),
  asRelativePath: (uri, includeWorkspaceFolder) => {
    const fsPath = typeof uri === 'string' ? uri : uri.fsPath;
    for (const folder of workspace.workspaceFolders ?? []) {
      const base = folder.uri.fsPath;
      if (fsPath.toLowerCase().startsWith(`${base.toLowerCase()}\\`)) {
        const relative = fsPath.slice(base.length + 1);
        return includeWorkspaceFolder ? `${folder.name}/${relative}` : relative;
      }
    }
    return fsPath; // outside every folder: the real API returns the full path
  },
};

const window = {
  visibleTextEditors: [],
  activeTextEditor: undefined,
  onDidChangeVisibleTextEditors: new EventEmitter().event,
  onDidChangeActiveTextEditor: new EventEmitter().event,
  createTreeView: (id, options) => {
    const view = {
      id,
      options,
      visible: true,
      description: undefined,
      badge: undefined,
      title: undefined,
      onDidChangeSelection: new EventEmitter().event,
      onDidChangeVisibility: new EventEmitter().event,
      reveal: async () => {},
      dispose() {},
    };
    __test.treeViews.push(view);
    return view;
  },
  // The key must be unique per created type — the real API hands back distinct
  // handles — while staying readable, so tests can match on what it describes.
  createTextEditorDecorationType: (options) => ({
    key: [
      `decoration${(window.__decorationCount = (window.__decorationCount ?? 0) + 1)}`,
      options.isWholeLine ? 'line' : 'range',
      options.borderColor?.id ?? 'nocolor',
      options.borderStyle ?? 'noborder',
    ].join('-'),
    options,
    dispose() {},
  }),
  showTextDocument: async (document, options) => {
    const existing = __test.editors.find((editor) => editor.document.uri.toString() === document.uri.toString());
    const editor =
      existing ??
      {
        document,
        selection: options?.selection,
        revealed: [],
        decorations: new Map(),
        setDecorations(type, ranges) {
          this.decorations.set(type.key, ranges);
        },
        revealRange(range, type) {
          this.revealed.push({ range, type });
        },
      };
    editor.selection = options?.selection ?? editor.selection;
    if (!existing) {
      __test.editors.push(editor);
      window.visibleTextEditors = __test.editors;
    }
    window.activeTextEditor = editor;
    return editor;
  },
  showOpenDialog: async () => undefined,
  showInputBox: async () => __test.inputBoxResponse,
  showQuickPick: async () => __test.quickPickResponse,
  showInformationMessage: async (message) => {
    __test.messages.info.push(message);
    return undefined;
  },
  showWarningMessage: async (message) => {
    __test.messages.warning.push(message);
    return undefined;
  },
  showErrorMessage: async (message) => {
    __test.messages.error.push(message);
    return undefined;
  },
  setStatusBarMessage: (message) => {
    __test.statusMessages.push(message);
    return { dispose() {} };
  },
};

module.exports = {
  __test,
  Position,
  Range,
  Selection,
  Uri,
  MarkdownString,
  EventEmitter,
  workspace,
  window,
  ThemeIcon: (() => {
    class ThemeIcon {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    }
    // The real API exposes these two sentinels, which defer to the icon theme.
    ThemeIcon.File = new ThemeIcon('file');
    ThemeIcon.Folder = new ThemeIcon('folder');
    return ThemeIcon;
  })(),
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  TreeItem: class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  Diagnostic: class Diagnostic {
    constructor(range, message, severity) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  },
  DiagnosticRelatedInformation: class DiagnosticRelatedInformation {
    constructor(location, message) {
      this.location = location;
      this.message = message;
    }
  },
  Location: class Location {
    constructor(uri, range) {
      this.uri = uri;
      this.range = range;
    }
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  languages: {
    createDiagnosticCollection: (name) => {
      const entries = new Map();
      const collection = {
        name,
        entries,
        set(uri, items) {
          entries.set(uri.toString(), items);
          __test.diagnostics.push({ uri, items });
        },
        delete(uri) {
          entries.delete(uri.toString());
        },
        clear() {
          entries.clear();
        },
        dispose() {},
      };
      __test.diagnosticCollections.push(collection);
      return collection;
    },
  },
  commands: {
    registerCommand: (command, handler) => {
      __test.commands.set(command, handler);
      return { dispose: () => __test.commands.delete(command) };
    },
    executeCommand: async (command, ...args) => {
      __test.executedCommands.push({ command, args });
      return undefined;
    },
  },
  env: {
    clipboard: {
      value: '',
      async writeText(text) {
        this.value = text;
      },
      async readText() {
        return this.value;
      },
    },
    openExternal: async () => true,
  },
};
