import { describe, it, expect } from 'vitest';
import { importableHosts, parseSshConfigHosts } from './ssh-config';
import type { SessionProfile } from '../shared/types';

const CONFIG = `
# personal boxes
Host webserver webserver.lan
  HostName 1.2.3.4
  User alice
  IdentityFile ~/.ssh/a
  IdentityFile ~/.ssh/b

Host app-prod
  HostName example.com   # trailing comment
  User=deploy
  IdentitiesOnly yes

Host *
  ServerAliveInterval 30

Host test-* !bad
  User x

Match host foo
  User y

Host last
  Port 2222
`;

describe('parseSshConfigHosts', () => {
  it('returns one entry per concrete alias, in file order, with the block settings', () => {
    const hosts = parseSshConfigHosts(CONFIG);
    expect(hosts.map((h) => h.alias)).toEqual(['webserver', 'webserver.lan', 'app-prod', 'last']);
    expect(hosts[0]).toEqual({ alias: 'webserver', hostName: '1.2.3.4', user: 'alice', identityFile: '~/.ssh/a' });
    expect(hosts[1]).toEqual({ alias: 'webserver.lan', hostName: '1.2.3.4', user: 'alice', identityFile: '~/.ssh/a' });
    expect(hosts[2]).toEqual({ alias: 'app-prod', hostName: 'example.com', user: 'deploy' });
    expect(hosts[3]).toEqual({ alias: 'last', port: 2222 });
  });

  it('skips wildcard and negated patterns and everything under a Match block', () => {
    const hosts = parseSshConfigHosts('Host *\n  User a\nHost x-? !y\n  User b\nMatch all\n  User c\nHost ok\n  User d\n');
    expect(hosts).toEqual([{ alias: 'ok', user: 'd' }]);
  });

  it('keeps the first definition when an alias repeats, as ssh does', () => {
    const hosts = parseSshConfigHosts('Host a\n  User first\nHost a\n  User second\n');
    expect(hosts).toEqual([{ alias: 'a', user: 'first' }]);
  });

  it('handles an empty or comment-only file', () => {
    expect(parseSshConfigHosts('')).toEqual([]);
    expect(parseSshConfigHosts('# nothing here\n\n')).toEqual([]);
  });
});

describe('importableHosts', () => {
  const profile = (name: string, host: string): SessionProfile => ({ id: name, name, host });

  it('drops aliases already used as a profile host or name, case-insensitively', () => {
    const hosts = parseSshConfigHosts('Host webserver\nHost NewBox\nHost other\n');
    const existing = [profile('Webserver', 'WEBSERVER'), profile('newbox', '1.2.3.4')];
    expect(importableHosts(hosts, existing).map((h) => h.alias)).toEqual(['other']);
  });
});
