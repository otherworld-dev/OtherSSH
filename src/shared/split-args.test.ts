import { describe, it, expect } from 'vitest';
import { splitArgs } from './split-args';

describe('splitArgs', () => {
  it('returns an empty list for empty or whitespace-only input', () => {
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('   \t ')).toEqual([]);
  });

  it('splits on runs of whitespace', () => {
    expect(splitArgs('-o  ServerAliveInterval=30\t-C')).toEqual(['-o', 'ServerAliveInterval=30', '-C']);
  });

  it('keeps a double-quoted group as one argument without the quotes', () => {
    expect(splitArgs('-o "ProxyCommand ssh -W %h:%p jump"')).toEqual(['-o', 'ProxyCommand ssh -W %h:%p jump']);
  });

  it('keeps a single-quoted group as one argument without the quotes', () => {
    expect(splitArgs("-o 'User name with space'")).toEqual(['-o', 'User name with space']);
  });

  it('allows quotes inside a word to glue text together', () => {
    expect(splitArgs('-oProxyCommand="ssh jump"')).toEqual(['-oProxyCommand=ssh jump']);
  });

  it('treats an unterminated quote as running to the end of the input', () => {
    expect(splitArgs('-o "unterminated value')).toEqual(['-o', 'unterminated value']);
  });
});

import { joinArgs } from './split-args';

describe('joinArgs', () => {
  it('joins plain arguments with single spaces', () => {
    expect(joinArgs(['-o', 'ServerAliveInterval=30'])).toBe('-o ServerAliveInterval=30');
  });

  it('double-quotes arguments containing whitespace so the text round-trips through splitArgs', () => {
    const args = ['-o', 'ProxyCommand ssh -W %h:%p jump'];
    const text = joinArgs(args);
    expect(text).toBe('-o "ProxyCommand ssh -W %h:%p jump"');
    expect(splitArgs(text)).toEqual(args);
  });
});
