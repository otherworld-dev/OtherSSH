import { describe, it, expect } from 'vitest';
import { sanitizeProfile } from './profile';

describe('sanitizeProfile', () => {
  it('trims strings and drops empty optional fields', () => {
    expect(sanitizeProfile({ id: ' a ', name: ' Box ', host: ' h ', user: '  ', identityFile: ' ', extraArgs: [] }))
      .toEqual({ id: 'a', name: 'Box', host: 'h' });
  });

  it('keeps a valid port and drops an invalid one', () => {
    expect(sanitizeProfile({ id: '', name: 'n', host: 'h', port: 2222 }).port).toBe(2222);
    expect(sanitizeProfile({ id: '', name: 'n', host: 'h', port: 0 }).port).toBeUndefined();
    expect(sanitizeProfile({ id: '', name: 'n', host: 'h', port: 70000 }).port).toBeUndefined();
    expect(sanitizeProfile({ id: '', name: 'n', host: 'h', port: '22' as unknown as number }).port).toBeUndefined();
  });

  it('falls back to user@host as the name when the name is blank', () => {
    expect(sanitizeProfile({ id: '', name: '', host: 'h', user: 'u' }).name).toBe('u@h');
    expect(sanitizeProfile({ id: '', name: '', host: 'h' }).name).toBe('h');
  });

  it('keeps only string entries of extraArgs', () => {
    expect(sanitizeProfile({ id: '', name: 'n', host: 'h', extraArgs: ['-C', 5, null] as unknown as string[] }).extraArgs).toEqual(['-C']);
  });

  it('rejects a missing, empty or option-like host', () => {
    expect(() => sanitizeProfile({ id: '', name: 'n', host: '' })).toThrow(/host/i);
    expect(() => sanitizeProfile({ id: '', name: 'n', host: '-v' })).toThrow(/host/i);
    expect(() => sanitizeProfile({ id: '', name: 'n' } as never)).toThrow(/host/i);
  });

  it('rejects input that is not an object', () => {
    expect(() => sanitizeProfile(null as never)).toThrow();
  });
});

describe('sanitizeProfile group', () => {
  it('keeps a trimmed group name and drops a blank one', () => {
    expect(sanitizeProfile({ id: '', name: 'n', host: 'h', group: '  Work  ' }).group).toBe('Work');
    expect(sanitizeProfile({ id: '', name: 'n', host: 'h', group: '   ' }).group).toBeUndefined();
    expect(sanitizeProfile({ id: '', name: 'n', host: 'h' }).group).toBeUndefined();
  });
});
