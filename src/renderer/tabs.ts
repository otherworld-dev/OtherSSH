import type { TerminalView } from './terminal-view';

export interface Tab {
  sessionId: string | null;
  title: string;
  alive: boolean;
  view: TerminalView;
  el: HTMLElement;
  labelEl: HTMLElement;
}

export interface TabBarHooks {
  onActivate(tab: Tab | null): void;
  onCloseClick(tab: Tab): void;
  onContextMenu(tab: Tab): void;
}

export class TabBar {
  private readonly tabs: Tab[] = [];
  private active: Tab | null = null;

  constructor(
    private readonly barEl: HTMLElement,
    private readonly terminalsEl: HTMLElement,
    private readonly emptyEl: HTMLElement,
    private readonly hooks: TabBarHooks,
  ) {}

  add(title: string, view: TerminalView): Tab {
    const el = document.createElement('div');
    el.className = 'tab';
    el.setAttribute('role', 'tab');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.className = 'label';
    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Close tab';
    close.textContent = '×';
    el.append(dot, label, close);

    const tab: Tab = { sessionId: null, title, alive: true, view, el, labelEl: label };
    this.setTitle(tab, title);

    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // keep focus in the terminal instead of moving it to the tab strip
      this.activate(tab);
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.hooks.onCloseClick(tab);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.activate(tab);
      this.hooks.onContextMenu(tab);
    });
    close.addEventListener('mousedown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onCloseClick(tab);
    });

    this.barEl.appendChild(el);
    view.mount(this.terminalsEl);
    this.tabs.push(tab);
    this.activate(tab);
    return tab;
  }

  remove(tab: Tab): void {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    tab.el.remove();
    tab.view.dispose();
    if (this.active === tab) {
      this.active = null;
      this.activate(this.tabs[Math.min(index, this.tabs.length - 1)] ?? null);
    }
  }

  activate(tab: Tab | null): void {
    if (this.active && this.active !== tab) {
      this.active.el.classList.remove('active');
      this.active.view.hide();
    }
    this.active = tab;
    this.emptyEl.hidden = tab !== null;
    if (tab) {
      tab.el.classList.add('active');
      this.setActivity(tab, false);
      tab.view.show();
      tab.el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    this.hooks.onActivate(tab);
  }

  /** Highlight a background tab that has produced output since it was last looked at. */
  setActivity(tab: Tab, on: boolean): void {
    tab.el.classList.toggle('activity', on);
  }

  cycle(direction: 1 | -1): void {
    if (!this.active || this.tabs.length < 2) return;
    const index = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(index + direction + this.tabs.length) % this.tabs.length]!);
  }

  get current(): Tab | null {
    return this.active;
  }

  get count(): number {
    return this.tabs.length;
  }

  all(): Tab[] {
    return [...this.tabs];
  }

  bySession(sessionId: string): Tab | undefined {
    return this.tabs.find((t) => t.sessionId === sessionId);
  }

  setTitle(tab: Tab, title: string): void {
    tab.title = title;
    tab.labelEl.textContent = title;
    tab.el.title = title;
    if (tab === this.active) this.hooks.onActivate(tab);
  }

  setAlive(tab: Tab, alive: boolean): void {
    tab.alive = alive;
    tab.el.classList.toggle('dead', !alive);
  }
}
