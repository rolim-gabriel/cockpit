// The board: Claude Code CLI sessions running in terminals that live in the
// editor area, arranged as a grid of editor groups. VS Code itself handles
// dragging tabs between panes, resizing sashes and maximizing a pane.

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const sessions = require('./sessions');

const COLORS = ['terminal.ansiBlue', 'terminal.ansiGreen', 'terminal.ansiMagenta', 'terminal.ansiCyan',
  'terminal.ansiYellow', 'terminal.ansiRed', 'terminal.ansiBrightBlue', 'terminal.ansiBrightGreen',
  'terminal.ansiBrightMagenta', 'terminal.ansiBrightCyan'];

const POLL_MS = 2000;
const STALL_MS = 12000; // mid-turn with no transcript writes this long: likely waiting on you

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

class Board {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /** @type {Map<string, {terminal: vscode.Terminal, project: string, sessionId: string, title: string, file: string, state: string, lastChange: number, size: number, notified: string}>} */
    this.open = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this.saveTimer = undefined;

    context.subscriptions.push(
      vscode.window.onDidCloseTerminal(t => this.handleClosed(t)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleSave()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.scheduleSave()),
      { dispose: () => clearInterval(this.poller) },
    );
    this.poller = setInterval(() => this.poll(), POLL_MS);
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
      project: e.project, sessionId: e.sessionId, title: e.title, column: columns.get(e.terminal.name) || 99,
    })).sort((a, b) => a.column - b.column);
    const groups = new Set(items.map(i => i.column)).size;
    this.store.update('board', { items, groups });
    this._onDidChange.fire();
  }

  /** terminal name -> editor group index (1-based, reading order) */
  columnsByName() {
    const map = new Map();
    vscode.window.tabGroups.all.forEach((g, i) => {
      for (const tab of g.tabs) if (tab.input instanceof vscode.TabInputTerminal) map.set(tab.label, i + 1);
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
      await this.openSession(item.project, item.sessionId, { column: cols.indexOf(item.column) + 1, title: item.title, quiet: true });
    }
  }

  // ---- opening sessions --------------------------------------------------

  /**
   * @param {string} project folder the session runs in (its cwd)
   * @param {string|undefined} sessionId existing session to resume; undefined = new session
   * @param {{column?: number, mode?: 'board'|'tab', fork?: boolean, title?: string, quiet?: boolean}} opts
   */
  async openSession(project, sessionId, opts = {}) {
    if (sessionId && !opts.fork && this.open.has(sessionId)) {
      this.open.get(sessionId).terminal.show(false);
      return;
    }
    const cfg = vscode.workspace.getConfiguration('claudeCC');
    const id = sessionId && !opts.fork ? sessionId : crypto.randomUUID();
    let cmd = quoteCmd(cfg.get('claudeCommand') || 'claude');
    if (opts.fork) cmd += ` --resume ${sessionId} --fork-session --session-id ${id}`;
    else if (sessionId) cmd += ` --resume ${id}`;
    else cmd += ` --session-id ${id}`;
    const extra = (cfg.get('extraArgs') || '').trim();
    if (extra) cmd += ' ' + extra;

    const title = opts.title || (opts.fork ? 'fork' : sessionId ? 'session' : 'new session');
    const column = opts.column || (opts.mode === 'tab' ? vscode.ViewColumn.Active : await this.nextFreeColumn());

    const terminal = vscode.window.createTerminal({
      name: this.uniqueName(`${path.basename(project)} · ${short(title)}`),
      cwd: project,
      location: { viewColumn: column, preserveFocus: !!opts.quiet },
      iconPath: new vscode.ThemeIcon('sparkle'),
      color: cfg.get('colorTerminals') ? new vscode.ThemeColor(COLORS[hash(sessions.pathKey(project)) % COLORS.length]) : undefined,
      isTransient: true, // we restore sessions ourselves via --resume
      env: { CLAUDE_CC_SESSION: id },
    });
    terminal.sendText(cmd, true);
    if (!opts.quiet) terminal.show(false);
    // Terminal tabs appear asynchronously; wait so the next placement sees this pane as taken.
    for (let i = 0; i < 40 && !this.columnsByName().has(terminal.name); i++) await sleep(50);

    const file = sessions.sessionFile(project, id);
    const st = sessions.activityState(file);
    this.open.set(id, { terminal, project, sessionId: id, title, file, state: st.state === 'working' ? 'working' : 'idle',
      lastChange: Date.now(), size: st.size, notified: '' });
    this.scheduleSave();
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
    const names = new Set(vscode.window.terminals.map(t => t.name));
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
    entries.sort((a, b) => (columns.get(a.terminal.name) || 99) - (columns.get(b.terminal.name) || 99));
    await applyGrid(entries.length);
    await sleep(100);
    for (let i = 0; i < entries.length; i++) {
      entries[i].terminal.show(false);
      await sleep(80);
      if (this.columnsByName().get(entries[i].terminal.name) !== i + 1) {
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'group', value: i + 1 });
        await sleep(80);
      }
    }
    // Drop panes left empty after the moves.
    await applyGrid(entries.length);
    this.scheduleSave();
  }

  async closeAll() {
    for (const e of [...this.open.values()]) e.terminal.dispose();
    this.open.clear();
    await applyGrid(1);
    this.save();
  }

  // ---- terminal lifecycle & activity ------------------------------------

  handleClosed(terminal) {
    for (const [id, e] of this.open) {
      if (e.terminal !== terminal) continue;
      this.open.delete(id);
      // Window closing: keep the saved board so it can be restored next time.
      if (terminal.exitStatus && terminal.exitStatus.reason === vscode.TerminalExitReason.Shutdown) this.shuttingDown = true;
      else this.scheduleSave();
      this._onDidChange.fire();
    }
  }

  poll() {
    if (!this.open.size) return;
    const notify = vscode.workspace.getConfiguration('claudeCC').get('notifyWhenDone');
    let changed = false;
    for (const e of this.open.values()) {
      const st = sessions.activityState(e.file);
      const now = Date.now();
      if (st.size !== e.size) {
        e.size = st.size;
        e.lastChange = now;
      }
      let next = st.state === 'working' ? (now - e.lastChange > STALL_MS ? 'waiting' : 'working')
        : st.state === 'done' ? 'idle' : e.state;
      if (next !== e.state) {
        const prev = e.state;
        e.state = next;
        changed = true;
        const focused = vscode.window.state.focused && vscode.window.activeTerminal === e.terminal;
        if (notify && !focused) {
          if (next === 'idle' && prev !== 'idle') this.notify(e, 'finished its turn');
          else if (next === 'waiting') this.notify(e, 'may be waiting for your approval');
        }
      }
    }
    if (changed) this._onDidChange.fire();
  }

  async notify(e, what) {
    const pick = await vscode.window.showInformationMessage(`Claude (${path.basename(e.project)}): ${short(e.title)} ${what}.`, 'Show');
    if (pick) e.terminal.show(false);
  }

  /** Called after a session list refresh so board labels pick up real titles. */
  updateTitles(projects) {
    let changed = false;
    for (const e of this.open.values()) {
      const p = projects.get(sessions.pathKey(e.project));
      const m = p && p.sessions.find(s => s.id === e.sessionId);
      if (m && m.title !== e.title) { e.title = m.title; changed = true; }
    }
    if (changed) this._onDidChange.fire();
  }

  async sendToSessions(ids, text) {
    for (const id of ids) {
      const e = this.open.get(id);
      if (e) e.terminal.sendText(text, true);
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
