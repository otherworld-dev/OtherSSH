import { describe, it, expect } from 'vitest';
import { parseQuickConnect } from './quick-connect';

describe('parseQuickConnect', () => {
  it('parses a bare host or alias', () => {
    expect(parseQuickConnect('webserver')).toEqual({ host: 'webserver' });
  });

  it('parses user@host', () => {
    expect(parseQuickConnect('root@10.0.0.5')).toEqual({ user: 'root', host: '10.0.0.5' });
  });

  it('parses an optional :port', () => {
    expect(parseQuickConnect('alice@box.example:2222')).toEqual({ user: 'alice', host: 'box.example', port: 2222 });
    expect(parseQuickConnect('box:22')).toEqual({ host: 'box', port: 22 });
  });

  it('ignores a leading "ssh " and surrounding whitespace', () => {
    expect(parseQuickConnect('  ssh alice@box  ')).toEqual({ user: 'alice', host: 'box' });
  });

  it('rejects anything that is not a single destination', () => {
    expect(parseQuickConnect('')).toBeNull();
    expect(parseQuickConnect('   ')).toBeNull();
    expect(parseQuickConnect('two words')).toBeNull();
    expect(parseQuickConnect('@host')).toBeNull();
    expect(parseQuickConnect('-oProxyCommand=x')).toBeNull();
    expect(parseQuickConnect('box:99999')).toBeNull();
    expect(parseQuickConnect('box:0')).toBeNull();
  });
});
