// Close-and-reopen test in a NORMAL VS Code window (test hosts do not restore tabs), with the REAL official
// Claude Code extension and the real `claude` CLI (three cheap Haiku turns). A helper extension (driver/) opens
// three chats from three projects in a grid, quits VS Code, and on the next start reports what came back.
// Usage: xvfb-run -a -s "-screen 0 1800x1000x24" node test/restore/run.js <VS Code binary> <official claude-code .vsix> [shot.png]
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const [code, officialVsix, shot] = process.argv.slice(2);
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-reopen-'));
const cli = path.join(path.dirname(code), 'bin', 'code');

// Install the official extension, this extension and the driver into a private extensions folder.
const exts = path.join(tmp, 'exts');
execFileSync('npx', ['--yes', '@vscode/vsce', 'package', '--no-dependencies', '-o', path.join(tmp, 'ccc.vsix')], { cwd: root, stdio: 'ignore' });
execFileSync('npx', ['--yes', '@vscode/vsce', 'package', '--no-dependencies', '--allow-missing-repository', '-o', path.join(tmp, 'driver.vsix')], { cwd: path.join(__dirname, 'driver'), stdio: 'ignore' });
for (const v of [officialVsix, path.join(tmp, 'ccc.vsix'), path.join(tmp, 'driver.vsix')]) {
  execFileSync(cli, ['--extensions-dir', exts, '--user-data-dir', path.join(tmp, 'ud0'), '--install-extension', v], { stdio: 'ignore' });
}

const dirs = { first: path.join(tmp, 'webshop'), notes: path.join(tmp, 'notes-app'), docs: path.join(tmp, 'docs-site') };
Object.values(dirs).forEach(d => fs.mkdirSync(d));
for (const k of Object.keys(process.env)) if (/^(CLAUDECODE|CLAUDE_CODE_SESSION.*|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_REMOTE_SESSION_ID)$/.test(k)) delete process.env[k];
const sids = {}, words = { notes: 'MANGO', docs: 'KIWI', first: 'PEAR' };
for (const k of Object.keys(words)) {
  sids[k] = crypto.randomUUID();
  execFileSync('claude', ['-p', '--model', 'haiku', '--session-id', sids[k], `Remember the code word ${words[k]}. Reply in one short sentence.`], { cwd: dirs[k], stdio: 'ignore' });
}
// The window is a saved Command Center workspace with all three projects (webshop first).
const ws = path.join(tmp, 'Claude Command Center.code-workspace');
fs.writeFileSync(ws, JSON.stringify({ folders: [dirs.first, dirs.notes, dirs.docs].map(p => ({ path: p })), settings: {} }));
const user = path.join(tmp, 'user'); fs.mkdirSync(path.join(user, 'User'), { recursive: true });
fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ 'claudeCode.hideOnboarding': true,
  'workbench.startupEditor': 'none', 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'security.workspace.trust.enabled': false }));
const log = path.join(tmp, 'wrapper.log'), out = path.join(tmp, 'out.txt');
const env = { ...process.env, CCC_DIRS: JSON.stringify(dirs), CCC_SIDS: JSON.stringify(sids), CCC_OUT: out, CCC_SHOT: shot || path.join(tmp, 'shot.png'),
  CLAUDE_CC_LOG: log, CLAUDE_CC_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CC_EXEC: 'claude' };
const launch = phase => spawnSync(code, ['--no-sandbox', '--user-data-dir', user, '--extensions-dir', exts, ws],
  { env: { ...env, CCC_PHASE: phase }, timeout: 240000, stdio: 'ignore' });
const launches = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.args.includes('--input-format'));

launch('before');
const mark = launches().length;
launch('after');
const report = fs.readFileSync(out, 'utf8');
console.log(report.trim());
const before = JSON.parse(report.match(/before tabs (.*)/)[1]), after = JSON.parse(report.match(/after tabs (.*)/)[1]);
assert.deepStrictEqual(after, before, 'same chats in the same panes after reopening');
for (const k of Object.keys(sids)) {
  assert.ok(launches().slice(mark).some(l => l.cwd === dirs[k] && l.args.includes('--resume=' + sids[k])), `${k} resumed in its own folder after reopening`);
}
console.log('PASS: all chats came back in their panes, each resumed in its own folder');
