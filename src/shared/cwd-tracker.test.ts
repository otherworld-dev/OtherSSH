import { describe, it, expect } from 'vitest';
import { CwdTracker, parseOsc7, pathFromTitle } from './cwd-tracker';

describe('parseOsc7', () => {
  it('splits host and path and decodes percent escapes', () => {
    expect(parseOsc7('file://Web01/var/www/my%20site')).toEqual({ host: 'web01', path: '/var/www/my site', token: '' });
  });

  it('keeps a path that is not valid percent-encoding as written', () => {
    expect(parseOsc7('file://web01/tmp/100%')).toEqual({ host: 'web01', path: '/tmp/100%', token: '' });
  });

  it('reads the session token from the query, and an encoded ? as part of the path', () => {
    expect(parseOsc7('file://web01/a%3Fb?otherssh=abc')).toEqual({ host: 'web01', path: '/a?b', token: 'abc' });
  });

  it('rejects anything that is not a file URL with a path, or that hides control characters', () => {
    expect(parseOsc7('http://web01/x')).toBeNull();
    expect(parseOsc7('file://web01')).toBeNull();
    expect(parseOsc7('file://web01/tmp/a%0Ab')).toBeNull();
  });
});

describe('pathFromTitle', () => {
  it('reads the directory out of an Ubuntu-style title', () => {
    expect(pathFromTitle('alice@web01: ~/site')).toBe('~/site');
    expect(pathFromTitle('root@web01: /var/www')).toBe('/var/www');
    expect(pathFromTitle('alice@web01: ~')).toBe('~');
  });

  it('ignores titles that are not user@host: path', () => {
    expect(pathFromTitle('vim notes.txt')).toBeNull();
    expect(pathFromTitle('alice@web01: htop')).toBeNull();
  });
});

describe('CwdTracker', () => {
  const T = 'tok123';
  const ok = (host: string, path: string) => `file://${host}${path}?otherssh=${T}`;

  it('falls back to an unsure home directory before the shell says anything', () => {
    expect(new CwdTracker(T).current).toEqual({ path: '~', sure: false });
  });

  it('is sure after a report carrying the token, and unsure again once Enter is pressed', () => {
    const t = new CwdTracker(T);
    t.report(ok('web01', '/var/www'));
    expect(t.current).toEqual({ path: '/var/www', sure: true });
    t.input('vim index.php\r');
    expect(t.current).toEqual({ path: '/var/www', sure: false });
    t.report(ok('web01', '/var/www/site'));
    expect(t.current).toEqual({ path: '/var/www/site', sure: true });
  });

  it('treats a forged report (no token, or the wrong one) as a guess only', () => {
    const t = new CwdTracker(T);
    t.input('cat evil.log\r');
    t.report('file://web01/var/www/public');
    expect(t.current).toEqual({ path: '/var/www/public', sure: false });
    t.report('file://web01/srv/x?otherssh=guess');
    expect(t.current).toEqual({ path: '/srv/x', sure: false });
    expect(t.taught).toBe(false);
  });

  it('never trusts a forged report over a verified one', () => {
    const t = new CwdTracker(T);
    t.report(ok('web01', '/home/alice'));
    t.report('file://web01/var/www/public');
    expect(t.current).toEqual({ path: '/home/alice', sure: true });
  });

  it('is never sure without a token', () => {
    const t = new CwdTracker();
    t.report('file://web01/srv?otherssh=');
    expect(t.current.sure).toBe(false);
  });

  it('does not lose certainty on typing that has no Enter in it', () => {
    const t = new CwdTracker(T);
    t.report(ok('web01', '/srv'));
    t.input('ls -la');
    expect(t.current.sure).toBe(true);
  });

  it('distrusts a report naming a different host, even with the token', () => {
    const t = new CwdTracker(T);
    t.report(ok('web01', '/home/alice'));
    t.input('ssh db01\r');
    t.report(ok('db01', '/home/alice'));
    expect(t.current).toEqual({ path: '/home/alice', sure: false });
  });

  it('uses the title as a guess only while not sure', () => {
    const t = new CwdTracker(T);
    t.title('alice@web01: ~/site');
    expect(t.current).toEqual({ path: '~/site', sure: false });
    t.report(ok('web01', '/var/www'));
    t.title('alice@web01: ~/elsewhere');
    expect(t.current).toEqual({ path: '/var/www', sure: true });
  });

  it('forgets the shell on reset but keeps the session token', () => {
    const t = new CwdTracker(T);
    t.report(ok('web01', '/srv'));
    expect(t.taught).toBe(true);
    t.reset();
    expect(t.taught).toBe(false);
    expect(t.current).toEqual({ path: '~', sure: false });
    t.report(ok('web01', '/srv'));
    expect(t.current.sure).toBe(true);
  });
});
