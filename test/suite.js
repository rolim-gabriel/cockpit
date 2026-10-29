const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ctxSubs = [];
exports.run = async () => {
  const tmp = process.env.CCC_TMP;
  const ext = vscode.extensions.all.find(e => e.id.endsWith('claude-command-center'));
  const { board, projects } = await ext.activate();

  const work = path.join(tmp, 'work');
  const found = [...projects.projects.values()].filter(p => p.path !== work);
  assert.strictEqual(found.length, 4, 'discovers 4 project folders (plus the window folder)');
  assert.ok(found.every(p => p.sessions[0].title.startsWith('Fix the build')), 'titles from first prompt');
  const roots = projects.getChildren();
  assert.strictEqual(roots.length, 5, 'tree lists discovered projects');
  assert.strictEqual(projects.getChildren(roots[0]).length, 1, 'tree lists sessions');

  // Open all four existing chats: grid should grow to 4 panes, one terminal each.
  for (const p of found) await board.openSession(p.path, p.sessions[0].id, { title: p.sessions[0].title, quiet: true, view: 'terminal' });
  await sleep(4000);
  const groups = vscode.window.tabGroups.all;
  assert.strictEqual(groups.length, 4, 'four panes');
  assert.ok(groups.every(g => g.tabs.length === 1 && g.tabs[0].input instanceof vscode.TabInputTerminal), 'one terminal per pane');

  const calls = fs.readFileSync(path.join(tmp, 'claude-calls.log'), 'utf8').trim().split('\n');
  assert.strictEqual(calls.length, 4, 'claude launched 4 times');
  for (const p of found) assert.ok(calls.some(c => c.startsWith(p.path + ' :: --resume ' + p.sessions[0].id)), 'resumed in its own folder: ' + p.path);

  // A new session gets an explicit id so it can be restored later; it lands in a fifth pane.
  await board.openSession(found[0].path, undefined, { quiet: true, view: 'terminal' });
  await sleep(2500);
  assert.strictEqual(vscode.window.tabGroups.all.length, 5, 'grid grew to 5 panes');
  assert.ok(fs.readFileSync(path.join(tmp, 'claude-calls.log'), 'utf8').includes('--session-id '), 'new session uses --session-id');

  // Re-arrange: switch to 2x2 (merges panes), then tidy back to one-per-pane.
  await board.setLayout(4);
  await sleep(800);
  await board.tidy();
  await sleep(1500);
  assert.strictEqual(vscode.window.tabGroups.all.length, 5, 'tidy restores one pane per session');
  assert.ok(vscode.window.tabGroups.all.every(g => g.tabs.length === 1), 'tidy: one tab per pane');

  board.save();
  const saved = board.store.get('board');
  assert.strictEqual(saved.items.length, 5, 'board persisted');
  assert.deepStrictEqual(saved.items.map(i => i.column), [1, 2, 3, 4, 5], 'pane positions persisted');

  // Status detection: append an in-progress record, expect 'working'.
  const f = found[1].sessions[0].file;
  fs.appendFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'next task' } }) + '\n');
  await sleep(3000);
  assert.strictEqual(board.open.get(found[1].sessions[0].id).state, 'working', 'detects working');

  if (process.env.CCC_SHOT) {
    await vscode.commands.executeCommand('workbench.view.extension.claudeCC');
    await sleep(1500);
    try { execSync(`import -window root ${process.env.CCC_SHOT}`); } catch (e) { console.log('screenshot failed', e.message); }
  }

  // Close all then restore from saved state.
  const before = board.store.get('board');
  for (const e of [...board.open.values()]) e.terminal.dispose();
  await sleep(1500);
  await board.store.update('board', before);
  await board.restore();
  await sleep(3000);
  assert.strictEqual(board.open.size, 5, 'restore reopens all sessions');
  assert.strictEqual(vscode.window.tabGroups.all.length, 5, 'restore rebuilds panes');

  // Official panel routing: chats of the first workspace folder go to the official extension's
  // own command (session id + target pane); every other project stays in the CLI.
  const officialCalls = [];
  ctxSubs.push(vscode.commands.registerCommand('claude-vscode.editor.open', async (sessionId, prompt, column) => {
    officialCalls.push({ sessionId, column });
    const p = vscode.window.createWebviewPanel('fakeOfficial', 'Claude Code', { viewColumn: column });
    p.webview.html = 'official';
  }));
  await board.refreshOfficial();
  const workSession = projects.project(work).sessions[0];
  assert.ok(board.canUseOfficial(work) && !board.canUseOfficial(found[0].path), 'official only for the first folder');
  const openBefore = board.open.size, groupsBefore = vscode.window.tabGroups.all.length;
  const emptyBefore = vscode.window.tabGroups.all.findIndex(g => !g.tabs.length);
  const expectedPane = emptyBefore >= 0 ? emptyBefore + 1 : groupsBefore + 1;
  await board.openSession(work, workSession.id, { title: workSession.title });
  assert.strictEqual(officialCalls.length, 1, 'official command used');
  assert.strictEqual(officialCalls[0].sessionId, workSession.id, 'official panel gets the session id (it loads the history)');
  assert.strictEqual(officialCalls[0].column, expectedPane, 'official panel goes into a free pane');
  assert.ok(vscode.window.tabGroups.all[expectedPane - 1].tabs.some(t => t.input instanceof vscode.TabInputWebview), 'official panel shown in that pane');
  assert.strictEqual(board.open.size, openBefore, 'no CLI terminal for the official chat');
  await board.openSession(work, undefined, {});
  assert.strictEqual(officialCalls.length, 2, 'new chat in first folder also uses the official panel');
  assert.strictEqual(officialCalls[1].sessionId, undefined);
  await board.openSession(work, workSession.id, { view: 'terminal', quiet: true });
  assert.strictEqual(officialCalls.length, 2, 'Open in CLI bypasses the official panel');
  assert.ok(board.open.has(workSession.id), 'opened in CLI on request');
  await sleep(1500);
  if (process.env.CCC_SHOT) {
    await board.tidy();
    await sleep(1500);
    try { execSync(`import -window root ${process.env.CCC_SHOT.replace('.png', '-official.png')}`); } catch { /* optional */ }
  }
  console.log('all assertions passed');
};
