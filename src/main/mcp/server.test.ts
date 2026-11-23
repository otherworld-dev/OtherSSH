import { afterEach, describe, it, expect, vi } from 'vitest';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type McpHttpServer } from './server';
import type { McpTools } from './tools';
import { McpToolError } from './tools';

const TOKEN = 'test-token-123';

function fakeTools(): McpTools {
  return {
    listSessions: vi.fn(async () => '[{"name":"web01"}]'),
    listTabs: vi.fn(async () => '[]'),
    openTab: vi.fn(async () => 'opened'),
    readTab: vi.fn(async () => 'screen'),
    sendInput: vi.fn(async () => 'sent'),
    closeTab: vi.fn(async () => 'closed'),
    runCommand: vi.fn(async () => {
      throw new McpToolError('"db01" is not open to Claude.');
    }),
    uploadFile: vi.fn(async () => 'uploaded'),
  };
}

let server: McpHttpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function connect(token = TOKEN) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server!.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function rawPost(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server!.port, path: '/mcp', method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

describe('MCP HTTP server', () => {
  it('serves the tools to an MCP client that has the token', async () => {
    const tools = fakeTools();
    server = await startMcpServer({ port: 0, token: TOKEN, tools, version: '9.9.9' });
    const client = await connect();

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      ['close_tab', 'list_sessions', 'list_tabs', 'open_tab', 'read_tab', 'run_command', 'send_input', 'upload_file'].sort(),
    );

    const result = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: '[{"name":"web01"}]' }]);

    await client.callTool({ name: 'send_input', arguments: { tab: 's1', text: 'ls', keys: ['ctrl_c'], wait_ms: 0 } });
    expect(tools.sendInput).toHaveBeenCalledWith('s1', { text: 'ls', pressEnter: undefined, keys: ['ctrl_c'], waitMs: 0 });
    await client.close();
  });

  it('returns a refusal as an error result Claude can read', async () => {
    server = await startMcpServer({ port: 0, token: TOKEN, tools: fakeTools(), version: '1' });
    const client = await connect();
    const result = await client.callTool({ name: 'run_command', arguments: { session: 'db01', command: 'uptime' } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: '"db01" is not open to Claude.' }]);
    await client.close();
  });

  it('turns away a wrong or missing token', async () => {
    server = await startMcpServer({ port: 0, token: TOKEN, tools: fakeTools(), version: '1' });
    await expect(connect('wrong')).rejects.toThrow();
    expect(await rawPost({ 'Content-Type': 'application/json' })).toBe(401);
  });

  it('turns away a request for another host name (DNS rebinding)', async () => {
    server = await startMcpServer({ port: 0, token: TOKEN, tools: fakeTools(), version: '1' });
    expect(await rawPost({ Host: `evil.example:${server.port}`, Authorization: `Bearer ${TOKEN}` })).toBe(403);
  });

  it('fails to start, with EADDRINUSE, on a port already taken', async () => {
    server = await startMcpServer({ port: 0, token: TOKEN, tools: fakeTools(), version: '1' });
    await expect(startMcpServer({ port: server.port, token: TOKEN, tools: fakeTools(), version: '1' })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});
