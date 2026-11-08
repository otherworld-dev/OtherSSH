import type { QuickTarget, SessionProfile } from '../shared/types';
import { groupNames, groupProfiles } from '../shared/grouping';
import { parseQuickConnect } from '../shared/quick-connect';

export interface SidebarElements {
  list: HTMLElement;
  filter: HTMLInputElement;
  connect: HTMLButtonElement;
  add: HTMLButtonElement;
  edit: HTMLButtonElement;
  remove: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  settings: HTMLButtonElement;
}

export interface SidebarHooks {
  onConnect(profile: SessionProfile): void;
  /** Enter in the filter box with no matching session but a parseable `[user@]host[:port]`. */
  onQuickConnect(target: QuickTarget): void;
  onNew(): void;
  onEdit(profile: SessionProfile): void;
  onDelete(profile: SessionProfile): void;
  onContextMenu(profile: SessionProfile): void;
  onImport(): void;
  onSettings(): void;
}

const COLLAPSED_KEY = 'otherssh.collapsedGroups';

export class Sidebar {
  private profiles: SessionProfile[] = [];
  private selectedId: string | null = null;
  private readonly collapsed = new Set<string>(loadCollapsed());

  constructor(
    private readonly els: SidebarElements,
    private readonly hooks: SidebarHooks,
  ) {
    els.filter.addEventListener('input', () => this.render());
    els.filter.addEventListener('keydown', (e) => this.handleKey(e, true));
    els.list.addEventListener('keydown', (e) => this.handleKey(e, false));
    els.connect.addEventListener('click', () => this.connectSelected());
    els.add.addEventListener('click', () => hooks.onNew());
    els.edit.addEventListener('click', () => {
      const p = this.selected();
      if (p) hooks.onEdit(p);
    });
    els.remove.addEventListener('click', () => {
      const p = this.selected();
      if (p) hooks.onDelete(p);
    });
    els.importBtn.addEventListener('click', () => hooks.onImport());
    els.settings.addEventListener('click', () => hooks.onSettings());
  }

  setProfiles(list: SessionProfile[]): void {
    this.profiles = [...list];
    if (!this.profiles.some((p) => p.id === this.selectedId)) this.selectedId = null;
    this.render();
  }

  selected(): SessionProfile | null {
    return this.profiles.find((p) => p.id === this.selectedId) ?? null;
  }

  get(id: string): SessionProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  groupNames(): string[] {
    return groupNames(this.profiles);
  }

  focusFilter(): void {
    this.els.filter.focus();
    this.els.filter.select();
  }

  private query(): string {
    return this.els.filter.value.trim();
  }

  /** Sessions in display order, skipping collapsed groups (everything is expanded while filtering). */
  private visible(): SessionProfile[] {
    const query = this.query();
    const { ungrouped, groups } = groupProfiles(this.profiles, query);
    return [...ungrouped, ...groups.filter((g) => query !== '' || !this.collapsed.has(g.name)).flatMap((g) => g.profiles)];
  }

  private connectSelected(): void {
    const p = this.selected() ?? this.visible()[0];
    if (p) {
      this.hooks.onConnect(p);
      return;
    }
    const target = parseQuickConnect(this.query());
    if (target) this.hooks.onQuickConnect(target);
  }

  private handleKey(e: KeyboardEvent, fromFilter: boolean): void {
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        this.connectSelected();
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.moveSelection(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveSelection(-1);
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (fromFilter) return;
        e.preventDefault();
        const group = this.selected()?.group?.trim();
        if (group) this.setCollapsed(group, e.key === 'ArrowLeft');
        break;
      }
      case 'Delete': {
        if (fromFilter) return;
        const p = this.selected();
        if (p) this.hooks.onDelete(p);
        break;
      }
      case 'F2': {
        const p = this.selected();
        if (p) this.hooks.onEdit(p);
        break;
      }
      case 'Escape':
        if (fromFilter && this.els.filter.value) {
          this.els.filter.value = '';
          this.render();
        }
        break;
    }
  }

  private moveSelection(direction: 1 | -1): void {
    const list = this.visible();
    if (list.length === 0) return;
    const index = list.findIndex((p) => p.id === this.selectedId);
    const next = index < 0 ? (direction > 0 ? list[0] : list[list.length - 1]) : list[Math.max(0, Math.min(list.length - 1, index + direction))];
    if (next) this.select(next.id);
  }

  private select(id: string): void {
    this.selectedId = id;
    this.render();
  }

  private setCollapsed(group: string, collapsed: boolean): void {
    if (collapsed) {
      this.collapsed.add(group);
      if (this.selected()?.group?.trim() === group) this.selectedId = null;
    } else {
      this.collapsed.delete(group);
    }
    saveCollapsed(this.collapsed);
    this.render();
  }

  private render(): void {
    const query = this.query();
    const filtering = query !== '';
    const { ungrouped, groups } = groupProfiles(this.profiles, query);

    const items: HTMLElement[] = ungrouped.map((p) => this.profileItem(p, false));
    for (const group of groups) {
      const collapsed = !filtering && this.collapsed.has(group.name);
      items.push(this.groupHeader(group.name, group.profiles.length, collapsed, filtering));
      if (!collapsed) items.push(...group.profiles.map((p) => this.profileItem(p, true)));
    }
    const quick = filtering && items.length === 0 ? parseQuickConnect(query) : null;
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'profile placeholder';
      if (quick) li.textContent = `Enter connects to ${describeTarget(quick)}`;
      else li.textContent = this.profiles.length === 0 ? 'No saved sessions yet' : 'No matches';
      items.push(li);
    }
    this.els.list.replaceChildren(...items);
    this.els.list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });

    const has = this.selected() !== null;
    this.els.connect.disabled = !has && this.visible().length === 0 && !quick;
    this.els.edit.disabled = !has;
    this.els.remove.disabled = !has;
  }

  private profileItem(p: SessionProfile, grouped: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'profile' + (grouped ? ' grouped' : '') + (p.id === this.selectedId ? ' selected' : '');
    li.dataset['id'] = p.id;
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = describe(p);
    li.append(name, sub);
    li.addEventListener('click', () => this.select(p.id));
    li.addEventListener('dblclick', () => this.hooks.onConnect(p));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.select(p.id);
      this.hooks.onContextMenu(p);
    });
    return li;
  }

  private groupHeader(name: string, count: number, collapsed: boolean, filtering: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'group-header' + (collapsed ? ' collapsed' : '') + (filtering ? ' static' : '');
    li.dataset['group'] = name;
    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = '▾';
    const label = document.createElement('span');
    label.className = 'group-name';
    label.textContent = name;
    const countEl = document.createElement('span');
    countEl.className = 'count';
    countEl.textContent = String(count);
    li.append(chevron, label, countEl);
    if (!filtering) {
      li.title = collapsed ? 'Expand' : 'Collapse';
      li.addEventListener('click', () => this.setCollapsed(name, !collapsed));
    }
    return li;
  }
}

function describe(p: SessionProfile): string {
  const port = p.port && p.port !== 22 ? `:${p.port}` : '';
  const dest = `${p.user ? p.user + '@' : ''}${p.host}${port}`;
  return dest === p.name ? (p.identityFile ? `key: ${p.identityFile}` : 'ssh') : dest;
}

export function describeTarget(t: QuickTarget): string {
  return `${t.user ? t.user + '@' : ''}${t.host}${t.port && t.port !== 22 ? ':' + t.port : ''}`;
}

function loadCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage unavailable; collapse state is a convenience only.
  }
}
