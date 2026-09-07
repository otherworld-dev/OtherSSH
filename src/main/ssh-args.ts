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
