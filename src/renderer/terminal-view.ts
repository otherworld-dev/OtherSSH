import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { Settings } from '../shared/types';

export type Shortcut = 'nextTab' | 'prevTab' | 'closeTab' | 'newTab' | 'toggleSidebar';

/** App-level shortcuts. Deliberately all Ctrl+Shift or Ctrl+Tab/PgUp/PgDn so nothing a shell wants is taken. */
export function matchShortcut(ev: KeyboardEvent): Shortcut | null {
  if (!ev.ctrlKey || ev.altKey) return null;
  const key = ev.key.toLowerCase();
  if (key === 'tab') return ev.shiftKey ? 'prevTab' : 'nextTab';
  if (!ev.shiftKey && key === 'pagedown') return 'nextTab';
  if (!ev.shiftKey && key === 'pageup') return 'prevTab';
  if (ev.shiftKey && key === 'w') return 'closeTab';
  if (ev.shiftKey && key === 't') return 'newTab';
  if (ev.shiftKey && key === 'b') return 'toggleSidebar';
  return null;
}

export interface TerminalViewHooks {
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  onTitle(title: string): void;
  onShortcut(shortcut: Shortcut): void;
  /** Enter pressed in a dead tab. */
  onCloseRequest(): void;
  /** "r" pressed in a dead tab that can be reconnected. */
  onReconnectRequest(): void;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): void;
  /** Ctrl+click on a URL. */
  openExternal(url: string): void;
}

const MIN_FONT = 6;
const MAX_FONT = 40;

const THEME: ITheme = {
  background: '#14161a',
  foreground: '#d6d9de',
  cursor: '#e6e6e6',
  cursorAccent: '#14161a',
  selectionBackground: '#3a4a6a',
  black: '#1e2126',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
};

/** One xterm instance plus the host element it lives in. Knows nothing about sessions. */
export class TerminalView {
  readonly element = document.createElement('div');
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly serializer = new SerializeAddon();
  private opened = false;
  private dead = false;
  private canReconnect = false;
  private baseFontSize: number;
  /** Per-session zoom in font-size steps, on top of the settings value. */
  private zoom = 0;

  constructor(settings: Settings, windowsBuildNumber: number | undefined, private readonly hooks: TerminalViewHooks) {
    this.element.className = 'term-host';
    this.baseFontSize = settings.fontSize;
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      theme: THEME,
      windowsPty: windowsBuildNumber ? { backend: 'conpty', buildNumber: windowsBuildNumber } : undefined,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(
      new WebLinksAddon((ev, uri) => {
        if (ev.ctrlKey || ev.metaKey) hooks.openExternal(uri);
      }),
    );
    this.term.attachCustomKeyEventHandler((ev) => this.handleKey(ev));
    this.element.addEventListener('contextmenu', (ev) => this.handleRightClick(ev));
    this.element.addEventListener(
      'wheel',
      (ev) => {
        if (!ev.ctrlKey) return;
        ev.preventDefault();
        this.zoomBy(ev.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
    this.term.onData((data) => this.handleInput(data));
    this.term.onResize(({ cols, rows }) => hooks.onResize(cols, rows));
    this.term.onTitleChange((title) => hooks.onTitle(title));
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.element);
  }

  show(): void {
    this.element.classList.add('active');
    if (!this.opened) {
      this.term.open(this.element);
      this.opened = true;
    }
    this.fitNow();
    this.term.focus();
  }

  hide(): void {
    this.element.classList.remove('active');
  }

  /** Fit to the host element. Safe to call when hidden: it does nothing then. */
  fitNow(): void {
    if (!this.opened || this.element.offsetParent === null) return;
    try {
      this.fit.fit();
    } catch {
      // Not measurable yet; the next resize will fit.
    }
  }

  write(data: string, callback?: () => void): void {
    this.term.write(data, callback);
  }

  /** Screen + scrollback + modes as ANSI, taken after everything queued has been parsed. */
  serialize(scrollback: number): Promise<string> {
    return new Promise((resolve) => {
      this.term.write('', () => resolve(this.serializer.serialize({ scrollback })));
    });
  }

  markDead(exitCode: number | undefined, canReconnect: boolean): void {
    if (this.dead) return;
    this.dead = true;
    this.canReconnect = canReconnect;
    const code = exitCode === undefined ? '' : ` with code ${exitCode}`;
    const hint = canReconnect ? 'Enter: close tab   r: reconnect' : 'Enter: close tab';
    this.term.write(`\r\n\x1b[90m[process exited${code}]  ${hint}\x1b[0m\r\n`);
  }

  get isDead(): boolean {
    return this.dead;
  }

  revive(): void {
    this.dead = false;
    this.term.reset();
  }

  applySettings(settings: Settings): void {
    this.baseFontSize = settings.fontSize;
    this.term.options.fontFamily = settings.fontFamily;
    this.term.options.scrollback = settings.scrollback;
    this.applyFontSize();
  }

  zoomBy(steps: number): void {
    const next = Math.max(MIN_FONT, Math.min(MAX_FONT, this.baseFontSize + this.zoom + steps));
    this.zoom = next - this.baseFontSize;
    this.applyFontSize();
  }

  resetZoom(): void {
    this.zoom = 0;
    this.applyFontSize();
  }

  get fontSize(): number {
    return this.term.options.fontSize ?? this.baseFontSize;
  }

  private applyFontSize(): void {
    this.term.options.fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, this.baseFontSize + this.zoom));
    this.fitNow();
  }

  focus(): void {
    this.term.focus();
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  dispose(): void {
    this.term.dispose();
    this.element.remove();
  }

  private handleInput(data: string): void {
    if (!this.dead) {
      this.hooks.onInput(data);
      return;
    }
    if (data === '\r') this.hooks.onCloseRequest();
    else if ((data === 'r' || data === 'R') && this.canReconnect) this.hooks.onReconnectRequest();
  }

  /** Smart right-click: copy the selection if there is one, otherwise paste. No menu. */
  private handleRightClick(ev: MouseEvent): void {
    ev.preventDefault();
    if (this.term.hasSelection()) {
      this.hooks.writeClipboard(this.term.getSelection());
      this.term.clearSelection();
      return;
    }
    if (this.dead) return; // a pasted newline would otherwise read as "close tab"
    void this.hooks.readClipboard().then((text) => {
      if (text) this.term.paste(text);
    });
    this.term.focus();
  }

  private zoomKey(ev: KeyboardEvent, steps: number): false {
    ev.preventDefault();
    if (steps === 0) this.resetZoom();
    else this.zoomBy(steps);
    return false;
  }

  private handleKey(ev: KeyboardEvent): boolean {
    if (ev.type !== 'keydown') return true;
    const key = ev.key.toLowerCase();
    const mod = ev.ctrlKey || ev.metaKey;

    if (mod && ev.shiftKey && !ev.altKey && key === 'c') {
      ev.preventDefault();
      if (this.term.hasSelection()) this.hooks.writeClipboard(this.term.getSelection());
      return false; // never let xterm turn this into ^C
    }
    if (mod && ev.shiftKey && !ev.altKey && key === 'v') {
      ev.preventDefault(); // stop Chromium's own paste into xterm's textarea, which would double-paste
      void this.hooks.readClipboard().then((text) => {
        if (text) this.term.paste(text);
      });
      return false;
    }
    if (ev.ctrlKey && !ev.altKey) {
      // Windows Terminal's zoom keys; per session, Ctrl+0 resets.
      if (key === '=' || key === '+') return this.zoomKey(ev, 1);
      if (!ev.shiftKey && key === '-') return this.zoomKey(ev, -1);
      if (!ev.shiftKey && key === '0') return this.zoomKey(ev, 0);
    }
    const shortcut = matchShortcut(ev);
    if (shortcut) {
      ev.preventDefault();
      this.hooks.onShortcut(shortcut);
      return false;
    }
    return true; // everything else, including plain Ctrl+C, goes to the pty
  }
}
