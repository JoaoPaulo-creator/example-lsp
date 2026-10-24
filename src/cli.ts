#!/usr/bin/env node
import { ProposedFeatures, createConnection } from 'vscode-languageserver/node';
import { SERVER_NAME, SERVER_VERSION, startServer } from './server.js';

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `Usage: ${SERVER_NAME} [--stdio]\n\n` +
      'Starts the JavaScript language server, speaking LSP (JSON-RPC) over stdin/stdout.\n' +
      'Options:\n  --stdio     Use stdio transport (default)\n  --version   Print version\n  --help      Show this help\n',
  );
  process.exit(0);
}

// stdout is reserved for the protocol: redirect accidental console output to stderr.
console.log = console.error;
console.info = console.error;

// Default to stdio when no transport flag is given (Neovim launches `js-lsp --stdio`).
if (!args.some((a) => a === '--stdio' || a.startsWith('--node-ipc') || a.startsWith('--socket') || a.startsWith('--pipe'))) {
  process.argv.push('--stdio');
}

const connection = createConnection(ProposedFeatures.all);
startServer(connection);
connection.listen();
