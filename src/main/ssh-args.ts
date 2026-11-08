import type { SessionProfile } from '../shared/types';

/**
 * Turn a saved profile into ssh's argv (everything after the binary).
 * Shape: [-p PORT] [-i KEY] [...extraArgs] destination
 *
 * extraArgs is user-controlled argv to a *local* ssh binary. For a local tool
 * that is the intended power-user escape hatch, not an injection surface.
 */
export function buildSshArgs(profile: SessionProfile): string[] {
  const host = profile.host.trim();
  if (!host) throw new Error('Host is required');
  if (host.startsWith('-')) throw new Error('Host must not start with "-"');

  const user = profile.user?.trim();
  const identityFile = profile.identityFile?.trim();
  const args: string[] = [];

  if (profile.port && profile.port !== 22) args.push('-p', String(profile.port));
  if (identityFile) args.push('-i', identityFile);
  if (profile.extraArgs?.length) args.push(...profile.extraArgs);
  args.push(user ? `${user}@${host}` : host);
  return args;
}

/** The variable OtherSSH hands each session's token to the server in. sshd accepts LC_* by default on Debian, Ubuntu and Fedora. */
export const CWD_TOKEN_ENV = 'LC_OTHERSSH_NONCE';

/** `setenv NAME=value` lines from `ssh -G`: whatever SetEnv the user's config or extra args already give this host. */
export function parseSetenv(sshG: string): string[] {
  return sshG
    .split(/\r?\n/)
    .filter((line) => /^setenv /i.test(line))
    .map((line) => line.slice('setenv '.length).trim())
    .filter((pair) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(pair) && !pair.startsWith(`${CWD_TOKEN_ENV}=`));
}

/**
 * Prefix the ssh argv with a SetEnv carrying the session token. ssh keeps only
 * the first SetEnv it sees, so the user's own (from `ssh -G`) go in the same option.
 */
export function withCwdToken(args: string[], existing: string[], token: string): string[] {
  const quote = (pair: string): string => {
    const eq = pair.indexOf('=');
    const value = pair.slice(eq + 1).replace(/["\\]/g, '\\$&');
    return `${pair.slice(0, eq)}="${value}"`;
  };
  return ['-o', `SetEnv=${[...existing, `${CWD_TOKEN_ENV}=${token}`].map(quote).join(' ')}`, ...args];
}
