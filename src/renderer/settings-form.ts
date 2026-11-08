import type { Settings, UpdateChannel, UpdateMode, UpdateStatus } from '../shared/types';

export interface UpdateControls {
  status(): Promise<UpdateStatus>;
  check(): Promise<void>;
  install(): Promise<void>;
  onStatus(cb: (status: UpdateStatus) => void): () => void;
}

export class SettingsForm {
  private resolve: ((patch: Partial<Settings> | null) => void) | null = null;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly browse: (defaultPath?: string) => Promise<string | undefined>,
    private readonly updates: UpdateControls,
  ) {
    updates.onStatus((status) => this.showStatus(status));
    this.q('#st-update-check').addEventListener('click', () => void updates.check());
    this.q('#st-update-install').addEventListener('click', () => {
      updates.install().catch((err: unknown) => {
        this.q('#st-update-status').textContent = errorText(err);
      });
    });
    this.q<HTMLFormElement>('#settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const patch = this.read();
      const resolve = this.resolve;
      this.resolve = null;
      this.dialog.close();
      resolve?.(patch);
    });
    this.q('#st-cancel').addEventListener('click', () => this.dialog.close());
    this.q('#st-browse').addEventListener('click', async () => {
      const chosen = await this.browse(this.field('st-ssh').value || undefined);
      if (chosen) this.field('st-ssh').value = chosen;
    });
    this.dialog.addEventListener('close', () => {
      const resolve = this.resolve;
      this.resolve = null;
      resolve?.(null);
    });
  }

  open(settings: Settings, resolvedSshPath: string | null): Promise<Partial<Settings> | null> {
    this.field('st-ssh').value = settings.sshPath ?? '';
    this.q('#st-resolved').textContent = resolvedSshPath ?? 'not found';
    this.field('st-font').value = settings.fontFamily;
    this.field('st-size').value = String(settings.fontSize);
    this.field('st-scrollback').value = String(settings.scrollback);
    this.q<HTMLSelectElement>('#st-update-mode').value = settings.updateMode;
    this.q<HTMLSelectElement>('#st-update-channel').value = settings.updateChannel;
    void this.updates.status().then((status) => this.showStatus(status));
    this.dialog.showModal();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private read(): Partial<Settings> {
    const patch: Partial<Settings> = { sshPath: this.field('st-ssh').value.trim() };
    const font = this.field('st-font').value.trim();
    if (font) patch.fontFamily = font;
    const size = Number(this.field('st-size').value);
    if (Number.isFinite(size) && size >= 6 && size <= 72) patch.fontSize = size;
    const scrollback = Number(this.field('st-scrollback').value);
    if (Number.isFinite(scrollback) && scrollback >= 0) patch.scrollback = scrollback;
    patch.updateMode = this.q<HTMLSelectElement>('#st-update-mode').value as UpdateMode;
    patch.updateChannel = this.q<HTMLSelectElement>('#st-update-channel').value as UpdateChannel;
    return patch;
  }

  private showStatus(status: UpdateStatus): void {
    this.q('#st-update-version').textContent = `Version ${status.version}`;
    this.q('#st-update-status').textContent = status.status;
    this.q<HTMLButtonElement>('#st-update-check').disabled = status.checking;
    this.q('#st-update-install').hidden = !(status.ready && status.canInstall);
  }

  private field(id: string): HTMLInputElement {
    return this.q<HTMLInputElement>('#' + id);
  }

  private q<T extends Element = HTMLElement>(selector: string): T {
    const el = this.dialog.querySelector<T>(selector);
    if (!el) throw new Error(`Missing ${selector}`);
    return el;
  }
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
