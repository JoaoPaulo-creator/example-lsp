import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  type CompletionItem,
  type CompletionList,
  type Connection,
  type Definition,
  type DocumentSymbol,
  type FormattingOptions,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type LocationLink,
  type Position,
  type Range,
  type SymbolInformation,
  type TextEdit,
  type WorkspaceEdit,
  CompletionItemTag,
  DiagnosticSeverity,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  InsertTextFormat,
  MarkupKind,
  ResponseError,
  TextDocumentSyncKind,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { toCompletionItemKind, toMarkdown, toSymbolKind } from './convert.js';
import { Project, normalizePath } from './project.js';

export const SERVER_NAME = 'js-lsp';
export const SERVER_VERSION = '0.1.0';

/** User-tunable settings, passed via `init_options` (initializationOptions) in Neovim. */
export interface ServerSettings {
  checkJs?: boolean;
  diagnostics?: boolean;
  format?: ts.FormatCodeSettings;
}

interface CompletionData {
  fileName: string;
  offset: number;
  name: string;
  source: string | undefined;
  data: ts.CompletionEntryData | undefined;
}

const TS_TRIGGER_CHARACTERS = new Set<string>(['.', '"', "'", '`', '/', '@', '<', '#', ' ']);
const DIAGNOSTIC_DEBOUNCE_MS = 200;

/** Wires every LSP handler onto the given connection. Call `connection.listen()` afterwards. */
export function startServer(connection: Connection): void {
  const documents = new TextDocuments(TextDocument);
  let project: Project | undefined;
  let settings: ServerSettings = {};
  let linkSupport = false;
  let hierarchicalSymbols = false;
  let watchRegistration = false;
  const diagnosticTimers = new Map<string, NodeJS.Timeout>();

  const log = (message: string): void => connection.console.log(`[${SERVER_NAME}] ${message}`);

  const uriToPath = (uri: string): string => normalizePath(fileURLToPath(uri));
  const pathToUri = (fileName: string): string => pathToFileURL(fileName).href;

  const getProject = (): Project => {
    if (!project) throw new ResponseError(-32002, 'Server not initialized');
    return project;
  };

  // ---------- position helpers (LSP & TypeScript both use UTF-16 offsets) ----------

  const toOffset = (fileName: string, position: Position): number => {
    const doc = getProject().getOpenDocument(fileName);
    if (doc) return doc.offsetAt(position);
    const sf = getProject().getSourceFile(fileName);
    if (!sf) throw new ResponseError(-32602, `Unknown file: ${fileName}`);
    return sf.getPositionOfLineAndCharacter(position.line, position.character);
  };

  const toPosition = (fileName: string, offset: number): Position => {
    const doc = getProject().getOpenDocument(fileName);
    if (doc) return doc.positionAt(offset);
    const sf = getProject().getSourceFile(fileName);
    if (sf) return sf.getLineAndCharacterOfPosition(offset);
    const text = ts.sys.readFile(fileName) ?? '';
    return TextDocument.create('', 'javascript', 0, text).positionAt(offset);
  };

  const toRange = (fileName: string, span: ts.TextSpan): Range => ({
    start: toPosition(fileName, span.start),
    end: toPosition(fileName, span.start + span.length),
  });

  const toLocation = (fileName: string, span: ts.TextSpan): Location => ({
    uri: pathToUri(fileName),
    range: toRange(fileName, span),
  });

  const formatSettings = (options?: FormattingOptions): ts.FormatCodeSettings => ({
    ...ts.getDefaultFormatCodeSettings('\n'),
    indentStyle: ts.IndentStyle.Smart,
    insertSpaceAfterOpeningAndBeforeClosingEmptyBraces: false,
    semicolons: ts.SemicolonPreference.Ignore,
    ...settings.format,
    ...(options && {
      tabSize: options.tabSize,
      indentSize: options.tabSize,
      convertTabsToSpaces: options.insertSpaces,
    }),
  });

  const userPreferences = (): ts.UserPreferences => ({
    includeCompletionsForModuleExports: true,
    includeCompletionsForImportStatements: true,
    includeCompletionsWithInsertText: true,
    includeCompletionsWithSnippetText: true,
    includeAutomaticOptionalChainCompletions: true,
    includeCompletionsWithClassMemberSnippets: true,
    allowIncompleteCompletions: true,
    importModuleSpecifierPreference: 'shortest',
    importModuleSpecifierEnding: 'auto',
    providePrefixAndSuffixTextForRename: true,
    allowRenameOfImportPath: false,
    quotePreference: 'auto',
  });

  /** Wraps a handler so analysis failures are logged instead of crashing the server. */
  const safely =
    <P, R>(name: string, fallback: R, fn: (params: P) => R) =>
    (params: P): R => {
      try {
        return fn(params);
      } catch (error) {
        if (error instanceof ResponseError) throw error;
        log(`${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        return fallback;
      }
    };

  // ---------- diagnostics (bonus: syntax always, semantics when checkJs is on) ----------

  const publishDiagnostics = (uri: string): void => {
    if (settings.diagnostics === false || !project) return;
    const fileName = uriToPath(uri);
    const doc = project.getOpenDocument(fileName);
    if (!doc) return;
    const svc = project.service;
    const diags: ts.Diagnostic[] = [...svc.getSyntacticDiagnostics(fileName)];
    if (svc.getProgram()?.getCompilerOptions().checkJs) diags.push(...svc.getSemanticDiagnostics(fileName));
    void connection.sendDiagnostics({
      uri,
      version: doc.version,
      diagnostics: diags.map((d) => ({
        range: toRange(fileName, { start: d.start ?? 0, length: d.length ?? 0 }),
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        severity:
          d.category === ts.DiagnosticCategory.Error
            ? DiagnosticSeverity.Error
            : d.category === ts.DiagnosticCategory.Warning
              ? DiagnosticSeverity.Warning
              : DiagnosticSeverity.Information,
        code: d.code,
        source: SERVER_NAME,
      })),
    });
  };

  const scheduleDiagnostics = (uri: string): void => {
    clearTimeout(diagnosticTimers.get(uri));
    diagnosticTimers.set(
      uri,
      setTimeout(() => {
        diagnosticTimers.delete(uri);
        safely('diagnostics', undefined, publishDiagnostics)(uri);
      }, DIAGNOSTIC_DEBOUNCE_MS),
    );
  };

  // ---------- lifecycle ----------

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    settings = (params.initializationOptions ?? {}) as ServerSettings;
    const caps = params.capabilities;
    linkSupport = caps.textDocument?.definition?.linkSupport ?? false;
    hierarchicalSymbols = caps.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport ?? false;
    watchRegistration = caps.workspace?.didChangeWatchedFiles?.dynamicRegistration ?? false;

    const rootUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    const rootPath = rootUri ? uriToPath(rootUri) : undefined;
    project = new Project({ rootPath, checkJs: settings.checkJs ?? false, log });
    log(`TypeScript ${ts.version}; root: ${rootPath ?? '(none)'}`);

    return {
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: {
        textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: false },
        hoverProvider: true,
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: ['.', '"', "'", '`', '/', '@', '<', '#'],
        },
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: { label: SERVER_NAME },
        renameProvider: { prepareProvider: true },
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
      },
    };
  });

  connection.onInitialized(() => {
    if (watchRegistration) {
      void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [{ globPattern: '**/*.{js,jsx,mjs,cjs,d.ts}' }, { globPattern: '**/{jsconfig,tsconfig,package}.json' }],
      });
    }
  });

  connection.onShutdown(() => {
    for (const timer of diagnosticTimers.values()) clearTimeout(timer);
    project?.dispose();
    project = undefined;
  });

  // ---------- document sync ----------

  documents.onDidOpen(({ document }) => {
    getProject().openOrUpdate(uriToPath(document.uri), document);
    scheduleDiagnostics(document.uri);
  });
  documents.onDidChangeContent(({ document }) => {
    getProject().openOrUpdate(uriToPath(document.uri), document);
    scheduleDiagnostics(document.uri);
  });
  documents.onDidClose(({ document }) => {
    clearTimeout(diagnosticTimers.get(document.uri));
    getProject().close(uriToPath(document.uri));
    void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  });

  connection.onDidChangeWatchedFiles(({ changes }) => {
    if (!project) return;
    for (const change of changes) {
      const kind =
        change.type === FileChangeType.Created ? 'created' : change.type === FileChangeType.Deleted ? 'deleted' : 'changed';
      project.fileChangedOnDisk(uriToPath(change.uri), kind);
    }
    for (const doc of documents.all()) scheduleDiagnostics(doc.uri);
  });

  // ---------- hover ----------

  connection.onHover(
    safely('hover', null, ({ textDocument, position }): Hover | null => {
      const fileName = uriToPath(textDocument.uri);
      const info = getProject().service.getQuickInfoAtPosition(fileName, toOffset(fileName, position));
      if (!info) return null;
      const value = toMarkdown(info.displayParts, info.documentation, info.tags);
      if (!value) return null;
      return { contents: { kind: MarkupKind.Markdown, value }, range: toRange(fileName, info.textSpan) };
    }),
  );

  // ---------- completion ----------

  connection.onCompletion(
    safely('completion', null, ({ textDocument, position, context }): CompletionList | null => {
      const fileName = uriToPath(textDocument.uri);
      const offset = toOffset(fileName, position);
      const trigger = context?.triggerCharacter;
      const result = getProject().service.getCompletionsAtPosition(fileName, offset, {
        ...userPreferences(),
        ...(trigger && TS_TRIGGER_CHARACTERS.has(trigger) && { triggerCharacter: trigger as ts.CompletionsTriggerCharacter }),
        triggerKind: context?.triggerKind as ts.CompletionTriggerKind | undefined,
      });
      if (!result) return null;

      const items = result.entries.map((entry): CompletionItem => {
        const item: CompletionItem = {
          label: entry.name,
          kind: toCompletionItemKind(entry.kind),
          sortText: entry.sortText,
          data: { fileName, offset, name: entry.name, source: entry.source, data: entry.data } satisfies CompletionData,
        };
        if (entry.labelDetails) item.labelDetails = entry.labelDetails;
        else if (entry.source && entry.hasAction) item.labelDetails = { description: entry.source };
        if (entry.kindModifiers?.includes('deprecated')) item.tags = [CompletionItemTag.Deprecated];
        if (entry.filterText) item.filterText = entry.filterText;
        if (entry.isSnippet) item.insertTextFormat = InsertTextFormat.Snippet;
        const newText = entry.insertText ?? entry.name;
        const span = entry.replacementSpan ?? result.optionalReplacementSpan;
        if (span) item.textEdit = { range: toRange(fileName, span), newText };
        else if (entry.insertText) item.insertText = entry.insertText;
        return item;
      });
      return { isIncomplete: result.isIncomplete ?? false, items };
    }),
  );

  connection.onCompletionResolve(
    safely('completionResolve', null as unknown as CompletionItem, (item: CompletionItem): CompletionItem => {
      const data = item.data as CompletionData | undefined;
      if (!data) return item;
      const details = getProject().service.getCompletionEntryDetails(
        data.fileName,
        data.offset,
        data.name,
        formatSettings(),
        data.source,
        userPreferences(),
        data.data,
      );
      if (!details) return item;
      item.detail = ts.displayPartsToString(details.displayParts);
      const docs = toMarkdown(undefined, details.documentation, details.tags, false);
      if (docs) item.documentation = { kind: MarkupKind.Markdown, value: docs };
      // Auto-import edits and the like.
      const edits: TextEdit[] = [];
      for (const action of details.codeActions ?? []) {
        for (const change of action.changes) {
          if (normalizePath(change.fileName) !== data.fileName) continue;
          for (const tc of change.textChanges) edits.push({ range: toRange(data.fileName, tc.span), newText: tc.newText });
        }
      }
      if (edits.length) item.additionalTextEdits = edits;
      return item;
    }),
  );

  // ---------- definition ----------

  connection.onDefinition(
    safely('definition', null, ({ textDocument, position }): Definition | LocationLink[] | null => {
      const fileName = uriToPath(textDocument.uri);
      const result = getProject().service.getDefinitionAndBoundSpan(fileName, toOffset(fileName, position));
      if (!result?.definitions?.length) return null;
      if (linkSupport) {
        const originSelectionRange = toRange(fileName, result.textSpan);
        return result.definitions.map((def) => {
          const target = normalizePath(def.fileName);
          const targetSelectionRange = toRange(target, def.textSpan);
          return {
            originSelectionRange,
            targetUri: pathToUri(target),
            targetRange: def.contextSpan ? toRange(target, def.contextSpan) : targetSelectionRange,
            targetSelectionRange,
          };
        });
      }
      return result.definitions.map((def) => toLocation(normalizePath(def.fileName), def.textSpan));
    }),
  );

  // ---------- references ----------

  connection.onReferences(
    safely('references', null, ({ textDocument, position, context }): Location[] | null => {
      const fileName = uriToPath(textDocument.uri);
      const symbols = getProject().service.findReferences(fileName, toOffset(fileName, position));
      if (!symbols) return null;
      const seen = new Set<string>();
      const locations: Location[] = [];
      for (const symbol of symbols) {
        const def = symbol.definition;
        for (const ref of symbol.references) {
          // TS >= 5.x no longer sets ReferenceEntry.isDefinition; compare against the group's definition span.
          const isDeclaration =
            ref.fileName === def.fileName &&
            ref.textSpan.start === def.textSpan.start &&
            ref.textSpan.length === def.textSpan.length;
          if (!context.includeDeclaration && isDeclaration) continue;
          const key = `${ref.fileName}:${ref.textSpan.start}`;
          if (seen.has(key)) continue;
          seen.add(key);
          locations.push(toLocation(normalizePath(ref.fileName), ref.textSpan));
        }
      }
      return locations;
    }),
  );

  // ---------- document symbols ----------

  connection.onDocumentSymbol(
    safely('documentSymbol', null, ({ textDocument }): DocumentSymbol[] | SymbolInformation[] | null => {
      const fileName = uriToPath(textDocument.uri);
      const tree = getProject().service.getNavigationTree(fileName);

      // getNavigationTree sorts alphabetically; editors expect source order.
      const byPosition = (a: DocumentSymbol, b: DocumentSymbol): number =>
        a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
      const convert = (node: ts.NavigationTree): DocumentSymbol | undefined => {
        const [first] = node.spans;
        if (!first || !node.text || node.text === '<function>') return undefined;
        const range = toRange(fileName, {
          start: Math.min(...node.spans.map((s) => s.start)),
          length: Math.max(...node.spans.map((s) => s.start + s.length)) - Math.min(...node.spans.map((s) => s.start)),
        });
        const children = (node.childItems ?? []).map(convert).filter((c): c is DocumentSymbol => !!c).sort(byPosition);
        const symbol: DocumentSymbol = {
          name: node.text,
          kind: toSymbolKind(node.kind),
          range,
          selectionRange: node.nameSpan ? toRange(fileName, node.nameSpan) : range,
          children,
        };
        if (node.kindModifiers) symbol.detail = node.kindModifiers;
        return symbol;
      };

      // The root node is the module/script itself; expose its children.
      const symbols = (tree.childItems ?? []).map(convert).filter((s): s is DocumentSymbol => !!s).sort(byPosition);
      if (hierarchicalSymbols) return symbols;

      const flat: SymbolInformation[] = [];
      const walk = (list: DocumentSymbol[], container?: string): void => {
        for (const s of list) {
          flat.push({
            name: s.name,
            kind: s.kind,
            location: { uri: textDocument.uri, range: s.selectionRange },
            ...(container && { containerName: container }),
          });
          walk(s.children ?? [], s.name);
        }
      };
      walk(symbols);
      return flat;
    }),
  );

  // ---------- rename ----------

  connection.onPrepareRename(({ textDocument, position }) => {
    const fileName = uriToPath(textDocument.uri);
    const offset = toOffset(fileName, position);
    const info = getProject().service.getRenameInfo(fileName, offset, userPreferences());
    if (!info.canRename) throw new ResponseError(-32803, info.localizedErrorMessage);
    // TS resolves keywords like `export`/`function` to the declared symbol; only allow renaming on the name itself.
    const { start, length } = info.triggerSpan;
    if (offset < start || offset > start + length) {
      throw new ResponseError(-32803, 'You cannot rename this element: cursor is not on an identifier.');
    }
    return { range: toRange(fileName, info.triggerSpan), placeholder: info.displayName };
  });

  connection.onRenameRequest(({ textDocument, position, newName }): WorkspaceEdit | null => {
    const fileName = uriToPath(textDocument.uri);
    const offset = toOffset(fileName, position);
    const svc = getProject().service;
    const info = svc.getRenameInfo(fileName, offset, userPreferences());
    if (!info.canRename) throw new ResponseError(-32803, info.localizedErrorMessage);
    const locations = svc.findRenameLocations(fileName, offset, false, false, userPreferences());
    if (!locations) return null;
    const changes: Record<string, TextEdit[]> = {};
    for (const loc of locations) {
      const target = normalizePath(loc.fileName);
      const uri = pathToUri(target);
      (changes[uri] ??= []).push({
        range: toRange(target, loc.textSpan),
        newText: `${loc.prefixText ?? ''}${newName}${loc.suffixText ?? ''}`,
      });
    }
    return { changes };
  });

  // ---------- formatting ----------

  connection.onDocumentFormatting(
    safely('formatting', null, ({ textDocument, options }): TextEdit[] | null => {
      const fileName = uriToPath(textDocument.uri);
      const edits = getProject().service.getFormattingEditsForDocument(fileName, formatSettings(options));
      return edits.map((e) => ({ range: toRange(fileName, e.span), newText: e.newText }));
    }),
  );

  connection.onDocumentRangeFormatting(
    safely('rangeFormatting', null, ({ textDocument, range, options }): TextEdit[] | null => {
      const fileName = uriToPath(textDocument.uri);
      const edits = getProject().service.getFormattingEditsForRange(
        fileName,
        toOffset(fileName, range.start),
        toOffset(fileName, range.end),
        formatSettings(options),
      );
      return edits.map((e) => ({ range: toRange(fileName, e.span), newText: e.newText }));
    }),
  );

  documents.listen(connection);
}
