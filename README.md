# js-lsp

A JavaScript language server for **Neovim**, written in TypeScript. It speaks plain LSP over stdio (JSON-RPC), the transport Neovim's built-in `vim.lsp` client uses. You don't need a VS Code extension host. Code analysis comes from the TypeScript compiler's `LanguageService`, set up for JavaScript.

## Features

| Feature | LSP method | Notes |
|---|---|---|
| Hover | `textDocument/hover` | Signature as Markdown, JSDoc text, `@param`/`@returns` |
| Completion | `textDocument/completion`, `completionItem/resolve` | Members, scope and globals, auto-import edits; details loaded lazily on resolve |
| Go to definition | `textDocument/definition` | Works across files; returns `LocationLink` when the client supports it |
| Find references | `textDocument/references` | Covers open and unopened files, and honours `includeDeclaration` |
| Document symbols | `textDocument/documentSymbol` | Nested `DocumentSymbol` tree in source order (flat list for older clients) |
| Rename | `textDocument/prepareRename`, `textDocument/rename` | Cross-file `WorkspaceEdit`; refuses keywords and other non-identifiers |
| Formatting | `textDocument/formatting`, `textDocument/rangeFormatting` | Respects `tabSize` / `insertSpaces` |
| Diagnostics | `textDocument/publishDiagnostics` | Syntax errors; semantic errors when `checkJs` is enabled |

## Requirements

- Node.js **24 LTS** or newer (`engines.node >= 24`)
- Neovim **0.11+** recommended (0.10 works through the `vim.lsp.start` fallback)

## Build and install

```sh
npm ci
npm run build     # compiles src/ to dist/
npm test          # starts the server over stdio and tests every feature
npm link          # optional: puts `js-lsp` on your $PATH
```

`js-lsp --version` and `js-lsp --help` both work. The server reads stdio by default, and `--stdio` is also accepted.

## Neovim setup

**Option A (0.11+, recommended):** copy `nvim/lsp/js_lsp.lua` to `~/.config/nvim/lsp/js_lsp.lua`, then add this to `init.lua`:

```lua
vim.lsp.enable('js_lsp')
```

**Option B:** paste or `dofile` `nvim/init_snippet.lua`. It uses `vim.lsp.config` / `vim.lsp.enable` when they exist and falls back to `vim.lsp.start` otherwise. It also adds `LspAttach` keymaps and native autocompletion.

If you skipped `npm link`, point `cmd` at the build: `{ 'node', '/abs/path/js_lsp/dist/cli.js', '--stdio' }`.

Neovim 0.11+ already maps `K` (hover), `grn` (rename), `grr` (references), `gO` (symbols) and `<C-x><C-o>` (completion). Run `:checkhealth vim.lsp` to confirm the server attached.

## Project configuration

- Reads `jsconfig.json` (or `tsconfig.json`) from the project root when there is one.
- Without a config, it finds `*.js, *.mjs, *.cjs, *.jsx` files itself (up to 5,000; skips `node_modules`, `.git`, `dist`, `build` and `coverage`).
- Defaults: `allowJs`, `target`/`module: esnext`, and `checkJs: false`. To get type errors, turn on `"checkJs": true` in `jsconfig.json` or add `// @ts-check` to a file.
- Installed `@types/*` packages (such as `@types/node`) are picked up automatically.

### Rename behaviour

- Renaming at a **declaration** updates every file that uses it.
- Renaming at an **imported name** gives `import { add as sum }`, so only the current file changes. VS Code and tsserver do the same by default.

## Design notes

- **Why TypeScript:** it gives typed LSP definitions (`vscode-languageserver`) and direct access to the TypeScript compiler API. That API powers JS tooling in every major editor.
- **Why plain LSP over stdio:** Neovim's client implements the spec directly and needs no editor-specific glue. The `vscode-languageserver` package is only the JSON-RPC/LSP transport and doesn't depend on VS Code.
- **TypeScript version:** pinned to `~6.0`. TypeScript 7 is the native Go port and doesn't ship the JavaScript `LanguageService` API used here.

## Layout

```
src/cli.ts       entry point (stdio transport, --version/--help)
src/server.ts    LSP capabilities and request handlers
src/project.ts   LanguageServiceHost: in-memory documents, config loading, file scan
src/convert.ts   TS -> LSP conversions (kinds, Markdown for hover/completion)
test/            stdio integration tests (node:test) and fixtures
nvim/            Neovim configuration
```
