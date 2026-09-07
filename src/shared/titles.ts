/**
 * ConPTY reports the console title, which starts out as the spawned exe's path
 * (e.g. `C:\WINDOWS\System32\OpenSSH\ssh.exe`). Those are noise in a tab label;
 * titles set by the remote shell (`user@host: ~`) never look like a local path.
 */
export function isLocalProcessTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return false;
  return /^(?:[a-z]:\\|\\\\)/i.test(t);
}
