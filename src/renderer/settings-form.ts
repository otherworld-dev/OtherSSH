import type { McpStatus, Settings, UpdateChannel, UpdateMode, UpdateStatus } from '../shared/types';

export interface UpdateControls {
  status(): Promise<UpdateStatus>;
  check(): Promise<void>;
  install(): Promise<void>;
  onStatus(cb: (status: UpdateStatus) => void): () => void;
}

export interface McpControls {
  status(): Promise<McpStatus>;
  newToken(): Promise<Settings>;
  onStatus(cb: (status: McpStatus) => void): () => void;
  copy(text: string): void;
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** The server as an entry for any MCP client that takes an mcpServers JSON config. */
export function mcpJsonEntry(port: number, token: string): string {
  return JSON.stringify({ otherssh: { type: 'http', url: mcpUrl(port), headers: { Authorization: `Bearer ${token}` } } }, null, 2);
}

/** The one-off command that adds OtherSSH to Claude Code, for every project. */
export function claudeAddCommand(port: number, token: string): string {
  return `claude mcp add --transport http --scope user otherssh ${mcpUrl(port)} --header "Authorization: Bearer ${token}"`;
}

export class SettingsForm {
  private resolve: ((patch: Partial<Settings> | null) => void) | null = null;
  private current: Settings | null = null;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly browse: (defaultPath?: string) => Promise<string | undefined>,
    private readonly updates: UpdateControls,
    private readonly mcp: McpControls,
  ) {
    mcp.onStatus((status) => this.showMcp(status));
    const copyButton = (id: string, text: (port: number, token: string) => string): void => {
      const button = this.q<HTMLButtonElement>(id);
      const label = button.textContent ?? 'Copy';
      button.addEventListener('click', () => {
        const s = this.current;
        if (!s?.mcpToken) return;
        mcp.copy(text(s.mcpPort, s.mcpToken));
        button.textContent = 'Copied';
        window.setTimeout(() => (button.textContent = label), 1500);
      });
    };
    copyButton('#st-mcp-url-copy', (port) => mcpUrl(port));
    copyButton('#st-mcp-header-copy', () => 'Authorization');
    copyButton('#st-mcp-token-copy', (_port, token) => `Bearer ${token}`);
    copyButton('#st-mcp-json', mcpJsonEntry);
    copyButton('#st-mcp-copy', claudeAddCommand);
    this.q('#st-mcp-token').addEventListener('click', async () => {
      this.current = await mcp.newToken();
      this.showConnection();
    });
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
    this.current = settings;
    this.q<HTMLInputElement>('#st-mcp-enabled').checked = settings.mcpEnabled;
    this.field('st-mcp-port').value = String(settings.mcpPort);
    this.showConnection();
    void this.mcp.status().then((status) => this.showMcp(status));
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
    patch.mcpEnabled = this.q<HTMLInputElement>('#st-mcp-enabled').checked;
    const port = Number(this.field('st-mcp-port').value);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) patch.mcpPort = port;
    return patch;
  }

  private showStatus(status: UpdateStatus): void {
    this.q('#st-update-version').textContent = `Version ${status.version}`;
    this.q('#st-update-status').textContent = status.status;
    this.q<HTMLButtonElement>('#st-update-check').disabled = status.checking;
    this.q('#st-update-install').hidden = !(status.ready && status.canInstall);
  }

  /** URL and token as saved; the token is shown cut short, and only copied whole. */
  private showConnection(): void {
    const s = this.current;
    const token = s?.mcpToken;
    this.q('#st-mcp-url').textContent = s ? mcpUrl(s.mcpPort) : '';
    this.q('#st-mcp-token-text').textContent = token ? `Bearer ${token.slice(0, 6)}…` : 'Turn it on and save to make one.';
    for (const id of ['#st-mcp-url-copy', '#st-mcp-header-copy', '#st-mcp-token-copy', '#st-mcp-token', '#st-mcp-json', '#st-mcp-copy']) {
      this.q<HTMLButtonElement>(id).disabled = !token;
    }
  }

  private showMcp(status: McpStatus): void {
    this.q('#st-mcp-status').textContent = status.status;
    const items = status.recent.map((a) => {
      const li = document.createElement('li');
      li.className = a.ok ? 'ok' : 'fail';
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = new Date(a.at).toLocaleTimeString();
      li.append(when, `${a.tool}${a.target ? ` · ${a.target}` : ''}${a.ok ? '' : ` · ${a.detail ?? 'failed'}`}`);
      li.title = li.textContent ?? '';
      return li;
    });
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'when';
      li.textContent = 'Nothing yet.';
      items.push(li);
    }
    this.q('#st-mcp-recent').replaceChildren(...items);
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
