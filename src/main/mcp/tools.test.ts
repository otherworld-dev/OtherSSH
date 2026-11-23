import { describe, it, expect, vi } from 'vitest';
import type { SessionProfile } from '../../shared/types';
import type { SessionInfo } from '../session-manager';
import { createMcpTools, stripAnsi, tail, type McpToolDeps } from './tools';

const web01: SessionProfile = { id: 'p1', name: 'web01', host: 'web01.example.com', user: 'alice', allowAi: true };
const db01: SessionProfile = { id: 'p2', name: 'db01', host: 'db01.example.com', user: 'alice' };

const tab = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1',
  profileId: 'p1',
  title: 'web01',
  alive: true,
  exitCode: undefined,
  ownerWc: 1,
  profile: web01,
  cwdToken: '',
  ...over,
});

function setup(over: Partial<McpToolDeps> = {}) {
  const deps: McpToolDeps = {
    profiles: () => [web01, db01],
    sessions: () => [tab(), tab({ sessionId: 's2', profileId: 'p2', title: 'db01' }), tab({ sessionId: 's3', profileId: '', title: 'bob@quick' })],
    openTab: vi.fn(async () => ({ sessionId: 's9', title: 'web01' })),
    readTab: vi.fn(async () => 'alice@web01:~$'),
    writeTab: vi.fn(),
    closeTab: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => ({ code: 0, stdout: 'hello\n', stderr: '' })),
    upload: vi.fn(async () => ({ kind: 'done' as const })),
    checkLocalPath: vi.fn(async () => undefined),
    record: vi.fn(),
    sleep: vi.fn(async () => undefined),
    ...over,
  };
  return { deps, tools: createMcpTools(deps) };
}

describe('MCP tools', () => {
  it('lists saved sessions with their AI permission', async () => {
    const { tools } = setup();
    const list = JSON.parse(await tools.listSessions());
    expect(list).toEqual([
      { id: 'p1', name: 'web01', host: 'web01.example.com', user: 'alice', allowAi: true },
      { id: 'p2', name: 'db01', host: 'db01.example.com', user: 'alice', allowAi: false },
    ]);
  });

  it('lists open tabs, naming one-off connections as having no session', async () => {
    const { tools } = setup();
    const list = JSON.parse(await tools.listTabs());
    expect(list.map((t: { tab: string; session: string | null }) => [t.tab, t.session])).toEqual([
      ['s1', 'web01'],
      ['s2', 'db01'],
      ['s3', null],
    ]);
  });

  it('finds a session by name, case-insensitively, as well as by id', async () => {
    const { tools, deps } = setup();
    await tools.runCommand('WEB01', 'uptime');
    await tools.runCommand('p1', 'uptime');
    expect(deps.runCommand).toHaveBeenCalledTimes(2);
  });

  it('refuses every server action on a session without Allow AI, and logs the refusal', async () => {
    const { tools, deps } = setup();
    await expect(tools.runCommand('db01', 'uptime')).rejects.toThrow(/not open to AI assistants/);
    await expect(tools.openTab('db01')).rejects.toThrow(/not open to AI assistants/);
    await expect(tools.uploadFile('db01', ['C:\\x.txt'], '~')).rejects.toThrow(/not open to AI assistants/);
    await expect(tools.readTab('s2')).rejects.toThrow(/not open to AI assistants/);
    await expect(tools.sendInput('s2', { text: 'ls' })).rejects.toThrow(/not open to AI assistants/);
    await expect(tools.closeTab('s2')).rejects.toThrow(/not open to AI assistants/);
    expect(deps.runCommand).not.toHaveBeenCalled();
    expect(deps.openTab).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.readTab).not.toHaveBeenCalled();
    expect(deps.writeTab).not.toHaveBeenCalled();
    expect(deps.closeTab).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ tool: 'run_command', target: 'db01', ok: false }));
  });

  it('reads permission fresh on each call, so unticking takes effect at once', async () => {
    let allow = true;
    const { tools } = setup({ profiles: () => [{ ...web01, allowAi: allow }] });
    await tools.runCommand('web01', 'uptime');
    allow = false;
    await expect(tools.runCommand('web01', 'uptime')).rejects.toThrow(/not open to AI assistants/);
  });

  it('refuses one-off connections, which have no saved session to allow', async () => {
    const { tools } = setup();
    await expect(tools.readTab('s3')).rejects.toThrow(/one-off connection/);
  });

  it('types text with Enter, turns newlines into Enter, and adds special keys', async () => {
    const { tools, deps } = setup();
    await tools.sendInput('s1', { text: 'ls\npwd' });
    expect(deps.writeTab).toHaveBeenLastCalledWith('s1', 'ls\rpwd\r');
    await tools.sendInput('s1', { text: 'q', pressEnter: false, keys: ['ctrl_c', 'up'] });
    expect(deps.writeTab).toHaveBeenLastCalledWith('s1', 'q\x03\x1b[A');
  });

  it('returns the screen after typing, waiting the asked time', async () => {
    const { tools, deps } = setup();
    const out = await tools.sendInput('s1', { text: 'ls', waitMs: 2500 });
    expect(deps.sleep).toHaveBeenCalledWith(2500);
    expect(out).toContain('alice@web01:~$');
  });

  it('will not type into a disconnected tab', async () => {
    const { tools, deps } = setup({ sessions: () => [tab({ alive: false, exitCode: 255 })] });
    await expect(tools.sendInput('s1', { text: 'ls' })).rejects.toThrow(/disconnected/);
    expect(deps.writeTab).not.toHaveBeenCalled();
  });

  it('reports exit code and output of a command, clamping the time limit', async () => {
    const { tools, deps } = setup({ runCommand: vi.fn(async () => ({ code: 2, stdout: '\x1b[31mred\x1b[0m\n', stderr: 'oops\n' })) });
    const out = await tools.runCommand('web01', 'false', 9999);
    expect(deps.runCommand).toHaveBeenCalledWith(web01, 'false', 300_000);
    expect(out).toBe('Exit code 2.\n\nstdout:\nred\n\nstderr:\noops');
  });

  it('says when a command was stopped by its time limit', async () => {
    const { tools } = setup({ runCommand: vi.fn(async () => ({ code: -1, stdout: '', stderr: '', timedOut: true })) });
    expect(await tools.runCommand('web01', 'sleep 99', 5)).toMatch(/^Stopped after 5 s/);
  });

  it('turns a failed ssh login into an error', async () => {
    const { tools } = setup({
      runCommand: vi.fn(async () => ({ code: 255, stdout: '', stderr: 'alice@web01.example.com: Permission denied (publickey,password).' })),
    });
    await expect(tools.runCommand('web01', 'uptime')).rejects.toThrow(/Couldn't log in to "web01" without a password/);
  });

  it('passes on why ssh could not connect at all', async () => {
    const { tools } = setup({
      runCommand: vi.fn(async () => ({ code: 255, stdout: '', stderr: 'ssh: Could not resolve hostname web01.example.com: No such host is known.' })),
    });
    await expect(tools.runCommand('web01', 'uptime')).rejects.toThrow(/Couldn't connect: Could not resolve hostname/);
  });

  it('opens a tab and returns its id with the first screen', async () => {
    const { tools, deps } = setup();
    const out = await tools.openTab('web01');
    expect(deps.openTab).toHaveBeenCalledWith('p1');
    expect(out).toContain('tab s9');
    expect(deps.readTab).toHaveBeenCalledWith('s9', 40);
  });

  it('checks local paths before uploading, and passes on a sudo hand-off', async () => {
    const { tools, deps } = setup({ upload: vi.fn(async () => ({ kind: 'staged' as const, command: 'sudo mv -- x /srv/' })) });
    const out = await tools.uploadFile('web01', ['C:\\x.txt'], '/srv');
    expect(deps.checkLocalPath).toHaveBeenCalledWith('C:\\x.txt');
    expect(out).toContain('sudo mv -- x /srv/');
  });

  it('logs successful calls for the activity list', async () => {
    const { tools, deps } = setup();
    await tools.readTab('s1');
    expect(deps.record).toHaveBeenCalledWith({ tool: 'read_tab', target: 'web01', ok: true });
  });
});

describe('text helpers', () => {
  it('strips colour codes and OSC titles', () => {
    expect(stripAnsi('\x1b]0;title\x07\x1b[1;32mok\x1b[0m')).toBe('ok');
  });

  it('keeps the end of long output', () => {
    expect(tail('abcdef', 3)).toBe('[... 3 earlier characters cut ...]\ndef');
    expect(tail('abc', 3)).toBe('abc');
  });
});
