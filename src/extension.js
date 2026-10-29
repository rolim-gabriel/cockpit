const vscode = require('vscode');
const path = require('path');
const { Board } = require('./board');
const { ProjectsProvider, BoardProvider, ago } = require('./tree');
const sessions = require('./sessions');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const board = new Board(context);
  const projects = new ProjectsProvider(context, board);
  const boardView = new BoardProvider(board);
  projects.refresh();

  const projectsTree = vscode.window.createTreeView('claudeCC.projects', { treeDataProvider: projects, showCollapseAll: true });
  const boardTree = vscode.window.createTreeView('claudeCC.board', { treeDataProvider: boardView });
  context.subscriptions.push(projectsTree, boardTree);

  // ---- keep the history list fresh -------------------------------------
  let refreshTimer;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => projects.refresh(), 1500); };
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.join(sessions.dataDir(), 'projects')), '**/*.jsonl'));
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  const periodic = setInterval(scheduleRefresh, 30000);
  context.subscriptions.push(watcher, { dispose: () => { clearInterval(periodic); clearTimeout(refreshTimer); } });

  // ---- status bar --------------------------------------------------------
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'claudeCC.focusPane';
  const updateStatus = () => {
    const all = [...board.open.values()];
    if (!all.length) { status.hide(); return; }
    const n = s => all.filter(e => e.state === s).length;
    const parts = [`$(sparkle) ${all.length}`];
    if (n('working')) parts.push(`$(loading~spin) ${n('working')}`);
    if (n('waiting')) parts.push(`$(bell-dot) ${n('waiting')}`);
    status.text = parts.join('  ');
    status.tooltip = 'Claude sessions on the board: open / working / waiting for you. Click to jump to one.';
    status.backgroundColor = n('waiting') ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.show();
  };
  board.onDidChange(updateStatus);
  context.subscriptions.push(status);

  // ---- helpers -----------------------------------------------------------
  const projectOf = el => el && (el.project && el.project.path ? el.project.path : el.project);

  async function pickProject(placeHolder) {
    const { pinned, discovered } = projects.allProjects();
    const items = [...pinned, ...discovered].map(p => ({
      label: path.basename(p.path) || p.path, description: p.pinned ? 'pinned' : '', detail: p.path, path: p.path,
    }));
    items.push({ label: '$(new-folder) Browse for a folder...', browse: true });
    const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDetail: true });
    if (!pick) return undefined;
    if (pick.browse) {
      const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use folder' });
      return uris && uris[0] && uris[0].fsPath;
    }
    return pick.path;
  }

  function sessionPickItems(limit) {
    const all = [];
    for (const p of projects.projects.values()) for (const s of p.sessions) all.push(s);
    all.sort((a, b) => b.mtime - a.mtime);
    return all.slice(0, limit).map(s => ({
      label: s.title,
      description: `${path.basename(s.cwd)} · ${ago(s.mtime)}${board.open.has(s.id) ? ' · open' : ''}`,
      detail: s.cwd,
      session: s,
    }));
  }

  const openPicks = (placeHolder, canPickMany) => vscode.window.showQuickPick(
    [...board.open.values()].map(e => ({
      label: `${path.basename(e.project)}: ${e.title}`, description: e.state, id: e.sessionId, picked: canPickMany,
    })), { placeHolder, canPickMany });

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ---- projects ----------------------------------------------------------
  reg('claudeCC.addProject', async () => {
    const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Add project' });
    if (!uris) return;
    const list = projects.pinned.slice();
    for (const u of uris) if (!list.some(p => sessions.pathKey(p) === sessions.pathKey(u.fsPath))) list.push(u.fsPath);
    await projects.setPinned(list);
  });
  reg('claudeCC.pinProject', async el => {
    const p = projectOf(el);
    if (p) await projects.setPinned([...projects.pinned, p]);
  });
  reg('claudeCC.removeProject', async el => {
    const p = projectOf(el);
    if (p) await projects.setPinned(projects.pinned.filter(x => sessions.pathKey(x) !== sessions.pathKey(p)));
  });
  reg('claudeCC.refresh', () => projects.refresh());
  reg('claudeCC._showAll', p => { projects.expanded.add(sessions.pathKey(p)); projects.refresh(); });
  reg('claudeCC.addToWorkspace', el => {
    const p = projectOf(el);
    const n = (vscode.workspace.workspaceFolders || []).length;
    vscode.workspace.updateWorkspaceFolders(n, 0, { uri: vscode.Uri.file(p) });
  });
  reg('claudeCC.revealProject', el => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(projectOf(el))));

  // ---- sessions ----------------------------------------------------------
  reg('claudeCC.newSession', async el => {
    const p = projectOf(el) || await pickProject('Start a new Claude session in...');
    if (p) await board.openSession(p, undefined, {});
  });
  reg('claudeCC.openLatest', async el => {
    const p = projectOf(el) || await pickProject('Resume the latest session of...');
    if (!p) return;
    const latest = projects.project(p).sessions[0];
    if (!latest) return board.openSession(p, undefined, {});
    await board.openSession(p, latest.id, { title: latest.title });
  });
  reg('claudeCC.openSession', async el => {
    if (!el) {
      const pick = await vscode.window.showQuickPick(sessionPickItems(200), { placeHolder: 'Resume which conversation?', matchOnDescription: true });
      if (!pick) return;
      el = { session: pick.session };
    }
    await board.openSession(el.session.cwd, el.session.id, { title: el.session.title });
  });
  reg('claudeCC.openSessionNewPane', el => el && board.openSession(el.session.cwd, el.session.id, { title: el.session.title, mode: 'tab' }));
  reg('claudeCC.openAsChat', el => el && board.openSession(el.session.cwd, el.session.id, { title: el.session.title, kind: 'chat' }));
  reg('claudeCC.openAsTerminal', el => el && board.openSession(el.session.cwd, el.session.id, { title: el.session.title, kind: 'terminal' }));
  reg('claudeCC.newTerminalSession', async el => {
    const p = projectOf(el) || await pickProject('Start a new Claude terminal session in...');
    if (p) await board.openSession(p, undefined, { kind: 'terminal' });
  });
  reg('claudeCC.openInOfficial', async el => {
    if (!el) return;
    // The official chat panel always runs in the window's first folder, so it can only host that project's chats.
    const first = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!first || sessions.pathKey(first.uri.fsPath) !== sessions.pathKey(el.session.cwd)) {
      vscode.window.showWarningMessage(`The official Claude Code panel can only open chats of this window's first folder${first ? ` (${first.name})` : ''}. Use "Open as Chat" for other projects.`);
      return;
    }
    if (!vscode.extensions.getExtension('anthropic.claude-code')) {
      vscode.window.showWarningMessage('The official Claude Code extension is not installed.');
      return;
    }
    if (board.open.has(el.session.id)) board.open.get(el.session.id).view.dispose();
    await vscode.commands.executeCommand('claude-vscode.editor.open', el.session.id, undefined, await board.nextFreeColumn());
  });
  reg('claudeCC.forkSession', el => el && board.openSession(el.session.cwd, el.session.id, { title: 'fork: ' + el.session.title, fork: true }));
  reg('claudeCC.previewSession', async el => {
    if (!el) return;
    const doc = await vscode.workspace.openTextDocument({ content: sessions.transcriptMarkdown(el.session), language: 'markdown' });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  });
  reg('claudeCC.copyResume', async el => {
    if (!el) return;
    const cmd = `cd "${el.session.cwd}" && claude --resume ${el.session.id}`;
    await vscode.env.clipboard.writeText(cmd);
    vscode.window.showInformationMessage('Copied: ' + cmd);
  });

  // ---- board -------------------------------------------------------------
  reg('claudeCC.openGrid', async () => {
    const pinned = projects.allProjects().pinned;
    const items = [
      ...(pinned.length ? [{ label: 'New sessions', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...pinned.map(p => ({ label: `$(add) New session in ${path.basename(p.path)}`, detail: p.path, newIn: p.path })),
      { label: 'Recent conversations', kind: vscode.QuickPickItemKind.Separator },
      ...sessionPickItems(80).filter(i => !board.open.has(i.session.id)),
    ];
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true, matchOnDescription: true, placeHolder: 'Pick the chats to put on the board (each gets its own pane)',
    });
    if (!picks || !picks.length) return;
    const views = [{ label: '$(comment-discussion) Chat view', kind: 'chat' }, { label: '$(terminal) Terminal (CLI)', kind: 'terminal' }];
    if (board.defaultKind() === 'terminal') views.reverse();
    const view = await vscode.window.showQuickPick(views, { placeHolder: 'Open them as...' });
    if (!view) return;
    await board.setLayout(board.open.size + picks.length);
    for (const p of picks) {
      if (p.newIn) await board.openSession(p.newIn, undefined, { quiet: true, kind: view.kind });
      else await board.openSession(p.session.cwd, p.session.id, { title: p.session.title, quiet: true, kind: view.kind });
    }
    if (board.open.size > picks.length) await board.tidy();
  });
  reg('claudeCC.layout', async () => {
    const n = board.open.size;
    const pick = await vscode.window.showQuickPick([
      ...(n ? [{ label: `$(layout) Fit to open sessions (${n})`, n }] : []),
      { label: '1 pane', n: 1 }, { label: '2 side by side', n: 2 }, { label: '3 columns', n: 3 },
      { label: '2 x 2 quadrants', n: 4 }, { label: '3 x 2', n: 6 }, { label: '3 x 3', n: 9 }, { label: '4 x 3', n: 12 },
    ], { placeHolder: 'Grid layout (drag tab edges to resize, drag tabs to rearrange)' });
    if (pick) await board.setLayout(pick.n);
  });
  reg('claudeCC.tidy', () => board.tidy());
  reg('claudeCC.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCC'));
  reg('claudeCC.restoreBoard', () => board.restore());
  reg('claudeCC.closeBoard', async () => {
    const ok = await vscode.window.showWarningMessage('Close all Claude sessions on the board? Conversations are saved and can be resumed.', { modal: true }, 'Close all');
    if (ok) await board.closeAll();
  });
  reg('claudeCC.focusPane', async () => {
    const pick = await openPicks('Jump to session', false);
    if (pick) board.reveal(board.open.get(pick.id));
  });
  reg('claudeCC.focusBoardItem', id => { const e = board.open.get(id); if (e) board.reveal(e); });
  reg('claudeCC.closeBoardItem', item => item && item.entry && item.entry.view.dispose());
  reg('claudeCC.switchView', arg => {
    const id = typeof arg === 'string' ? arg : arg && arg.entry && arg.entry.sessionId;
    if (id) return board.switchView(id);
  });
  reg('claudeCC.maximize', () => vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup'));
  reg('claudeCC.broadcast', async () => {
    if (!board.open.size) return vscode.window.showInformationMessage('No sessions on the board.');
    const picks = await openPicks('Send the prompt to which sessions?', true);
    if (!picks || !picks.length) return;
    const text = await vscode.window.showInputBox({ prompt: `Prompt for ${picks.length} session(s)`, placeHolder: 'e.g. run the tests and summarise failures' });
    if (text) await board.sendToSessions(picks.map(p => p.id), text);
  });

  // ---- restore on startup -----------------------------------------------
  const saved = board.store.get('board');
  if (vscode.workspace.getConfiguration('claudeCC').get('restoreOnStartup') && saved && saved.items && saved.items.length) {
    setTimeout(() => board.restore(), 1500);
  }
  return { board, projects }; // used by the integration test
}

function deactivate() {}

module.exports = { activate, deactivate };
