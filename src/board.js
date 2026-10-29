// The board: native Claude Code sessions in the editor area, arranged as a grid
// of editor groups. A pane is either the official Claude Code chat panel (only
// possible for the window's first folder, where that panel runs) or Claude Code's
// own CLI in a terminal (any project). We never draw Claude's UI ourselves: we
// only place sessions in panes and launch them with their history.
// VS Code handles dragging tabs between panes, resizing and maximizing a pane.

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const sessions = require('./sessions');

const COLORS = ['terminal.ansiBlue', 'terminal.ansiGreen', 'terminal.ansiMagenta', 'terminal.ansiCyan',
  'terminal.ansiYellow', 'terminal.ansiRed', 'terminal.ansiBrightBlue', 'terminal.ansiBrightGreen',
  'terminal.ansiBrightMagenta', 'terminal.ansiBrightCyan'];

const OFFICIAL_OPEN = 'claude-vscode.editor.open';
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
    /** Terminal panes we launched: sessionId -> entry. Official panels are tracked by the official extension. */
    this.open = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this.saveTimer = undefined;
    this.officialAvailable = false;
    this.refreshOfficial();

    context.subscriptions.push(
      vscode.window.onDidCloseTerminal(t => this.handleClosed(t)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleSave()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.scheduleSave()),
      vscode.extensions.onDidChange(() => this.refreshOfficial()),
      { dispose: () => clearInterval(this.poller) },
    );
    this.poller = setInterval(() => this.poll(), POLL_MS);
  }

  async refreshOfficial() {
    this.officialAvailable = (await vscode.commands.getCommands(true)).includes(OFFICIAL_OPEN);
  }

  /**
   * The official chat panel always runs in the window's first folder, so it can host
   * only that project's chats. Every other project uses the CLI.
   */
  canUseOfficial(project) {
    const first = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return this.officialAvailable && !!first && sessions.pathKey(first.uri.fsPath) === sessions.pathKey(project);
  }

  prefersOfficial(project) {
    return vscode.workspace.getConfiguration('claudeCC').get('preferOfficialPanel') && this.canUseOfficial(project);
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
    this.store.update('board', { items });
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

  /** Reopens saved terminal panes. Official chat tabs are restored by the official extension itself. */
  async restore() {
    const saved = this.store.get('board');
    if (!saved || !saved.items || !saved.items.length) {
      vscode.window.showInformationMessage('No saved board for this window yet.');
      return;
    }
    const todo = saved.items.filter(i => !this.open.has(i.sessionId));
    if (!todo.length) return;
    const cols = [...new Set(saved.items.map(i => i.column))].sort((a, b) => a - b);
    const groups = vscode.window.tabGroups.all;
    // Keep panes the official extension already restored; add ours after them.
    const officialPanes = groups.filter(g => g.tabs.some(t => t.input instanceof vscode.TabInputWebview)).length;
    await applyGrid(officialPanes + cols.length);
    for (const item of todo) {
      await this.openSession(item.project, item.sessionId, {
        column: officialPanes + cols.indexOf(item.column) + 1, title: item.title, quiet: true, view: 'terminal',
      });
    }
  }

  // ---- opening sessions --------------------------------------------------

  /**
   * @param {string} project folder the session runs in (its cwd)
   * @param {string|undefined} sessionId existing session to resume; undefined = new session
   * @param {{column?: number, mode?: 'board'|'tab', fork?: boolean, title?: string, quiet?: boolean, view?: 'official'|'terminal'}} opts
   */
  async openSession(project, sessionId, opts = {}) {
    if (sessionId && !opts.fork && this.open.has(sessionId)) {
      this.open.get(sessionId).terminal.show(false);
      return;
    }
    const official = !opts.fork && (opts.view === 'official' ? this.canUseOfficial(project) : opts.view !== 'terminal' && this.prefersOfficial(project));
    const column = opts.column || (opts.mode === 'tab' ? vscode.ViewColumn.Active : await this.nextFreeColumn());

    if (official) {
      // The official extension opens (or reveals) the chat with its full history in that pane.
      await vscode.commands.executeCommand(OFFICIAL_OPEN, sessionId, undefined, column);
      await this.waitForPane(column);
      this._onDidChange.fire();
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
    const terminal = vscode.window.createTerminal({
      name: this.uniqueName(`${path.basename(project)} · ${short(title)}`),
      cwd: project,
      location: { viewColumn: column, preserveFocus: !!opts.quiet },
      iconPath: new vscode.ThemeIcon('sparkle'),
      color: cfg.get('colorTerminals') ? new vscode.ThemeColor(COLORS[hash(sessions.pathKey(project)) % COLORS.length]) : undefined,
      isTransient: true, // we restore sessions ourselves via --resume
    });
    terminal.sendText(cmd, true);
    if (!opts.quiet) terminal.show(false);

    const file = sessions.sessionFile(project, id);
    const st = sessions.activityState(file);
    this.open.set(id, { terminal, project, sessionId: id, title, file, state: st.state === 'working' ? 'working' : 'idle',
      lastChange: Date.now(), size: st.size });
    // Terminal tabs appear asynchronously; wait so the next placement sees this pane as taken.
    for (let i = 0; i < 40 && !this.columnsByName().has(terminal.name); i++) await sleep(50);
    this.scheduleSave();
  }

  async waitForPane(column) {
    for (let i = 0; i < 40; i++) {
      const g = vscode.window.tabGroups.all[column - 1];
      if (g && g.tabs.length) return;
      await sleep(50);
    }
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

  /** One tab per pane. Official chat tabs stay where they are; our terminals move into free panes. */
  async tidy() {
    const total = vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.filter(t =>
      t.input instanceof vscode.TabInputTerminal || t.input instanceof vscode.TabInputWebview).length, 0);
    if (!total) return;
    await applyGrid(total);
    await sleep(100);
    for (const e of this.open.values()) {
      const groups = vscode.window.tabGroups.all;
      const mine = groups.findIndex(g => g.tabs.some(t => t.input instanceof vscode.TabInputTerminal && t.label === e.terminal.name));
      if (mine >= 0 && groups[mine].tabs.length === 1) continue;
      const empty = groups.findIndex(g => g.tabs.length === 0);
      if (empty < 0) break;
      e.terminal.show(false);
      await sleep(80);
      await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'group', value: empty + 1 });
      await sleep(80);
    }
    await applyGrid(total); // drop panes left empty after the moves
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
      const next = st.state === 'working' ? (now - e.lastChange > STALL_MS ? 'waiting' : 'working')
        : st.state === 'done' ? 'idle' : e.state;
      if (next === e.state) continue;
      const prev = e.state;
      e.state = next;
      changed = true;
      const focused = vscode.window.state.focused && vscode.window.activeTerminal === e.terminal;
      if (notify && !focused) {
        if (next === 'idle' && prev !== 'idle') this.notify(e, 'finished its turn');
        else if (next === 'waiting') this.notify(e, 'may be waiting for your approval');
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
