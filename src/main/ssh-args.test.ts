import { describe, it, expect } from 'vitest';
import { buildSshArgs, parseSetenv, withCwdToken } from './ssh-args';

const base = { id: 'p1', name: 'Test' };

describe('buildSshArgs', () => {
  it('passes a bare host so ~/.ssh/config aliases resolve', () => {
    expect(buildSshArgs({ ...base, host: 'webserver' })).toEqual(['webserver']);
  });

  it('joins user and host as user@host', () => {
    expect(buildSshArgs({ ...base, host: 'example.com', user: 'alice' })).toEqual(['alice@example.com']);
  });

  it('omits -p when the port is the default 22', () => {
    expect(buildSshArgs({ ...base, host: 'example.com', port: 22 })).toEqual(['example.com']);
  });

  it('adds -p for a non-default port', () => {
    expect(buildSshArgs({ ...base, host: 'example.com', port: 2222 })).toEqual(['-p', '2222', 'example.com']);
  });

  it('adds -i for an identity file', () => {
    expect(buildSshArgs({ ...base, host: 'example.com', identityFile: '~/.ssh/id_ed25519_alice' }))
      .toEqual(['-i', '~/.ssh/id_ed25519_alice', 'example.com']);
  });

  it('places extra args after options and before the destination', () => {
    expect(buildSshArgs({ ...base, host: 'h', user: 'u', port: 2200, identityFile: 'k', extraArgs: ['-o', 'ServerAliveInterval=30'] }))
      .toEqual(['-p', '2200', '-i', 'k', '-o', 'ServerAliveInterval=30', 'u@h']);
  });

  it('trims surrounding whitespace from host and user', () => {
    expect(buildSshArgs({ ...base, host: ' example.com ', user: ' alice ' })).toEqual(['alice@example.com']);
  });

  it('rejects an empty host', () => {
    expect(() => buildSshArgs({ ...base, host: '   ' })).toThrow(/host/i);
  });

  it('rejects a host that starts with a dash so it cannot become an ssh option', () => {
    expect(() => buildSshArgs({ ...base, host: '-oProxyCommand=calc' })).toThrow(/host/i);
  });
});

describe('session token', () => {
  it('reads existing SetEnv pairs from ssh -G, ignoring an old token', () => {
    const g = 'user alice\r\nsetenv TZ=Europe/London\r\nsetenv LC_OTHERSSH_NONCE=old\r\nport 22\r\n';
    expect(parseSetenv(g)).toEqual(['TZ=Europe/London']);
  });

  it('puts the token in one SetEnv with the existing pairs, ahead of the profile args', () => {
    expect(withCwdToken(['-p', '2222', 'web01'], ['TZ=Europe/London', 'MSG=say "hi"'], 'abc')).toEqual([
      '-o',
      'SetEnv=TZ="Europe/London" MSG="say \\"hi\\"" LC_OTHERSSH_NONCE="abc"',
      '-p',
      '2222',
      'web01',
    ]);
  });
});
