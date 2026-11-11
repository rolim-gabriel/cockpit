const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  for (let t = 0; t < ms; t += 500) { const v = await fn(); if (v) return v; await sleep(500); }
  throw new Error('timed out waiting for ' + what);
}
const launches = () => {
  try { return fs.readFileSync(process.env.CLAUDE_CC_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.args.includes('--input-format')); } catch { return []; }
};
const records = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return {}; } });
const text = r => { const c = r.message && r.message.content; return typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text || (typeof b.content === 'string' ? b.content : '')).join(' ') : ''; };

/** Types a prompt into the active official panel and sends it. */
async function ask(prompt) {
  await vscode.commands.executeCommand('claude-vscode.focus');
  await sleep(1500);
  execSync(`xdotool type --delay 15 ${JSON.stringify(prompt)}`);
  await sleep(500);
  execSync('xdotool key Return');
}

exports.run = async () => {
  const dirs = JSON.parse(process.env.CCC_DIRS);
  const sid = process.env.CCC_SID;
  await vscode.extensions.getExtension('anthropic.claude-code').activate();
  const { board, projects, native } = await vscode.extensions.all.find(e => e.id.endsWith('claude-command-center')).activate();

  // 1. Turned on automatically: the official setting points at our installed wrapper.
  await until(() => native.active, 15000, 'wrapper setting');
  const wrapper = vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper');
  assert.ok(fs.existsSync(wrapper), 'wrapper installed at ' + wrapper);
  assert.ok(board.canUseOfficial(dirs.notes), 'official panel allowed for another project');
  projects.refresh();

  // 2. Existing chat of another project: official panel, history, runs in its own folder.
  await board.openSession(dirs.notes, sid, { title: 'code word' });
  const realFile = projects.project(dirs.notes).sessions.find(s => s.id === sid).file;
  const link = path.join(native.projectDirFor(dirs.first, projects.projects), sid + '.jsonl');
  assert.ok(fs.existsSync(link), 'history linked for the official panel');
  assert.strictEqual(fs.statSync(link).ino, fs.statSync(realFile).ino, 'link is the same file');
  await until(() => launches().some(l => l.reason === 'resume' && l.cwd === dirs.notes), 60000, 'resume launch in notes-app');
  await sleep(4000);
  await ask('What was the code word? Then use the Bash tool to run pwd and reply with the code word and the folder.');
  await until(() => records(realFile).some(r => r.type === 'assistant' && /MANGO/.test(text(r)) && text(r).includes('notes-app')), 120000, 'answer in notes-app');
  console.log('step 2 ok: existing chat resumed in its own folder with its context');

  // 3. New chat in another project.
  await board.openSession(dirs.docs, undefined, {});
  await until(() => launches().some(l => l.reason === 'pending' && l.cwd === dirs.docs), 60000, 'new chat launch in docs-site');
  await sleep(4000);
  await ask('Use the Bash tool to run pwd, then reply with just the folder.');
  const newFile = await until(() => {
    projects.refresh();
    const p = projects.project(dirs.docs);
    return p.sessions[0] && records(p.sessions[0].file).some(r => r.type === 'assistant' && text(r).includes('docs-site')) && p.sessions[0].file;
  }, 120000, 'new chat transcript in docs-site');
  await native.sync(projects.projects);
  const newId = path.basename(newFile, '.jsonl');
  const newLink = path.join(native.projectDirFor(dirs.first, projects.projects), newId + '.jsonl');
  assert.ok(fs.existsSync(newLink), 'new chat linked for reopening');
  console.log('step 3 ok: new chat ran in docs-site and was linked');

  // 4. First-folder chats are untouched by the wrapper.
  await board.openSession(dirs.first, undefined, {});
  await until(() => launches().some(l => l.reason === 'unchanged' && l.cwd === dirs.first), 60000, 'first-folder launch');
  console.log('step 4 ok: first-folder chat unchanged');

  // 4b. Several new chats opened back to back each start in their own folder.
  const mark = launches().length;
  await board.openSession(dirs.notes, undefined, { quiet: true });
  await board.openSession(dirs.docs, undefined, { quiet: true });
  await until(() => launches().slice(mark).filter(l => l.reason === 'pending').length >= 2, 60000, 'two new-chat launches');
  const got = launches().slice(mark).filter(l => l.reason === 'pending').map(l => l.cwd);
  assert.deepStrictEqual(got.slice(0, 2), [dirs.notes, dirs.docs], 'each new chat in its own folder, in order');
  console.log('step 4b ok: back-to-back new chats each in their own folder');
  if (process.env.CCC_SHOT) {
    await sleep(8000);
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await sleep(1500);
    execSync(`import -window root ${process.env.CCC_SHOT.replace('.png', '-grid.png')}`);
  }

  // 5. Close the new docs-site chat and reopen it from history.
  await sleep(3000);
  // Close every official chat tab; the official extension restores none of them on its own here.
  console.log('tabs:', vscode.window.tabGroups.all.map(g => g.tabs.map(t => t.label).join(' | ')).join(' || '));
  for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) {
    if (t.input instanceof vscode.TabInputWebview) await vscode.window.tabGroups.close(t);
  }
  await sleep(3000);
  const before = launches().length;
  await board.openSession(dirs.docs, newId, { title: 'pwd' });
  await until(() => launches().slice(before).some(l => l.reason === 'resume' && l.cwd === dirs.docs), 60000, 'reopened new chat resumes in docs-site')
    .catch(err => { console.log('launches after reopen:', JSON.stringify(launches().slice(before).map(l => [l.reason, l.cwd, l.args.filter(a => a.startsWith('--resume'))]))); throw err; });
  console.log('step 5 ok: reopened new chat resumes in docs-site');

  await sleep(8000);
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await sleep(1500);
  if (process.env.CCC_SHOT) execSync(`import -window root ${process.env.CCC_SHOT}`);

  // 6. Turning it off restores the setting and removes only our links.
  const removed = await native.disable();
  assert.ok(removed >= 2, 'links removed: ' + removed);
  assert.ok(!fs.existsSync(link) && fs.existsSync(realFile), 'original history kept');
  assert.ok(!vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper'), 'official setting restored');
  console.log('all official assertions passed');
};
