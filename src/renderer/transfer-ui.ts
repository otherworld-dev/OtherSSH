// The bits of UI drag-and-drop uploads need: a bar that asks where to send a
// drop when the shell hasn't said where it is, and toasts for progress.

export interface FolderQuestion {
  /** `"report.pdf"` or `3 items`. */
  what: string;
  /** Prefilled best guess. */
  path: string;
  /** Offer to teach the server, for shells that have never reported their folder. */
  canTeach: boolean;
  onTeach(): void;
}

const openBars = new WeakMap<HTMLElement, () => void>();

/** Ask over the terminal which remote folder to upload into. Resolves null if cancelled. */
export function askForFolder(host: HTMLElement, q: FolderQuestion): Promise<string | null> {
  openBars.get(host)?.(); // a second drop replaces the first question

  return new Promise((resolve) => {
    const bar = document.createElement('form');
    bar.className = 'drop-bar';
    const label = document.createElement('span');
    label.textContent = `Upload ${q.what} to`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = q.path;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Remote folder');
    const send = button('Send', 'primary', 'submit');
    const cancel = button('Cancel');
    bar.append(label, input, send, cancel);
    if (q.canTeach) {
      const teach = button('Teach this server so it stops asking', 'ghost');
      teach.title = "Adds a short prompt hook to ~/.bashrc on the server so its shell reports which folder it's in";
      teach.addEventListener('click', () => q.onTeach());
      bar.append(teach);
    }

    const finish = (value: string | null): void => {
      openBars.delete(host);
      bar.remove();
      resolve(value);
    };
    bar.addEventListener('submit', (ev) => {
      ev.preventDefault();
      finish(input.value.trim() || '~');
    });
    cancel.addEventListener('click', () => finish(null));
    bar.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // keep app shortcuts and the terminal out of it
      if (ev.key === 'Escape') finish(null);
    });
    bar.addEventListener('contextmenu', (ev) => ev.stopPropagation()); // the terminal's right-click pastes

    openBars.set(host, () => finish(null));
    host.append(bar);
    input.focus();
    input.select();
  });
}

export type ToastTone = 'busy' | 'ok' | 'info' | 'error';

export interface ToastAction {
  label: string;
  run(): void;
}

export interface Toast {
  update(message: string, tone: ToastTone, actions?: ToastAction[]): void;
  close(): void;
}

const OK_LINGER_MS = 5000;

export class Toasts {
  constructor(private readonly host: HTMLElement) {}

  show(message: string, tone: ToastTone, actions: ToastAction[] = []): Toast {
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'toast-text';
    const buttons = document.createElement('span');
    buttons.className = 'toast-actions';
    const dismiss = button('×', 'icon');
    dismiss.title = 'Dismiss';
    el.append(text, buttons, dismiss);

    let timer: number | undefined;
    const close = (): void => {
      window.clearTimeout(timer);
      el.remove();
    };
    const update = (msg: string, t: ToastTone, acts: ToastAction[] = []): void => {
      el.className = `toast ${t}`;
      text.textContent = msg;
      buttons.replaceChildren(
        ...acts.map((a) => {
          const b = button(a.label);
          b.addEventListener('click', () => {
            close();
            a.run();
          });
          return b;
        }),
      );
      window.clearTimeout(timer);
      if (t === 'ok') timer = window.setTimeout(close, OK_LINGER_MS);
    };

    dismiss.addEventListener('click', close);
    update(message, tone, actions);
    this.host.append(el);
    return { update, close };
  }
}

function button(text: string, cls = '', type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = type;
  b.textContent = text;
  if (cls) b.className = cls;
  return b;
}
