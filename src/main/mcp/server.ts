import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { KEYS, type KeyName, type McpTools } from './tools';

// Streamable HTTP on 127.0.0.1 only, stateless: every POST gets a fresh McpServer.
// Nothing here is reachable from another machine, and on this one a caller needs
// the bearer token from Settings. The Host check stops a web page from using DNS
// rebinding to reach the port through the user's browser.

export interface McpHttpServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface McpServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  token: string;
  tools: McpTools;
  version: string;
}

const INSTRUCTIONS = `OtherSSH is the user's SSH client on Windows. These tools work on the running app.
- list_sessions shows saved sessions; list_tabs shows the tabs open right now.
- Only sessions the user has ticked "Allow AI assistants" on can be opened, read, typed into, run on or uploaded to.
- Prefer run_command for a one-off command whose output you need: it runs in the background, separately from any tab, and returns the exit code.
- Use open_tab, send_input and read_tab to work in a terminal the user can watch, or for interactive programs.
- Never type passwords or sudo passwords. If something needs one, stop and ask the user to do that step.`;

const KEY_NAMES = Object.keys(KEYS) as [KeyName, ...KeyName[]];

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

/** Run a tool and turn its refusals into an error result the AI can read, rather than a protocol error. */
async function result(work: () => Promise<string>) {
  try {
    return text(await work());
  } catch (err) {
    return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
  }
}

export function buildMcpServer(tools: McpTools, version: string): McpServer {
  const server = new McpServer({ name: 'otherssh', version }, { instructions: INSTRUCTIONS });
  const session = z.string().describe('A saved session: its id or its exact name, from list_sessions.');
  const tab = z.string().describe('An open tab id, from list_tabs or open_tab.');

  server.registerTool(
    'list_sessions',
    { description: 'List the saved SSH sessions in OtherSSH, and whether each allows AI assistants.', annotations: { readOnlyHint: true } },
    () => result(() => tools.listSessions()),
  );

  server.registerTool(
    'list_tabs',
    { description: 'List the terminal tabs open in OtherSSH right now, across all its windows.', annotations: { readOnlyHint: true } },
    () => result(() => tools.listTabs()),
  );

  server.registerTool(
    'open_tab',
    {
      description: 'Connect to a saved session in a new tab in OtherSSH, where the user can watch. Returns the tab id and the first screen.',
      inputSchema: { session },
    },
    ({ session }) => result(() => tools.openTab(session)),
  );

  server.registerTool(
    'read_tab',
    {
      description: "Read a tab's terminal as plain text: the last `lines` lines of scrollback and screen.",
      inputSchema: { tab, lines: z.number().int().min(1).max(2000).optional().describe('How many lines from the bottom (default 100).') },
      annotations: { readOnlyHint: true },
    },
    ({ tab, lines }) => result(() => tools.readTab(tab, lines)),
  );

  server.registerTool(
    'send_input',
    {
      description:
        'Type into a tab as if at the keyboard, then return the bottom of the screen after a short wait. ' +
        'Text is followed by Enter unless press_enter is false; keys are pressed after the text, in order.',
      inputSchema: {
        tab,
        text: z.string().optional().describe('Text to type. Newlines become Enter.'),
        press_enter: z.boolean().optional().describe('Press Enter after the text (default true).'),
        keys: z.array(z.enum(KEY_NAMES)).optional().describe('Special keys to press after the text, e.g. ["ctrl_c"] or ["escape"].'),
        wait_ms: z.number().int().min(0).max(30000).optional().describe('How long to wait before reading the screen back (default 1000).'),
      },
      annotations: { destructiveHint: true },
    },
    ({ tab, text: typed, press_enter, keys, wait_ms }) =>
      result(() => tools.sendInput(tab, { text: typed, pressEnter: press_enter, keys, waitMs: wait_ms })),
  );

  server.registerTool(
    'close_tab',
    { description: 'Close a tab in OtherSSH, ending its connection.', inputSchema: { tab }, annotations: { destructiveHint: true } },
    ({ tab }) => result(() => tools.closeTab(tab)),
  );

  server.registerTool(
    'run_command',
    {
      description:
        'Run one shell command on a saved session in the background (no tab, no terminal, no stdin) and return its exit code and output. ' +
        'Logs in with key or agent only; a host that needs a typed password fails.',
      inputSchema: {
        session,
        command: z.string().describe('The command line, run by the login shell on the server.'),
        timeout_s: z.number().int().min(1).max(300).optional().describe('Stop it after this many seconds (default 30).'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ session, command, timeout_s }) => result(() => tools.runCommand(session, command, timeout_s)),
  );

  server.registerTool(
    'upload_file',
    {
      description: 'Copy local files or folders from this Windows PC to a folder on a saved session, with scp.',
      inputSchema: {
        session,
        local_paths: z.array(z.string()).min(1).describe('Absolute Windows paths of files or folders to send.'),
        remote_dir: z.string().describe('Folder on the server to put them in, e.g. ~/uploads or /srv/app.'),
      },
      annotations: { destructiveHint: true },
    },
    ({ session, local_paths, remote_dir }) => result(() => tools.uploadFile(session, local_paths, remote_dir)),
  );

  return server;
}

export const TOKEN_HELP =
  'OtherSSH needs the header "Authorization: Bearer <token>". Copy the header value from OtherSSH Settings, ' +
  'AI assistants (MCP), add it to this server in your AI tool, and refresh. There is no sign-in to do.';

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function rpcError(message: string) {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null };
}

export function startMcpServer(opts: McpServerOptions): Promise<McpHttpServer> {
  let port = opts.port;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendJson(res, 403, rpcError('Forbidden host'));
    if ((req.url ?? '').split('?')[0] !== '/mcp') return sendJson(res, 404, rpcError('Not found: the MCP endpoint is /mcp'));
    // 403, not 401: MCP clients take a 401 as "start an OAuth sign-in", which OtherSSH doesn't have,
    // and then show a sign-in error instead of this message.
    if (!tokenMatches(req.headers.authorization, opts.token)) return sendJson(res, 403, rpcError(TOKEN_HELP));
    if (req.method !== 'POST') return sendJson(res, 405, rpcError('Method not allowed'), { Allow: 'POST' });

    const server = buildMcpServer(opts.tools, opts.version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, rpcError(err instanceof Error ? err.message : 'Internal error'));
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, '127.0.0.1', () => {
      http.off('error', reject);
      port = (http.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
