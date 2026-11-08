import { describe, it, expect } from 'vitest';
import type { SessionProfile } from '../shared/types';
import {
  connectionOptions,
  createTransfers,
  explainFailure,
  isWriteDenied,
  scpArgs,
  shellPath,
  siblingTool,
  sshExecArgs,
  sudoMoveCommand,
  TEACH_SCRIPT,
  type RunResult,
} from './transfer';

const profile = (over: Partial<SessionProfile> = {}): SessionProfile => ({ id: 'p1', name: 'Web', host: 'web01', ...over });

describe('siblingTool', () => {
  it('finds scp next to the ssh binary, keeping the .exe', () => {
    expect(siblingTool('C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'scp')).toBe('C:\\Windows\\System32\\OpenSSH\\scp.exe');
    expect(siblingTool('/usr/bin/ssh', 'scp')).toBe('/usr/bin/scp');
  });
});

describe('connectionOptions', () => {
  it('uses the port flag the tool expects and passes the key', () => {
    expect(connectionOptions(profile({ port: 2222, identityFile: 'C:\\k\\id' }), '-P')).toEqual(['-P', '2222', '-i', 'C:\\k\\id']);
    expect(connectionOptions(profile({ port: 22 }), '-p')).toEqual([]);
  });

  it('keeps extra args scp understands and drops terminal-only ones with their values', () => {
    const extra = ['-o', 'ServerAliveInterval=30', '-L', '8080:localhost:80', '-A', '-oProxyJump=bastion', '-J', 'jump', '-t', '-C'];
    expect(connectionOptions(profile({ extraArgs: extra }), '-P')).toEqual([
      '-o', 'ServerAliveInterval=30', '-oProxyJump=bastion', '-J', 'jump', '-C',
    ]);
  });

  it('translates a port given in extra args', () => {
    expect(connectionOptions(profile({ extraArgs: ['-p', '2200'] }), '-P')).toEqual(['-P', '2200']);
  });
});

describe('scpArgs', () => {
  it('copies recursively in batch mode into the folder, with a trailing slash', () => {
    expect(scpArgs(profile({ user: 'alice' }), ['C:\\a.txt', 'C:\\site'], '/var/www')).toEqual([
      '-s', '-B', '-r', 'C:\\a.txt', 'C:\\site', 'alice@web01:/var/www/',
    ]);
  });

  it('brackets an IPv6 host', () => {
    expect(scpArgs(profile({ host: 'fe80::1', user: 'alice' }), ['C:\\a'], '~').at(-1)).toBe('alice@[fe80::1]:~/');
  });
});

describe('sshExecArgs', () => {
  it('runs a command without a tty, password prompt or configured RemoteCommand', () => {
    expect(sshExecArgs(profile({ port: 2222 }), 'sh -s')).toEqual([
      '-T', '-o', 'BatchMode=yes', '-o', 'RemoteCommand=none', '-p', '2222', 'web01', 'sh -s',
    ]);
  });
});

describe('sudoMoveCommand', () => {
  it('quotes names and the destination, keeping ~ expandable', () => {
    expect(shellPath('~')).toBe('~');
    expect(shellPath('~/my site')).toBe("~/'my site'");
    expect(sudoMoveCommand('ab12', ["it's.txt", 'site'], '/var/www/x y')).toBe(
      "sudo mv -- ~/.otherssh-upload/ab12/'it'\\''s.txt' ~/.otherssh-upload/ab12/'site' '/var/www/x y'/ && rmdir ~/.otherssh-upload/ab12",
    );
  });
});

describe('failure messages', () => {
  it('tells a refused login apart from a refused write', () => {
    const login = 'alice@web01: Permission denied (publickey,password).\r\nscp: Connection closed\r\n';
    const write = 'scp: dest open "/var/www/a.txt": Permission denied\r\n';
    expect(isWriteDenied(login)).toBe(false);
    expect(isWriteDenied(write)).toBe(true);
    expect(explainFailure(login)).toMatch(/without a password/);
    expect(explainFailure(write)).toBe('dest open "/var/www/a.txt": Permission denied');
    expect(explainFailure('')).toBe('The transfer failed.');
  });
});

describe('createTransfers', () => {
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });

  const setup = (results: RunResult[]) => {
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const transfers = createTransfers({
      resolveSsh: () => 'C:\\OpenSSH\\ssh.exe',
      exists: () => true,
      run: async (file, args, input) => {
        calls.push({ file, args, input });
        return results.shift() ?? ok();
      },
      newId: () => 'ab12',
    });
    return { transfers, calls };
  };

  it('uploads straight into the folder when it is writable', async () => {
    const { transfers, calls } = setup([ok()]);
    await expect(transfers.upload(profile(), ['C:\\a.txt'], '/srv')).resolves.toEqual({ kind: 'done' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('C:\\OpenSSH\\scp.exe');
  });

  it('stages in the home folder and returns a sudo mv when the write is refused', async () => {
    const { transfers, calls } = setup([fail('scp: dest open "/var/www/a.txt": Permission denied'), ok(), ok()]);
    const result = await transfers.upload(profile(), ['C:\\files\\a.txt'], '/var/www');
    expect(result).toEqual({ kind: 'staged', command: "sudo mv -- ~/.otherssh-upload/ab12/'a.txt' '/var/www'/ && rmdir ~/.otherssh-upload/ab12" });
    expect(calls[1]!.file).toBe('C:\\OpenSSH\\ssh.exe');
    expect(calls[1]!.args.at(-1)).toBe('mkdir -p .otherssh-upload/ab12');
    expect(calls[2]!.args.at(-1)).toBe('web01:.otherssh-upload/ab12/');
  });

  it('does not try sudo when the login itself failed', async () => {
    const { transfers, calls } = setup([fail('web01: Permission denied (publickey).')]);
    await expect(transfers.upload(profile(), ['C:\\a.txt'], '/var/www')).rejects.toThrow(/without a password/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a remote folder with control characters in it', async () => {
    const { transfers, calls } = setup([]);
    await expect(transfers.upload(profile(), ['C:\\a.txt'], '/tmp\nput x')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('teaches the server by piping the script to sh -s, and reads back what happened', async () => {
    const { transfers, calls } = setup([ok('OTHERSSH_DONE\n'), ok('OTHERSSH_ALREADY\n'), ok('OTHERSSH_SHELL zsh\n')]);
    await expect(transfers.teach(profile())).resolves.toEqual({ kind: 'done' });
    expect(calls[0]!.args.at(-1)).toBe('sh -s');
    expect(calls[0]!.input).toBe(TEACH_SCRIPT);
    await expect(transfers.teach(profile())).resolves.toEqual({ kind: 'already' });
    await expect(transfers.teach(profile())).resolves.toEqual({ kind: 'unsupported', shell: 'zsh' });
  });
});
