export interface ResolveSshPathOptions {
  platform: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  /** User override from settings; used only if it exists on disk. */
  settingsPath?: string;
}

/**
 * Find the ssh binary to spawn.
 *
 * Order: settings override -> the platform's system ssh -> PATH scan.
 * On Windows the System32 OpenSSH build is preferred deliberately: it is the
 * only build that talks to the Windows ssh-agent service, whereas Git for
 * Windows' ssh (often first on PATH) uses its own agent socket.
 */
export function resolveSshPath(o: ResolveSshPathOptions): string | null {
  const isWin = o.platform === 'win32';
  const sep = isWin ? '\\' : '/';
  const join = (...parts: string[]): string => parts.join(sep);

  const candidates: string[] = [];
  const override = o.settingsPath?.trim();
  if (override) candidates.push(override);

  if (isWin) {
    candidates.push(join(o.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'));
  } else {
    candidates.push('/usr/bin/ssh');
  }

  const pathValue = o.env.PATH ?? o.env.Path ?? '';
  const dirs = pathValue.split(isWin ? ';' : ':').filter(Boolean);
  const names = isWin
    ? (o.env.PATHEXT ?? '.EXE').split(';').filter(Boolean).map((ext) => 'ssh' + ext.toLowerCase())
    : ['ssh'];
  for (const dir of dirs) {
    const trimmed = dir.replace(/[\\/]+$/, '');
    for (const name of names) candidates.push(join(trimmed, name));
  }

  return candidates.find((c) => o.exists(c)) ?? null;
}
