/** Where an upload dropped on a terminal should go, and whether we trust it enough not to ask. */
export interface CwdGuess {
  /** Absolute, `~`, or `~/...`; scp resolves the last two against the login user's home. */
  path: string;
  /** True only while the shell is sitting at a prompt that reported this directory itself. */
  sure: boolean;
}

/**
 * Follows a remote shell's working directory from what it prints.
 *
 * A shell taught by OtherSSH reports its directory as OSC 7 before every
 * prompt, with this session's secret token attached (OtherSSH hands the token
 * to the server as LC_OTHERSSH_NONCE when it connects). Only a report carrying
 * the token is treated as certain: anything else in the output, such as a file
 * being cat'd that contains a forged OSC 7, can only prefill the question.
 * Pressing Enter makes it uncertain again until the next report, so a drop
 * while vim, `sudo -i` or a nested ssh is in charge asks instead of guessing.
 * Ubuntu's default prompt also puts `user@host: dir` in the window title,
 * which is good enough to prefill the question.
 */
export class CwdTracker {
  private host: string | undefined;
  private path: string | undefined;
  private sure = false;

  /** The session's token; empty when the session has none, so nothing is ever certain. */
  constructor(private token = '') {}

  setToken(token: string): void {
    this.token = token;
  }

  /** Payload of an OSC 7 sequence, e.g. `file://web01/var/www?otherssh=<token>`. */
  report(payload: string): void {
    const parsed = parseOsc7(payload);
    if (!parsed) return;
    const verified = this.token !== '' && parsed.token === this.token;
    if (!verified) {
      // Unproven: at most a guess for the question, never a reason to skip it.
      if (!this.sure) this.path = parsed.path;
      return;
    }
    this.host ??= parsed.host;
    if (parsed.host !== this.host) {
      // Another machine claiming our token: uploads would not land there, so never trust it.
      this.sure = false;
      return;
    }
    this.path = parsed.path;
    this.sure = true;
  }

  title(title: string): void {
    if (this.sure) return;
    const path = pathFromTitle(title);
    if (path) this.path = path;
  }

  input(data: string): void {
    if (data.includes('\r')) this.sure = false;
  }

  /** A reconnect starts a new shell; the token stays with the session. */
  reset(): void {
    this.host = undefined;
    this.path = undefined;
    this.sure = false;
  }

  /** Has this session's shell ever made a verified report? If not, offer to teach the server. */
  get taught(): boolean {
    return this.host !== undefined;
  }

  get current(): CwdGuess {
    return { path: this.path ?? '~', sure: this.sure && this.path !== undefined };
  }
}

export function parseOsc7(payload: string): { host: string; path: string; token: string } | null {
  const m = /^file:\/\/([^/?#]*)(\/[^?#]*)(?:\?([^#]*))?/.exec(payload);
  if (!m) return null;
  let path = m[2]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not percent-encoded after all; take it as written.
  }
  if (hasControlChars(path)) return null;
  const token = new URLSearchParams(m[3] ?? '').get('otherssh') ?? '';
  return { host: m[1]!.toLowerCase(), path, token };
}

/** `alice@web01: ~/site` (Ubuntu's default xterm title) -> `~/site`. */
export function pathFromTitle(title: string): string | null {
  const m = /^[^@\s]+@[^:\s]+:\s*(~|~\/.*|\/.*)$/.exec(title.trim());
  if (!m || hasControlChars(m[1]!)) return null;
  return m[1]!;
}

export function hasControlChars(s: string): boolean {
  return /[\x00-\x1f\x7f]/.test(s);
}
