// Sidebar views: "Projects & Sessions" (history browser) and "Board" (open panes).

const vscode = require('vscode');
const path = require('path');
const sessions = require('./sessions');

const STATE_ICON = {
  working: ['loading~spin', 'charts.blue', 'working'],
  waiting: ['bell-dot', 'charts.orange', 'waiting for you?'],
  idle: ['check', 'charts.green', 'ready'],
};

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

class ProjectsProvider {
  /** @param {vscode.ExtensionContext} context @param {import('./board').Board} board */
  constructor(context, board) {
    this.context = context;
    this.board = board;
    this.projects = new Map();
    this.expanded = new Set(); // projects showing all sessions
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    board.onDidChange(() => this._onDidChange.fire());
  }

  get pinned() {
    return this.context.globalState.get('pinnedProjects', []);
  }

  async setPinned(list) {
    await this.context.globalState.update('pinnedProjects', list);
    await this.refreshAsync();
  }

  refresh() {
    this.apply(sessions.scanAll());
  }

  /** Background refresh: never blocks VS Code. Calls made while one runs are merged into one more pass. */
  refreshAsync() {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try { this.apply(await sessions.scanAllAsync()); } catch (err) { console.error('Claude Command Center: refresh failed', err); }
      } while (this.again);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  apply(projects) {
    this.projects = projects;
    this.board.updateTitles(this.projects);
    this._onDidChange.fire();
  }

  project(p) {
    return this.projects.get(sessions.pathKey(p)) || { path: p, sessions: [] };
  }

  /**
   * Display name of a project folder: its own name, plus its parent folder's name when another
   * known project has the same name (e.g. a OneDrive copy and a local copy).
   */
  nameOf(p) {
    const base = path.basename(p) || p;
    const same = [...this.projects.values()].map(x => x.path).concat(this.pinned)
      .filter(x => path.basename(x).toLowerCase() === base.toLowerCase() && sessions.pathKey(x) !== sessions.pathKey(p));
    return same.length ? `${base} (${path.basename(path.dirname(p))})` : base;
  }

  /** All known projects: pinned first (in pin order), then discovered by recency. */
  allProjects() {
    const pinnedKeys = new Set(this.pinned.map(sessions.pathKey));
    const pinned = this.pinned.map(p => ({ ...this.project(p), pinned: true }));
    const discovered = [...this.projects.values()]
      .filter(p => !pinnedKeys.has(sessions.pathKey(p.path)))
      .sort((a, b) => b.sessions[0].mtime - a.sessions[0].mtime)
      .map(p => ({ ...p, pinned: false }));
    return { pinned, discovered };
  }

  getChildren(el) {
    const cfg = vscode.workspace.getConfiguration('claudeCC');
    if (!el) {
      const { pinned, discovered } = this.allProjects();
      const items = pinned.map(p => ({ kind: 'project', project: p }));
      if (cfg.get('showDiscoveredProjects') && discovered.length) {
        if (!pinned.length) return discovered.map(p => ({ kind: 'project', project: p }));
        items.push({ kind: 'group', label: `Other projects in Claude history (${discovered.length})`, projects: discovered });
      }
      return items;
    }
    if (el.kind === 'group') return el.projects.map(p => ({ kind: 'project', project: p }));
    if (el.kind === 'project') {
      const max = cfg.get('sessionsPerProject') || 15;
      const list = this.project(el.project.path).sessions;
      const showAll = this.expanded.has(sessions.pathKey(el.project.path));
      const items = list.slice(0, showAll ? list.length : max).map(s => ({ kind: 'session', session: s, project: el.project.path }));
      if (list.length > max && !showAll) items.push({ kind: 'more', project: el.project.path, count: list.length - max });
      return items;
    }
    return [];
  }

  getTreeItem(el) {
    if (el.kind === 'group') {
      const t = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Collapsed);
      t.iconPath = new vscode.ThemeIcon('history');
      return t;
    }
    if (el.kind === 'project') {
      const p = el.project;
      const count = this.project(p.path).sessions.length;
      const live = this.board.all().filter(e => sessions.pathKey(e.project) === sessions.pathKey(p.path)).length;
      const t = new vscode.TreeItem(this.nameOf(p.path),
        p.pinned ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      t.id = 'p:' + sessions.pathKey(p.path) + (p.pinned ? ':pin' : '');
      t.description = `${count} chat${count === 1 ? '' : 's'}${live ? ` · ${live} open` : ''}`;
      t.tooltip = p.path;
      t.iconPath = new vscode.ThemeIcon(p.pinned ? 'root-folder' : 'folder');
      t.contextValue = p.pinned ? 'project.pinned' : 'project.discovered';
      return t;
    }
    if (el.kind === 'more') {
      const t = new vscode.TreeItem(`Show ${el.count} older...`);
      t.iconPath = new vscode.ThemeIcon('ellipsis');
      t.command = { command: 'claudeCC._showAll', title: 'Show all', arguments: [el.project] };
      return t;
    }
    const s = el.session;
    const open = this.board.entry(s.id);
    const t = new vscode.TreeItem(s.title);
    t.id = 's:' + s.id;
    t.description = (open ? `● ${STATE_ICON[open.state][2]} · ` : '') + ago(s.mtime);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${s.title}**\n\n`);
    if (s.firstPrompt) md.appendText(s.firstPrompt.slice(0, 400) + (s.firstPrompt.length > 400 ? '...' : '') + '\n\n');
    md.appendMarkdown(`Last activity ${new Date(s.mtime).toLocaleString()}  \n`);
    md.appendMarkdown(`From: ${s.entrypoint || 'unknown'}${s.gitBranch ? ` · branch \`${s.gitBranch}\`` : ''}  \n`);
    md.appendMarkdown(`ID: \`${s.id}\``);
    t.tooltip = md;
    if (open) {
      const [icon, color] = STATE_ICON[open.state];
      t.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    } else {
      t.iconPath = new vscode.ThemeIcon(/vscode/i.test(s.entrypoint) ? 'comment-discussion' : 'terminal');
    }
    t.contextValue = 'session';
    t.command = { command: 'claudeCC.openSession', title: 'Open', arguments: [el] };
    return t;
  }
}

class BoardProvider {
  /** @param {import('./board').Board} board */
  constructor(board) {
    this.board = board;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    board.onDidChange(() => this._onDidChange.fire());
  }

  getChildren(el) {
    if (el) return [];
    const cols = this.board.columnsByName();
    return this.board.all()
      .map(e => ({ entry: e, column: e.kind === 'terminal' ? cols.get(e.terminal.name) : undefined }))
      .sort((a, b) => (a.column || 99) - (b.column || 99));
  }

  getTreeItem({ entry: e, column }) {
    const t = new vscode.TreeItem(`${this.nameOf ? this.nameOf(e.project) : path.basename(e.project)}: ${e.title}`);
    const [icon, color, label] = STATE_ICON[e.state];
    t.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    t.description = `${e.kind === 'official' ? 'chat' : 'CLI'}${column ? ` · pane ${column}` : ''} · ${label}`;
    t.tooltip = `${e.kind === 'official' ? 'Official Claude Code panel' : 'Claude Code CLI'} in ${e.project}\nSession ${e.sessionId}\nClick to show it`;
    t.contextValue = 'boardItem';
    t.command = { command: 'claudeCC.focusBoardItem', title: 'Focus', arguments: [e.sessionId] };
    t.id = 'b:' + e.sessionId;
    return t;
  }
}

module.exports = { ProjectsProvider, BoardProvider, ago };
