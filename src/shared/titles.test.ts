import { describe, it, expect } from 'vitest';
import { isLocalProcessTitle } from './titles';

describe('isLocalProcessTitle', () => {
  it('recognises the console title ConPTY reports for a local exe', () => {
    expect(isLocalProcessTitle('C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe')).toBe(true);
    expect(isLocalProcessTitle('c:\\windows\\system32\\cmd.exe - ssh webserver')).toBe(true);
    expect(isLocalProcessTitle('\\\\server\\share\\tool.exe')).toBe(true);
  });

  it('lets titles set by a remote shell through', () => {
    expect(isLocalProcessTitle('alice@webserver: ~')).toBe(false);
    expect(isLocalProcessTitle('vim README.md')).toBe(false);
    expect(isLocalProcessTitle('htop')).toBe(false);
    expect(isLocalProcessTitle('')).toBe(false);
  });
});
