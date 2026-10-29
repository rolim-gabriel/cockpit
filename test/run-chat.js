// Chat-view integration test against the REAL claude CLI (uses your login; a few cheap haiku turns).
// Usage: xvfb-run -a node test/run-chat.js <dir with @vscode/test-electron> <screenshot.png> <path to VS Code binary>
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { runTests } = require(path.join(process.argv[2], 'node_modules/@vscode/test-electron'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-chat-'));
const projects = ['webshop', 'notes-app'].map(n => path.join(tmp, n));
projects.forEach(p => fs.mkdirSync(p, { recursive: true }));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_SESSION.*|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_REMOTE_SESSION_ID)$/.test(k)) delete env[k];
// A prior conversation to resume, created with the CLI.
const sid = crypto.randomUUID();
execFileSync('claude', ['-p', '--model', 'haiku', '--session-id', sid, 'Remember the code word PINEAPPLE for later. Reply with one short sentence.'], { cwd: projects[0], env, stdio: 'inherit' });

const user = path.join(tmp, 'user');
fs.mkdirSync(path.join(user, 'User'), { recursive: true });
fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
  'claudeCC.chatModel': 'haiku', 'claudeCC.restoreOnStartup': false, 'claudeCC.defaultView': 'chat',
  'workbench.startupEditor': 'none', 'terminal.integrated.defaultProfile.linux': 'sh',
}));
process.env.CCC_TMP = tmp;
process.env.CCC_SID = sid;
process.env.CCC_PROJECTS = JSON.stringify(projects);
process.env.CCC_SHOT = process.argv[3] || '';
runTests({
  vscodeExecutablePath: process.argv[4],
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.join(__dirname, 'suite-chat.js'),
  launchArgs: ['--user-data-dir', user, '--disable-extensions', '--disable-workspace-trust', tmp],
}).then(() => console.log('PASS'), e => { console.error('FAIL', e); process.exit(1); });
