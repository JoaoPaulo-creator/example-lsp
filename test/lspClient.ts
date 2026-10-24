import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Minimal LSP client speaking JSON-RPC with Content-Length framing over a child process' stdio. */
export class LspClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  readonly notifications: { method: string; params: unknown }[] = [];
  stderr = '';

  constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: 'pipe' });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => (this.stderr += chunk.toString()));
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  openFile(filePath: string, text = readFileSync(filePath, 'utf8')): string {
    const uri = pathToFileURL(filePath).href;
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: 1, text } });
    return uri;
  }

  async shutdown(): Promise<number | null> {
    await this.request('shutdown', null);
    this.notify('exit', null);
    return new Promise((resolve) => this.proc.once('exit', (code) => resolve(code)));
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString());
      if (!match) throw new Error('Missing Content-Length header');
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const message = JSON.parse(this.buffer.subarray(start, start + length).toString('utf8'));
      this.buffer = this.buffer.subarray(start + length);
      this.dispatch(message);
    }
  }

  private dispatch(message: any): void {
    if ('id' in message && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else pending.resolve(message.result);
    } else if ('id' in message) {
      // Server → client request (e.g. client/registerCapability): acknowledge it.
      this.send({ jsonrpc: '2.0', id: message.id, result: null });
    } else {
      this.notifications.push({ method: message.method, params: message.params });
    }
  }
}
