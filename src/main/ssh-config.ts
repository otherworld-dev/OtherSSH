import type { SessionProfile } from '../shared/types';

export interface SshConfigHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/**
 * Pull the concrete `Host` aliases out of an ssh_config. Wildcard/negated
 * patterns and `Match` blocks are skipped; the first definition of an alias
 * wins, mirroring ssh's own first-match rule. Only the handful of settings we
 * might display are captured; ssh itself still reads the file at connect time.
 */
export function parseSshConfigHosts(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  const seen = new Set<string>();
  let current: SshConfigHost[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();

    if (key === 'host') {
      current = [];
      for (const pattern of value.split(/\s+/)) {
        if (!pattern || /[*?]/.test(pattern) || pattern.startsWith('!')) continue;
        if (seen.has(pattern)) continue;
        seen.add(pattern);
        const host: SshConfigHost = { alias: pattern };
        hosts.push(host);
        current.push(host);
      }
      continue;
    }
    if (key === 'match') {
      current = [];
      continue;
    }
    for (const host of current) {
      if (key === 'hostname') host.hostName = value;
      else if (key === 'user') host.user = value;
      else if (key === 'port') {
        const port = Number(value);
        if (Number.isInteger(port) && port > 0 && port <= 65535) host.port = port;
      } else if (key === 'identityfile' && host.identityFile === undefined) host.identityFile = value;
    }
  }
  return hosts;
}

/** Hosts whose alias is not already the host or name of a saved profile (case-insensitive). */
export function importableHosts(hosts: SshConfigHost[], profiles: SessionProfile[]): SshConfigHost[] {
  const taken = new Set<string>();
  for (const p of profiles) {
    taken.add(p.host.trim().toLowerCase());
    taken.add(p.name.trim().toLowerCase());
  }
  return hosts.filter((h) => !taken.has(h.alias.toLowerCase()));
}
