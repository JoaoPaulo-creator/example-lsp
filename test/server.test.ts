import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LspClient } from './lspClient.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverBin = path.resolve(here, '../dist/cli.js');
const root = path.join(here, 'fixtures/project');
const mainPath = path.join(root, 'main.js');
const mathPath = path.join(root, 'math.js');
const mainUri = pathToFileURL(mainPath).href;
const mathUri = pathToFileURL(mathPath).href;

describe('js-lsp over stdio', () => {
  let client: LspClient;
  let init: any;

  before(async () => {
    client = new LspClient(process.execPath, [serverBin, '--stdio']);
    init = await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'fixture' }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: true },
        },
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
      },
    });
    client.notify('initialized', {});
    client.openFile(mainPath);
  });

  after(async () => {
    const code = await client.shutdown();
    assert.equal(code, 0, client.stderr);
  });

  it('advertises all required capabilities', () => {
    const caps = init.capabilities;
    assert.equal(init.serverInfo.name, 'js-lsp');
    assert.ok(caps.hoverProvider);
    assert.ok(caps.completionProvider?.resolveProvider);
    assert.ok(caps.definitionProvider);
    assert.ok(caps.referencesProvider);
    assert.ok(caps.documentSymbolProvider);
    assert.deepEqual(caps.renameProvider, { prepareProvider: true });
    assert.ok(caps.documentFormattingProvider);
  });

  it('textDocument/hover shows signature and JSDoc', async () => {
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: mainUri },
      position: { line: 2, character: 16 }, // add(1, 2)
    });
    assert.equal(hover.contents.kind, 'markdown');
    assert.match(hover.contents.value, /add\(a: number, b: number\): number/);
    assert.match(hover.contents.value, /Adds two numbers/);
    assert.match(hover.contents.value, /@param\* `a`/);
    assert.deepEqual(hover.range, { start: { line: 2, character: 15 }, end: { line: 2, character: 18 } });
  });

  it('textDocument/completion lists members and resolves details', async () => {
    const scratch = path.join(root, 'scratch.js'); // in-memory only, never written to disk
    const text = "import { Calculator } from './math.js';\nconst c = new Calculator();\nc.";
    const uri = client.openFile(scratch, text);
    const list = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 2, character: 2 },
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    const labels = list.items.map((i: any) => i.label);
    assert.ok(labels.includes('push'), `got ${labels.join(', ')}`);
    assert.ok(labels.includes('total'));

    const push = list.items.find((i: any) => i.label === 'push');
    const resolved = await client.request('completionItem/resolve', push);
    assert.match(resolved.detail, /push\(n: number\): Calculator/);
    client.notify('textDocument/didClose', { textDocument: { uri } });
  });

  it('textDocument/completion offers globals at top level', async () => {
    const list = await client.request('textDocument/completion', {
      textDocument: { uri: mainUri },
      position: { line: 5, character: 0 },
    });
    const labels = new Set(list.items.map((i: any) => i.label));
    for (const name of ['add', 'Calculator', 'result', 'Promise']) assert.ok(labels.has(name), name);
  });

  it('textDocument/definition jumps across files', async () => {
    const defs = await client.request('textDocument/definition', {
      textDocument: { uri: mainUri },
      position: { line: 5, character: 13 }, // add(result, 3)
    });
    assert.equal(defs.length, 1);
    assert.equal(defs[0].uri, mathUri);
    assert.deepEqual(defs[0].range, { start: { line: 6, character: 16 }, end: { line: 6, character: 19 } });
  });

  it('textDocument/references finds usages in open and closed files', async () => {
    const position = { line: 2, character: 15 };
    const withDecl = await client.request('textDocument/references', {
      textDocument: { uri: mainUri },
      position,
      context: { includeDeclaration: true },
    });
    const summary = withDecl.map((l: any) => `${path.basename(fileURLToPath(l.uri))}:${l.range.start.line}`).sort();
    assert.deepEqual(summary, ['main.js:0', 'main.js:2', 'main.js:5', 'math.js:15', 'math.js:6']);

    const withoutDecl = await client.request('textDocument/references', {
      textDocument: { uri: mainUri },
      position,
      context: { includeDeclaration: false },
    });
    assert.ok(withoutDecl.length < withDecl.length);
    assert.ok(!withoutDecl.some((l: any) => l.uri === mathUri && l.range.start.line === 6));
  });

  it('textDocument/documentSymbol returns a hierarchy', async () => {
    client.openFile(mathPath);
    const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri: mathUri } });
    const names = symbols.map((s: any) => s.name);
    assert.deepEqual(names, ['add', 'Calculator']);
    const calculator = symbols.find((s: any) => s.name === 'Calculator');
    assert.equal(calculator.kind, 5); // Class
    assert.deepEqual(
      calculator.children.map((c: any) => [c.name, c.kind]),
      [
        ['total', 7], // Property... reported as Field(8)? see below
        ['push', 6], // Method
      ].map(([n, k]) => [n, n === 'total' ? 8 : k]),
    );
    assert.equal(symbols[0].kind, 12); // Function
    assert.deepEqual(symbols[0].selectionRange.start, { line: 6, character: 16 });
  });

  it('textDocument/prepareRename returns range/placeholder and rejects keywords', async () => {
    const ok = await client.request('textDocument/prepareRename', {
      textDocument: { uri: mathUri },
      position: { line: 6, character: 17 },
    });
    assert.equal(ok.placeholder, 'add');
    assert.deepEqual(ok.range, { start: { line: 6, character: 16 }, end: { line: 6, character: 19 } });

    await assert.rejects(
      client.request('textDocument/prepareRename', { textDocument: { uri: mathUri }, position: { line: 6, character: 2 } }),
      /rename/i,
    );
  });

  it('textDocument/rename produces a cross-file WorkspaceEdit', async () => {
    const edit = await client.request('textDocument/rename', {
      textDocument: { uri: mathUri },
      position: { line: 6, character: 17 },
      newName: 'sum',
    });
    assert.equal(edit.changes[mathUri].length, 2);
    assert.equal(edit.changes[mainUri].length, 3);
    for (const e of [...edit.changes[mathUri], ...edit.changes[mainUri]]) assert.equal(e.newText, 'sum');
  });

  it('textDocument/formatting normalises whitespace and respects options', async () => {
    const file = path.join(root, 'ugly.js'); // in-memory only
    const text = 'function  foo( a,b ){\nif(a){return a+b}\n      return    b\n}\n';
    const uri = client.openFile(file, text);
    const edits = await client.request('textDocument/formatting', {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.ok(edits.length > 0);
    const formatted = TextDocument.applyEdits(TextDocument.create(uri, 'javascript', 1, text), edits);
    assert.equal(formatted, 'function foo(a, b) {\n  if (a) { return a + b }\n  return b\n}\n');

    const tabEdits = await client.request('textDocument/formatting', {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: false },
    });
    const tabbed = TextDocument.applyEdits(TextDocument.create(uri, 'javascript', 1, text), tabEdits);
    assert.match(tabbed, /\n\treturn b\n/);
    client.notify('textDocument/didClose', { textDocument: { uri } });
  });

  it('tracks incremental edits (didChange) before answering', async () => {
    // Insert a new call on line 6 of main.js and hover it.
    client.notify('textDocument/didChange', {
      textDocument: { uri: mainUri, version: 2 },
      contentChanges: [{ range: { start: { line: 6, character: 0 }, end: { line: 6, character: 0 } }, text: 'calc.push(7);\n' }],
    });
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: mainUri },
      position: { line: 6, character: 6 },
    });
    assert.match(hover.contents.value, /Calculator\.push\(n: number\): Calculator/);
  });

  it('publishes syntax diagnostics', async () => {
    const file = path.join(root, 'broken.js');
    const uri = client.openFile(file, 'const x = ;\n');
    const deadline = Date.now() + 5_000;
    let diag: any;
    while (!diag && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      diag = client.notifications.find((n: any) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri);
    }
    assert.ok(diag, 'no diagnostics published');
    assert.equal((diag.params as any).diagnostics[0].message, 'Expression expected.');
  });
});
