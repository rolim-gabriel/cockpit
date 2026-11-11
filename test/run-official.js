// End-to-end test of "official panel everywhere" with the REAL official Claude Code extension
// and the real, logged-in `claude` CLI (a few cheap Haiku turns). Linux + Xvfb + xdotool.
// Usage: xvfb-run -a -s "-screen 0 1600x1000x24" node test/run-official.js \
//          <dir with @vscode/test-electron> <VS Code binary> <extensions dir with anthropic.claude-code> [screenshot.png]
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const [testElectron, codeBin, extensionsDir, shot] = process.argv.slice(2);
const { runTests } = require(path.join(testElectron, 'node_modules/@vscode/test-electron'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-official-'));
const dirs = { first: path.join(tmp, 'webshop'), notes: path.join(tmp, 'notes-app'), docs: path.join(tmp, 'docs-site') };
Object.values(dirs).forEach(d => fs.mkdirSync(d));
for (const k of Object.keys(process.env)) if (/^(CLAUDECODE|CLAUDE_CODE_SESSION.*|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_REMOTE_SESSION_ID)$/.test(k)) delete process.env[k];

// An existing conversation in a project that is NOT the window's first folder.
const sid = crypto.randomUUID();
execFileSync('claude', ['-p', '--model', 'haiku', '--session-id', sid, 'Remember the code word MANGO. Reply in one short sentence.'], { cwd: dirs.notes, stdio: 'inherit' });

const user = path.join(tmp, 'user');
fs.mkdirSync(path.join(user, 'User'), { recursive: true });
fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
  'claudeCC.restoreOnStartup': false, 'claudeCode.hideOnboarding': true, 'claudeCode.initialPermissionMode': 'acceptEdits',
  'workbench.startupEditor': 'none', 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'terminal.integrated.defaultProfile.linux': 'sh',
}));
const env = {
  CCC_TMP: tmp, CCC_SID: sid, CCC_DIRS: JSON.stringify(dirs), CCC_SHOT: shot || '',
  CLAUDE_CC_LOG: path.join(tmp, 'wrapper.log'),
  CLAUDE_CC_STATE_DIR: path.join(tmp, 'state'),
  // The marketplace package may carry another platform's Claude binary; run the installed CLI instead.
  CLAUDE_CC_EXEC: 'claude',
};
Object.assign(process.env, env); // inherited by VS Code, the official extension and our wrapper

runTests({
  vscodeExecutablePath: codeBin,
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.join(__dirname, 'suite-official.js'),
  launchArgs: ['--user-data-dir', user, '--extensions-dir', extensionsDir, '--disable-workspace-trust', dirs.first],
}).then(() => console.log('PASS'), e => { console.error('FAIL', e); process.exit(1); });
