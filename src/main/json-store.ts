import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * One JSON document on disk. Writes are atomic (tmp + rename) and serialised
 * through a promise chain so rapid successive saves cannot interleave.
 * A corrupt file is moved aside as `<file>.bad` rather than crashing the app.
 */
export class JsonStore<T> {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(fallback: T): Promise<T> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw err;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      await rename(this.file, this.file + '.bad').catch(() => undefined);
      return fallback;
    }
  }

  set(value: T): Promise<void> {
    const text = JSON.stringify(value, null, 2);
    const run = this.queue.then(() => this.write(text));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(text: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.file);
  }
}
