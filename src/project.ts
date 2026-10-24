import path from 'node:path';
import ts from 'typescript';
import type { TextDocument } from 'vscode-languageserver-textdocument';

/** File extensions handled by this server. */
export const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'] as const;

/** Upper bound on files discovered by directory scan when there is no jsconfig/tsconfig. */
const MAX_INFERRED_FILES = 5_000;

const EXCLUDES = ['**/node_modules', '**/.git', '**/dist', '**/build', '**/coverage'];

export interface ProjectOptions {
  /** Absolute workspace root (may be undefined for single-file mode). */
  rootPath: string | undefined;
  /** Enable semantic type checking for JS files when no config overrides it. */
  checkJs: boolean;
  log: (message: string) => void;
}

/** Normalises a filesystem path to the forward-slash form the TypeScript API uses. */
export function normalizePath(p: string): string {
  return path.resolve(p).replaceAll('\\', '/');
}

/** Defaults tailored for JavaScript; any value from jsconfig.json/tsconfig.json wins. */
function defaultCompilerOptions(checkJs: boolean): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs,
    noEmit: true,
    skipLibCheck: true,
    maxNodeModuleJsDepth: 2,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    // TS 6 defaults `types` to []; restore automatic @types inclusion (e.g. @types/node).
    types: ['*'],
  };
}

/**
 * A single TypeScript LanguageService backed by an in-memory view of open documents,
 * falling back to disk for everything else.
 */
export class Project {
  readonly service: ts.LanguageService;
  private readonly documents = new Map<string, TextDocument>();
  private readonly diskVersions = new Map<string, number>();
  private projectVersion = 0;
  private rootFiles: string[] = [];
  private compilerOptions: ts.CompilerOptions = {};
  private configFile: string | undefined;

  constructor(private readonly options: ProjectOptions) {
    this.loadConfig();
    const host: ts.LanguageServiceHost = {
      getProjectVersion: () => String(this.projectVersion),
      getCompilationSettings: () => this.compilerOptions,
      getScriptFileNames: () => {
        const names = new Set(this.rootFiles);
        for (const file of this.documents.keys()) names.add(file);
        return [...names];
      },
      getScriptVersion: (fileName) => {
        const doc = this.documents.get(fileName);
        return doc ? `open:${doc.version}` : `disk:${this.diskVersions.get(fileName) ?? 0}`;
      },
      getScriptSnapshot: (fileName) => {
        const doc = this.documents.get(fileName);
        if (doc) return ts.ScriptSnapshot.fromString(doc.getText());
        const text = ts.sys.readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getScriptKind: (fileName) => scriptKindFor(fileName),
      getCurrentDirectory: () => this.options.rootPath ?? process.cwd(),
      getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
      fileExists: (fileName) => this.documents.has(fileName) || ts.sys.fileExists(fileName),
      readFile: (fileName, encoding) => this.documents.get(fileName)?.getText() ?? ts.sys.readFile(fileName, encoding),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => '\n',
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames));
  }

  get configPath(): string | undefined {
    return this.configFile;
  }

  /** (Re)reads jsconfig.json / tsconfig.json and the list of root files. */
  loadConfig(): void {
    const { rootPath, checkJs, log } = this.options;
    const defaults = defaultCompilerOptions(checkJs);
    this.configFile = undefined;
    this.compilerOptions = defaults;
    this.rootFiles = [];

    if (!rootPath) return this.bump();

    const configFile = ['jsconfig.json', 'tsconfig.json']
      .map((name) => normalizePath(path.join(rootPath, name)))
      .find((candidate) => ts.sys.fileExists(candidate));

    if (configFile) {
      const { config, error } = ts.readConfigFile(configFile, ts.sys.readFile);
      if (error) {
        log(`Failed to read ${configFile}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
      } else {
        const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configFile), defaults, configFile);
        this.configFile = configFile;
        // Always keep JS support on, even if a tsconfig.json omits it.
        this.compilerOptions = { ...parsed.options, allowJs: true, noEmit: true };
        this.rootFiles = parsed.fileNames.map(normalizePath);
        log(`Loaded ${configFile} (${this.rootFiles.length} files)`);
        return this.bump();
      }
    }

    // Inferred project: scan the workspace for JS files (bounded).
    const found = ts.sys.readDirectory(rootPath, [...JS_EXTENSIONS], EXCLUDES, ['**/*']);
    if (found.length > MAX_INFERRED_FILES) {
      log(`Workspace has ${found.length} JS files (> ${MAX_INFERRED_FILES}); using open files only. Add a jsconfig.json to scope it.`);
    } else {
      this.rootFiles = found.map(normalizePath);
      log(`Inferred project at ${rootPath} (${this.rootFiles.length} files)`);
    }
    this.bump();
  }

  openOrUpdate(fileName: string, doc: TextDocument): void {
    this.documents.set(fileName, doc);
    this.bump();
  }

  close(fileName: string): void {
    this.documents.delete(fileName);
    this.diskVersions.set(fileName, (this.diskVersions.get(fileName) ?? 0) + 1);
    this.bump();
  }

  /** Notifies the project that a file changed on disk (watched-files notification). */
  fileChangedOnDisk(fileName: string, kind: 'created' | 'changed' | 'deleted'): void {
    const base = path.basename(fileName);
    if (base === 'jsconfig.json' || base === 'tsconfig.json' || base === 'package.json') {
      this.loadConfig();
      return;
    }
    this.diskVersions.set(fileName, (this.diskVersions.get(fileName) ?? 0) + 1);
    if (!this.configFile && kind !== 'changed' && isJsFile(fileName)) {
      if (kind === 'created' && !this.rootFiles.includes(fileName)) this.rootFiles.push(fileName);
      if (kind === 'deleted') this.rootFiles = this.rootFiles.filter((f) => f !== fileName);
    }
    this.bump();
  }

  getOpenDocument(fileName: string): TextDocument | undefined {
    return this.documents.get(fileName);
  }

  /** Returns a SourceFile for any file known to the program (used for offset ↔ position on closed files). */
  getSourceFile(fileName: string): ts.SourceFile | undefined {
    return this.service.getProgram()?.getSourceFile(fileName);
  }

  dispose(): void {
    this.service.dispose();
  }

  private bump(): void {
    this.projectVersion++;
  }
}

export function isJsFile(fileName: string): boolean {
  return (JS_EXTENSIONS as readonly string[]).includes(path.extname(fileName).toLowerCase());
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.json':
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.Unknown;
  }
}
