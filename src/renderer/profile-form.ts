import type { SessionProfile } from '../shared/types';
import { joinArgs, splitArgs } from '../shared/split-args';

export interface ProfileFormResult {
  profile: SessionProfile;
  connect: boolean;
}

export class ProfileForm {
  private resolve: ((result: ProfileFormResult | null) => void) | null = null;
  private editing: SessionProfile | null = null;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly browse: (defaultPath?: string) => Promise<string | undefined>,
  ) {
    const form = this.q<HTMLFormElement>('#profile-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      const profile = this.read();
      if (!profile) return;
      const resolve = this.resolve;
      this.resolve = null;
      this.dialog.close();
      resolve?.({ profile, connect: submitter?.value === 'connect' });
    });
    this.q('#pf-cancel').addEventListener('click', () => this.dialog.close());
    this.q('#pf-browse').addEventListener('click', async () => {
      const chosen = await this.browse(this.field('pf-identity').value || undefined);
      if (chosen) this.field('pf-identity').value = chosen;
    });
    // Covers Esc and Cancel: anything that closes the dialog without a submit resolves null.
    this.dialog.addEventListener('close', () => {
      const resolve = this.resolve;
      this.resolve = null;
      resolve?.(null);
    });
  }

  open(profile?: SessionProfile, groups: string[] = []): Promise<ProfileFormResult | null> {
    this.editing = profile ?? null;
    this.q('#pf-title').textContent = profile ? (profile.id ? 'Edit session' : 'Duplicate session') : 'New session';
    this.field('pf-name').value = profile?.name ?? '';
    this.field('pf-group').value = profile?.group ?? '';
    this.q<HTMLDataListElement>('#pf-groups').replaceChildren(
      ...groups.map((g) => {
        const option = document.createElement('option');
        option.value = g;
        return option;
      }),
    );
    this.field('pf-host').value = profile?.host ?? '';
    this.field('pf-user').value = profile?.user ?? '';
    this.field('pf-port').value = profile?.port ? String(profile.port) : '';
    this.field('pf-identity').value = profile?.identityFile ?? '';
    this.field('pf-extra').value = profile?.extraArgs ? joinArgs(profile.extraArgs) : '';
    this.showError(null);
    this.dialog.showModal();
    this.field(profile ? 'pf-name' : 'pf-host').focus();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private read(): SessionProfile | null {
    const host = this.field('pf-host').value.trim();
    if (!host || host.startsWith('-')) {
      this.showError('Host is required and cannot start with "-".');
      this.field('pf-host').focus();
      return null;
    }
    let port: number | undefined;
    const portText = this.field('pf-port').value.trim();
    if (portText) {
      port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        this.showError('Port must be a whole number from 1 to 65535.');
        this.field('pf-port').focus();
        return null;
      }
    }
    const user = this.field('pf-user').value.trim() || undefined;
    const identityFile = this.field('pf-identity').value.trim() || undefined;
    const extraArgs = splitArgs(this.field('pf-extra').value);
    const group = this.field('pf-group').value.trim() || undefined;
    const name = this.field('pf-name').value.trim() || (user ? `${user}@${host}` : host);
    return {
      id: this.editing?.id ?? '',
      name,
      host,
      user,
      port,
      identityFile,
      extraArgs: extraArgs.length ? extraArgs : undefined,
      group,
    };
  }

  private showError(message: string | null): void {
    const el = this.q<HTMLElement>('#pf-error');
    el.textContent = message ?? '';
    el.hidden = message === null;
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
