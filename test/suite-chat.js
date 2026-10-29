const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  for (let t = 0; t < ms; t += 250) { const v = fn(); if (v) return v; await sleep(250); }
  throw new Error('timed out waiting for ' + what);
}

exports.run = async () => {
  const sid = process.env.CCC_SID;
  const [shop, notes] = JSON.parse(process.env.CCC_PROJECTS);
  const ext = vscode.extensions.all.find(e => e.id.endsWith('claude-command-center'));
  const { board, projects } = await ext.activate();
  projects.refresh();
  assert.ok(projects.project(shop).sessions.some(s => s.id === sid), 'prior CLI session discovered');

  // Resume the prior conversation as a chat pane; record what the panel sends to the webview.
  await board.openSession(shop, sid, { kind: 'chat', title: 'code word' });
  const entry = board.open.get(sid);
  const posted = [];
  const orig = entry.view.post.bind(entry.view);
  entry.view.post = m => { posted.push(m); return orig(m); };
  const hello = await until(() => posted.find(m => m.type === 'hello'), 20000, 'history').catch(() => undefined);
  // 'hello' may have been posted before we wrapped post(); fall back to reading history directly.
  const { loadHistory } = require('../src/chat/history');
  const hist = hello ? hello.items : loadHistory(entry.file).items;
  assert.ok(hist.some(i => i.type === 'user' && i.text.includes('PINEAPPLE')), 'history shows earlier user message');
  assert.ok(hist.some(i => i.type === 'assistant'), 'history shows earlier assistant reply');
  const info = await until(() => entry.view.engine.info, 60000, 'initialize');
  assert.ok(info.commands.length > 5 && info.models.length > 1, 'slash commands and models loaded');

  // Ask something that needs the old context and a tool approval.
  entry.view.onMessage({ type: 'send', text: 'What was the code word? Use the Write tool to create word.txt containing just that word, then reply DONE.' });
  const perm = await until(() => posted.find(m => m.type === 'permission'), 120000, 'permission prompt');
  assert.strictEqual(perm.req.tool_name, 'Write');
  assert.strictEqual(entry.state, 'waiting', 'board shows waiting');
  entry.view.onMessage({ type: 'permission', id: perm.id, decision: { behavior: 'allow' } });
  await until(() => posted.find(m => m.type === 'result'), 120000, 'result');
  assert.strictEqual(fs.readFileSync(path.join(shop, 'word.txt'), 'utf8').trim(), 'PINEAPPLE', 'resumed context used + tool ran');
  assert.ok(posted.some(m => m.type === 'stream'), 'streamed tokens');
  assert.ok(posted.some(m => m.type === 'items' && m.items.some(i => i.type === 'tool' && i.name === 'Write')), 'tool card shown');
  await until(() => entry.state === 'idle', 5000, 'idle');

  // A brand-new chat in a second project, plus a terminal pane: three panes.
  await board.openSession(notes, undefined, { kind: 'chat' });
  const fresh = [...board.open.values()].find(e => e.project === notes);
  fresh.view.onMessage({ type: 'send', text: 'Reply with exactly: hello from notes' });
  await until(() => !fresh.view.engine.busy && fresh.view.engine.started, 120000, 'second chat reply');
  await board.openSession(notes, undefined, { kind: 'terminal' });
  await sleep(1500);
  assert.strictEqual(vscode.window.tabGroups.all.length, 3, 'three panes');

  // Switch the first chat to the terminal view in the same pane, then back.
  const col = board.columnsByName().get(entry.name);
  await board.switchView(sid);
  await sleep(1500);
  assert.strictEqual(board.open.get(sid).kind, 'terminal', 'switched to terminal');
  assert.strictEqual(board.columnsByName().get(board.open.get(sid).name), col, 'same pane');
  await board.switchView(sid);
  await sleep(1500);
  assert.strictEqual(board.open.get(sid).kind, 'chat', 'switched back to chat');
  assert.strictEqual(vscode.window.tabGroups.all.length, 3, 'still three panes after switching');
  assert.ok(vscode.window.tabGroups.all.every(g => g.tabs.length === 1), 'one tab per pane after switching');

  board.save();
  const saved = board.store.get('board');
  assert.deepStrictEqual(saved.items.map(i => i.kind).sort(), ['chat', 'chat', 'terminal'], 'kinds persisted');

  if (process.env.CCC_SHOT) {
    // Ask the restored chat one more question so the screenshot shows a live exchange.
    const e2 = board.open.get(sid);
    e2.view.onMessage({ type: 'send', text: 'In one sentence: what file did you just create?' });
    await until(() => e2.view.engine.started && !e2.view.engine.busy, 120000, 'final reply');
    await vscode.commands.executeCommand('workbench.view.extension.claudeCC');
    await sleep(2500);
    try { execSync(`import -window root ${process.env.CCC_SHOT}`); } catch (err) { console.log('screenshot failed', err.message); }
  }
  console.log('all chat assertions passed');
};
