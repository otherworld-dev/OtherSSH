import { appendFileSync, renameSync, statSync } from 'node:fs';

const MAX_BYTES = 1024 * 1024;

/**
 * A plain text log in the data folder (otherssh.log), for the things that
 * happen with nobody watching, such as an update installing overnight. When it
 * passes 1 MB it moves to otherssh.log.old and starts again.
 */
export function createLog(file: string): (message: string) => void {
  return (message) => {
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.old`);
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Logging must never take the app down.
    }
  };
}
