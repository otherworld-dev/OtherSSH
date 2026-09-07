/**
 * Split a one-line "extra args" string into argv, honouring double and single
 * quotes. Quotes are removed; an unterminated quote runs to the end of input.
 * No escape sequences: this only needs to cover things like
 *   -o "ProxyCommand ssh -W %h:%p jump"
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) {
        out.push(current);
        current = '';
        inWord = false;
      }
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (inWord) out.push(current);
  return out;
}

/** Inverse of splitArgs for display: arguments with whitespace are double-quoted. */
export function joinArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) || a === '' ? `"${a}"` : a)).join(' ');
}
