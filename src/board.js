// The board: Claude Code sessions in the editor area, arranged as a grid of
// editor groups. Each pane is either a chat view (our webview driving the CLI
// in stream-json mode) or the CLI itself in a terminal. VS Code handles dragging
// tabs between panes, resizing sashes and maximizing a pane.

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const sessions = require('./sessions');
const { ChatPanel } = require('./chat/panel');

const COLORS = ['terminal.ansiBlue', 'terminal.ansiGreen', 'terminal.ansiMagenta', 'terminal.ansiCyan',
  'terminal.ansiYellow', 'terminal.ansiRed', 'terminal.ansiBrightBlue', 'terminal.ansiBrightGreen',
  'terminal.ansiBrightMagenta', 'terminal.ansiBrightCyan'];

const POLL_MS = 2000;
const STALL_MS = 12000; // terminal mid-turn with no transcript writes this long: likely waiting on you

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** rows x cols for n panes; last row may be shorter so there are no empty panes. */
function gridShape(n) {
  if (n <= 1) return [1];
  if (n <= 3) return [n];
  const cols = n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const shape = Array(rows).fill(cols);
  shape[rows - 1] = n - cols * (rows - 1);
  return shape;
}

async function applyGrid(n) {
  const shape = gridShape(n);
  // orientation 1 = rows stacked vertically, each row split into columns.
  // Group numbering (ViewColumn) then follows reading order.
  const layout = shape.length === 1
    ? { orientation: 0, groups: shape[0] === 1 ? [{}] : Array.from({ length: shape[0] }, () => ({ size: 1 / shape[0] })) }
    : {
      orientation: 1,
      groups: shape.map(cols => ({ size: 1 / shape.length, groups: Array.from({ length: cols }, () => ({ size: 1 / cols })) })),
    };
  await vscode.commands.executeCommand('vscode.setEditorLayout', layout);
}

const isOurTab = tab => tab.input instanceof vscode.TabInputTerminal
  || (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('claudeCC.chat'));

class Board {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /**
     * sessionId -> entry. entry.view is a ChatPanel (kind 'chat') or a vscode.Terminal (kind 'terminal').
     * @type {Map<string, {kind: string, view: any, name: string, project: string, sessionId: string, title: string,
     *   file: string, state: string, lastChange: number, size: number}>}
     */
    this.open = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this.saveTimer = undefined;

    context.subscriptions.push(
      vscode.window.onDidCloseTerminal(t => {
        const e = [...this.open.values()].find(x => x.view === t);
        if (e) this.handleClosed(e, t.exitStatus && t.exitStatus.reason === vscode.TerminalExitReason.Shutdown);
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleSave()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.scheduleSave()),
      { dispose: () => clearInterval(this.poller) },
    );
    this.poller = setInterval(() => this.poll(), POLL_MS);
  }

  defaultKind() {
    return vscode.workspace.getConfiguration('claudeCC').get('defaultView') === 'terminal' ? 'terminal' : 'chat';
  }

  // ---- persistence -------------------------------------------------------

  get store() {
    // Per workspace, so a second VS Code window does not reopen (and fight over) the same sessions.
    return vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders
      ? this.context.workspaceState : this.context.globalState;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
  }

  save() {
    if (this.shuttingDown) return;
    const columns = this.columnsByName();
    const items = [...this.open.values()].map(e => ({
      project: e.project, sessionId: e.sessionId, title: e.title, kind: e.kind, column: columns.get(e.name) || 99,
    })).sort((a, b) => a.column - b.column);
    this.store.update('board', { items });
    this._onDidChange.fire();
  }

  /** pane name -> editor group index (1-based, reading order) */
  columnsByName() {
    const map = new Map();
    vscode.window.tabGroups.all.forEach((g, i) => {
      for (const tab of g.tabs) if (isOurTab(tab)) map.set(tab.label, i + 1);
    });
    return map;
  }

  async restore() {
    const saved = this.store.get('board');
    if (!saved || !saved.items || !saved.items.length) {
      vscode.window.showInformationMessage('No saved board for this window yet.');
      return;
    }
    const todo = saved.items.filter(i => !this.open.has(i.sessionId));
    if (!todo.length) return;
    // Rebuild the same number of panes, then put each session back in its pane.
    const cols = [...new Set(saved.items.map(i => i.column))].sort((a, b) => a - b);
    await applyGrid(cols.length);
    for (const item of todo) {
      await this.openSession(item.project, item.sessionId, {
        column: cols.indexOf(item.column) + 1, title: item.title, quiet: true, kind: item.kind || 'terminal',
      });
    }
  }

  // ---- opening sessions --------------------------------------------------

  /**
   * @param {string} project folder the session runs in (its cwd)
   * @param {string|undefined} sessionId existing session to resume; undefined = new session
   * @param {{column?: number, mode?: 'board'|'tab', fork?: boolean, title?: string, quiet?: boolean, kind?: 'chat'|'terminal', startDelay?: number}} opts
   */
  async openSession(project, sessionId, opts = {}) {
    if (sessionId && !opts.fork && this.open.has(sessionId)) {
      this.reveal(this.open.get(sessionId));
      return;
    }
    const kind = opts.kind || this.defaultKind();
    const id = sessionId && !opts.fork ? sessionId : crypto.randomUUID();
    const title = opts.title || (opts.fork ? 'fork' : sessionId ? 'session' : 'new session');
    const column = opts.column || (opts.mode === 'tab' ? vscode.ViewColumn.Active : await this.nextFreeColumn());
    const name = this.uniqueName(`${path.basename(project)} · ${short(title)}`);
    const file = sessions.sessionFile(project, id);

    const entry = { kind, view: undefined, name, project, sessionId: id, title, file, state: 'idle', lastChange: Date.now(), size: 0 };
    if (kind === 'chat') {
      const panel = new ChatPanel(this.context, {
        project, sessionId: id, resume: !!sessionId && !opts.fork, fork: opts.fork ? sessionId : undefined, title, name,
        column, preserveFocus: !!opts.quiet, startDelay: opts.startDelay || 0, transcript: opts.fork ? sessions.sessionFile(project, sessionId) : file,
      });
      panel.onState(s => this.setState(entry, s));
      panel.onDidDispose(() => this.handleClosed(entry, false));
      entry.view = panel;
    } else {
      entry.view = this.createTerminal(project, sessionId, id, name, column, opts);
      const st = sessions.activityState(file);
      entry.state = st.state === 'working' ? 'working' : 'idle';
      entry.size = st.size;
    }
    this.open.set(id, entry);
    // Tabs appear asynchronously; wait so the next placement sees this pane as taken.
    for (let i = 0; i < 40 && !this.columnsByName().has(name); i++) await sleep(50);
    this.scheduleSave();
  }

  createTerminal(project, sessionId, id, name, column, opts) {
    const cfg = vscode.workspace.getConfiguration('claudeCC');
    let cmd = quoteCmd(cfg.get('claudeCommand') || 'claude');
    if (opts.fork) cmd += ` --resume ${sessionId} --fork-session --session-id ${id}`;
    else if (sessionId) cmd += ` --resume ${id}`;
    else cmd += ` --session-id ${id}`;
    const extra = (cfg.get('extraArgs') || '').trim();
    if (extra) cmd += ' ' + extra;
    const terminal = vscode.window.createTerminal({
      name,
      cwd: project,
      location: { viewColumn: column, preserveFocus: !!opts.quiet },
      iconPath: new vscode.ThemeIcon('sparkle'),
      color: cfg.get('colorTerminals') ? new vscode.ThemeColor(COLORS[hash(sessions.pathKey(project)) % COLORS.length]) : undefined,
      isTransient: true, // we restore sessions ourselves via --resume
    });
    if (opts.startDelay) setTimeout(() => terminal.sendText(cmd, true), opts.startDelay);
    else terminal.sendText(cmd, true);
    if (!opts.quiet) terminal.show(false);
    return terminal;
  }

  reveal(e) {
    if (e.kind === 'chat') e.view.show(); else e.view.show(false);
  }

  /** Re-open a session in the other view (chat <-> terminal) in the same pane. */
  async switchView(sessionId) {
    const e = this.open.get(sessionId);
    if (!e) return;
    if (e.kind === 'chat' && e.view.busy) {
      const ok = await vscode.window.showWarningMessage('Claude is still working in this chat. Switching stops the current turn.', 'Switch anyway');
      if (!ok) return;
    }
    const column = this.columnsByName().get(e.name);
    const kind = e.kind === 'chat' ? 'terminal' : 'chat';
    // Open the new view first so the pane is not closed as empty, but launch Claude
    // only after the old process has released the session.
    this.open.delete(sessionId);
    await this.openSession(e.project, sessionId, { column, title: e.title, kind, startDelay: 1500 });
    e.view.dispose();
  }

  /** First empty pane; otherwise grow the grid by one pane and use the new one. */
  async nextFreeColumn() {
    const groups = vscode.window.tabGroups.all;
    const empty = groups.findIndex(g => g.tabs.length === 0);
    if (empty >= 0) return empty + 1;
    await applyGrid(groups.length + 1);
    await sleep(50);
    const after = vscode.window.tabGroups.all;
    const fresh = after.findIndex(g => g.tabs.length === 0);
    return fresh >= 0 ? fresh + 1 : after.length;
  }

  uniqueName(base) {
    const names = new Set([...vscode.window.terminals.map(t => t.name), ...[...this.open.values()].map(e => e.name)]);
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} (${i})`)) return `${base} (${i})`;
  }

  // ---- layout ------------------------------------------------------------

  async setLayout(n) {
    await applyGrid(n);
    this.scheduleSave();
  }

  /** One session per pane, in board order. */
  async tidy() {
    const entries = [...this.open.values()];
    if (!entries.length) return;
    const columns = this.columnsByName();
    entries.sort((a, b) => (columns.get(a.name) || 99) - (columns.get(b.name) || 99));
    await applyGrid(entries.length);
    await sleep(100);
    for (let i = 0; i < entries.length; i++) {
      this.reveal(entries[i]);
      await sleep(80);
      if (this.columnsByName().get(entries[i].name) !== i + 1) {
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'group', value: i + 1 });
        await sleep(80);
      }
    }
    // Drop panes left empty after the moves.
    await applyGrid(entries.length);
    this.scheduleSave();
  }

  async closeAll() {
    for (const e of [...this.open.values()]) e.view.dispose();
    this.open.clear();
    await applyGrid(1);
    this.save();
  }

  // ---- lifecycle & activity ----------------------------------------------

  handleClosed(entry, shutdown) {
    if (this.open.get(entry.sessionId) !== entry) return;
    this.open.delete(entry.sessionId);
    // Window closing: keep the saved board so it can be restored next time.
    if (shutdown) this.shuttingDown = true;
    else this.scheduleSave();
    this._onDidChange.fire();
  }

  setState(e, next) {
    if (next === e.state) return;
    const prev = e.state;
    e.state = next;
    this._onDidChange.fire();
    if (!vscode.workspace.getConfiguration('claudeCC').get('notifyWhenDone')) return;
    const focused = vscode.window.state.focused && (e.kind === 'chat' ? e.view.panel.active : vscode.window.activeTerminal === e.view);
    if (focused) return;
    if (next === 'idle' && prev !== 'idle') this.notify(e, 'finished its turn');
    else if (next === 'waiting') this.notify(e, e.kind === 'chat' ? 'is waiting for your approval' : 'may be waiting for your approval');
  }

  /** Terminal panes: infer activity from the transcript file. Chat panes report state directly. */
  poll() {
    for (const e of this.open.values()) {
      if (e.kind !== 'terminal') continue;
      const st = sessions.activityState(e.file);
      const now = Date.now();
      if (st.size !== e.size) {
        e.size = st.size;
        e.lastChange = now;
      }
      const next = st.state === 'working' ? (now - e.lastChange > STALL_MS ? 'waiting' : 'working')
        : st.state === 'done' ? 'idle' : e.state;
      this.setState(e, next);
    }
  }

  async notify(e, what) {
    const pick = await vscode.window.showInformationMessage(`Claude (${path.basename(e.project)}): ${short(e.title)} ${what}.`, 'Show');
    if (pick) this.reveal(e);
  }

  /** Called after a session list refresh so board labels pick up real titles. */
  updateTitles(projects) {
    let changed = false;
    for (const e of this.open.values()) {
      const p = projects.get(sessions.pathKey(e.project));
      const m = p && p.sessions.find(s => s.id === e.sessionId);
      if (m && m.title !== e.title) {
        e.title = m.title;
        if (e.kind === 'chat') e.view.setTitle(m.title);
        changed = true;
      }
    }
    if (changed) this._onDidChange.fire();
  }

  async sendToSessions(ids, text) {
    for (const id of ids) {
      const e = this.open.get(id);
      if (!e) continue;
      if (e.kind === 'chat') e.view.sendExternal(text);
      else e.view.sendText(text, true);
    }
  }
}

function short(s) {
  return s.length > 32 ? s.slice(0, 30) + '...' : s;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function quoteCmd(c) {
  return /\s/.test(c) && !/^["']/.test(c) ? `"${c}"` : c;
}

module.exports = { Board, gridShape };
