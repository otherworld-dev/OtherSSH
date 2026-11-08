import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import type { SessionProfile, TeachResult, UploadResult } from '../shared/types';
import { hasControlChars } from '../shared/cwd-tracker';

// Uploads and "teach this server" both run the OpenSSH tools sitting next to
// the ssh binary, with the session's own profile, so they log in exactly the
// way the terminal did. BatchMode means a host that needs a typed password
// fails cleanly instead of waiting on a prompt nobody can see.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TransferDeps {
  resolveSsh(): string | null;
  exists(path: string): boolean;
  run(file: string, args: string[], input?: string): Promise<RunResult>;
  newId?(): string;
}

/** Where a sudo fallback parks files, relative to the login user's home. */
export const STAGING_DIR = '.otherssh-upload';

/** ssh flags that take a value, so an unsupported one is dropped together with it. */
const SSH_VALUED = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split('').map((c) => `-${c}`));
/** Flags scp and ssh both understand; anything else in extraArgs is left to the terminal. */
const SHARED_VALUED = new Set(['-o', '-F', '-J', '-c', '-i']);
const SHARED_FLAGS = new Set(['-4', '-6', '-C', '-q', '-v']);

/** scp/sftp live next to ssh in every OpenSSH install. */
export function siblingTool(sshPath: string, tool: 'scp'): string {
  const ext = /\.exe$/i.test(sshPath) ? '.exe' : '';
  return sshPath.replace(/[^\\/]*$/, tool + ext);
}

export function destination(profile: SessionProfile): string {
  const host = profile.host.trim();
  if (!host) throw new Error('Host is required');
  if (host.startsWith('-')) throw new Error('Host must not start with "-"');
  const user = profile.user?.trim();
  return user ? `${user}@${host}` : host;
}

/** The profile's port, key and the extra args scp also accepts, with the port flag scp or ssh expects. */
export function connectionOptions(profile: SessionProfile, portFlag: '-P' | '-p'): string[] {
  const out: string[] = [];
  if (profile.port && profile.port !== 22) out.push(portFlag, String(profile.port));
  const key = profile.identityFile?.trim();
  if (key) out.push('-i', key);

  const extra = profile.extraArgs ?? [];
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i]!;
    const flag = arg.slice(0, 2);
    const glued = arg.length > 2 && arg.startsWith('-') && !arg.startsWith('--');
    if (arg === '-p' || arg === '-P') {
      if (i + 1 < extra.length) out.push(portFlag, extra[++i]!);
    } else if (SHARED_VALUED.has(arg)) {
      if (i + 1 < extra.length) out.push(arg, extra[++i]!);
    } else if (glued && SHARED_VALUED.has(flag)) {
      out.push(arg);
    } else if (SHARED_FLAGS.has(arg)) {
      out.push(arg);
    } else if (SSH_VALUED.has(arg)) {
      i++; // e.g. -L 8080:localhost:80: meaningless for a copy, and its value must not become a stray operand
    }
  }
  return out;
}

export function scpArgs(profile: SessionProfile, localPaths: string[], remoteDir: string): string[] {
  const dir = remoteDir.endsWith('/') ? remoteDir : `${remoteDir}/`; // trailing slash: never rename a dropped folder onto a typo
  return ['-s', '-B', '-r', ...connectionOptions(profile, '-P'), ...localPaths, `${scpHost(profile)}:${dir}`];
}

export function sshExecArgs(profile: SessionProfile, command: string): string[] {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'RemoteCommand=none', ...connectionOptions(profile, '-p'), destination(profile), command];
}

/** scp needs an IPv6 literal bracketed so its colons are not read as the path separator. */
function scpHost(profile: SessionProfile): string {
  const dest = destination(profile);
  const at = dest.lastIndexOf('@');
  const host = dest.slice(at + 1);
  return host.includes(':') && !host.startsWith('[') ? `${dest.slice(0, at + 1)}[${host}]` : dest;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A remote path for a shell command line, keeping `~` outside the quotes so it still expands. */
export function shellPath(path: string): string {
  if (path === '~') return '~';
  if (path.startsWith('~/')) return `~/${shellQuote(path.slice(2))}`;
  return shellQuote(path);
}

/** Typed into the user's own shell, unsent, so they finish it with their sudo password. */
export function sudoMoveCommand(stagingId: string, names: string[], remoteDir: string): string {
  const staged = `~/${STAGING_DIR}/${stagingId}`;
  const sources = names.map((n) => `${staged}/${shellQuote(n)}`).join(' ');
  return `sudo mv -- ${sources} ${shellPath(remoteDir)}/ && rmdir ${staged}`;
}

/** The snippet appended to ~/.bashrc: report the directory as OSC 7 before every prompt. */
/**
 * The snippet appended to ~/.bashrc: report the directory as OSC 7 before every
 * prompt, with the session token OtherSSH passed in as LC_OTHERSSH_NONCE, so the
 * app can tell this report from a forged one in a file being displayed. `%`, `?`
 * and `#` in the path are encoded so the token can't be faked through a folder name.
 */
export const OSC7_SNIPPET = [
  '',
  '# Added by OtherSSH: tell the terminal which directory you are in (OSC 7), for drag-and-drop uploads.',
  // Keep the token in an unexported variable and drop it from the environment, so nothing run
  // from this shell inherits it, and a nested ssh (which sends LC_* on) can't pass it to another host.
  '__otherssh_nonce="${LC_OTHERSSH_NONCE:-$__otherssh_nonce}"; unset LC_OTHERSSH_NONCE',
  "__otherssh_osc7() { local p=\"${PWD//\\%/%25}\"; p=\"${p//\\?/%3F}\"; p=\"${p//\\#/%23}\"; printf '\\033]7;file://%s%s%s\\033\\\\' \"$HOSTNAME\" \"$p\" \"${__otherssh_nonce:+?otherssh=$__otherssh_nonce}\"; }",
  'case ";${PROMPT_COMMAND};" in *";__otherssh_osc7;"*) ;; *) PROMPT_COMMAND="__otherssh_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;; esac',
].join('\n');

/**
 * Fed to `sh -s` on the server. Idempotent: a second run reports it is already
 * there. An earlier version of the snippet is taken out and replaced, keeping
 * the previous file as ~/.bashrc.otherssh-bak.
 */
export const TEACH_SCRIPT = [
  'case "${SHELL##*/}" in bash) ;; *) echo "OTHERSSH_SHELL ${SHELL##*/}"; exit 0 ;; esac',
  'if grep -q "unset LC_OTHERSSH_NONCE" ~/.bashrc 2>/dev/null; then echo OTHERSSH_ALREADY; exit 0; fi',
  "if grep -q __otherssh_ ~/.bashrc 2>/dev/null; then sed -i.otherssh-bak -e '/^# Added by OtherSSH: /d' -e '/__otherssh_/d' ~/.bashrc; fi",
  "cat >> ~/.bashrc <<'OTHERSSH_EOF'",
  OSC7_SNIPPET,
  'OTHERSSH_EOF',
  'echo OTHERSSH_DONE',
  '',
].join('\n');

const AUTH_FAILURE = /Permission denied \(|Host key verification failed|Too many authentication failures|No more authentication methods/i;

/** Turn an OpenSSH tool's stderr into one sentence for a toast. */
export function explainFailure(stderr: string): string {
  if (AUTH_FAILURE.test(stderr)) {
    return "Couldn't log in for the transfer without a password. Uploads need key or agent login to this server.";
  }
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('debug'));
  const last = lines.at(-1);
  return last ? last.replace(/^(scp|ssh):\s*/, '') : 'The transfer failed.';
}

/** A write refused by the server, as opposed to a refused login. */
export function isWriteDenied(stderr: string): boolean {
  return /Permission denied/i.test(stderr) && !AUTH_FAILURE.test(stderr);
}

export function createTransfers(deps: TransferDeps) {
  const newId = deps.newId ?? (() => randomUUID().slice(0, 8));
  let running = 0; // the updater won't restart the app under an upload
  const tracked = async <T>(work: () => Promise<T>): Promise<T> => {
    running++;
    try {
      return await work();
    } finally {
      running--;
    }
  };

  const tool = (name: 'ssh' | 'scp'): string => {
    const ssh = deps.resolveSsh();
    if (!ssh) throw new Error('No ssh binary found. Set one in Settings.');
    if (name === 'ssh') return ssh;
    const path = siblingTool(ssh, name);
    if (!deps.exists(path)) throw new Error(`${name} was not found next to ${ssh}.`);
    return path;
  };

  const exec = async (profile: SessionProfile, command: string, input?: string): Promise<string> => {
    const result = await deps.run(tool('ssh'), sshExecArgs(profile, command), input);
    if (result.code !== 0) throw new Error(explainFailure(result.stderr));
    return result.stdout;
  };

  const upload = async (profile: SessionProfile, localPaths: string[], remoteDir: string): Promise<UploadResult> => {
    if (localPaths.length === 0) throw new Error('Nothing to upload.');
    if (!remoteDir.trim() || hasControlChars(remoteDir)) throw new Error('That is not a usable remote folder.');
    const scp = tool('scp');

    const direct = await deps.run(scp, scpArgs(profile, localPaths, remoteDir));
    if (direct.code === 0) return { kind: 'done' };
    if (!isWriteDenied(direct.stderr)) throw new Error(explainFailure(direct.stderr));

    // Not writable as the login user: park it in their home and hand them a sudo mv to finish with.
    const id = newId();
    await exec(profile, `mkdir -p ${STAGING_DIR}/${id}`);
    const staged = await deps.run(scp, scpArgs(profile, localPaths, `${STAGING_DIR}/${id}`));
    if (staged.code !== 0) throw new Error(explainFailure(staged.stderr));
    const names = localPaths.map((p) => win32.basename(p));
    return { kind: 'staged', command: sudoMoveCommand(id, names, remoteDir) };
  };

  const teach = async (profile: SessionProfile): Promise<TeachResult> => {
    const out = await exec(profile, 'sh -s', TEACH_SCRIPT);
    if (out.includes('OTHERSSH_DONE')) return { kind: 'done' };
    if (out.includes('OTHERSSH_ALREADY')) return { kind: 'already' };
    const shell = /OTHERSSH_SHELL (\S*)/.exec(out)?.[1];
    if (shell !== undefined) return { kind: 'unsupported', shell: shell || 'unknown' };
    throw new Error('The server did not confirm the change.');
  };

  return {
    upload: (profile: SessionProfile, localPaths: string[], remoteDir: string) => tracked(() => upload(profile, localPaths, remoteDir)),
    teach: (profile: SessionProfile) => tracked(() => teach(profile)),
    get running(): number {
      return running;
    },
  };
}

export type Transfers = ReturnType<typeof createTransfers>;
