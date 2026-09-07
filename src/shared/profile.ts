import type { SessionProfile } from './types';

/**
 * Coerce untrusted renderer input into a clean SessionProfile.
 * Throws when there is no usable host.
 */
export function sanitizeProfile(raw: SessionProfile): SessionProfile {
  if (!raw || typeof raw !== 'object') throw new Error('Profile must be an object');
  const r = raw as unknown as Record<string, unknown>;

  const host = str(r['host']);
  if (!host) throw new Error('Host is required');
  if (host.startsWith('-')) throw new Error('Host must not start with "-"');

  const user = str(r['user']);
  const identityFile = str(r['identityFile']);
  const group = str(r['group']);
  const port = typeof r['port'] === 'number' && Number.isInteger(r['port']) && r['port'] >= 1 && r['port'] <= 65535 ? r['port'] : undefined;
  const extraArgs = Array.isArray(r['extraArgs']) ? r['extraArgs'].filter((a): a is string => typeof a === 'string') : [];
  const name = str(r['name']) || (user ? `${user}@${host}` : host);

  const out: SessionProfile = { id: str(r['id']), name, host };
  if (user) out.user = user;
  if (port !== undefined) out.port = port;
  if (identityFile) out.identityFile = identityFile;
  if (extraArgs.length) out.extraArgs = extraArgs;
  if (group) out.group = group;
  return out;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
