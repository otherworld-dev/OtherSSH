import type { QuickTarget } from './types';

const PATTERN = /^(?:ssh\s+)?(?:([^\s@:]+)@)?([^\s@:-][^\s@:]*)(?::(\d{1,5}))?$/;

/** Parse `[user@]host[:port]` (optionally prefixed with `ssh `) typed into the filter box. */
export function parseQuickConnect(text: string): QuickTarget | null {
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  const [, user, host, portText] = match;
  if (!host) return null;
  const target: QuickTarget = { host };
  if (user) target.user = user;
  if (portText !== undefined) {
    const port = Number(portText);
    if (port < 1 || port > 65535) return null;
    target.port = port;
  }
  return target;
}
