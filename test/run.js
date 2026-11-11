// Integration test: launches a real VS Code with the extension and a fake claude CLI.
// Usage: xvfb-run -a node test/run.js <path-to-vscode-test-electron-dir>
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests } = require(path.join(process.argv[2], 'node_modules/@vscode/test-electron'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-'));
const data = path.join(tmp, 'claude');
const projects = ['alpha', 'beta', 'gamma', 'delta'].map(n => path.join(tmp, 'work', n));
projects.forEach((p, i) => {
  fs.mkdirSync(p, { recursive: true });
  const dir = path.join(data, 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const id = `0000000${i}-0000-4000-8000-000000000000`;
  const lines = [
    { type: 'user', cwd: p, sessionId: id, entrypoint: 'claude-vscode', message: { role: 'user', content: `Fix the build in ${path.basename(p)}` } },
    { type: 'assistant', cwd: p, sessionId: id, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
});
// A conversation that belongs to the window's first folder (the only one the official panel can host).
{
  const work = path.join(tmp, 'work');
  const dir = path.join(data, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const id = '0000000f-0000-4000-8000-000000000000';
  fs.writeFileSync(path.join(dir, id + '.jsonl'), [
    { type: 'user', cwd: work, sessionId: id, message: { role: 'user', content: 'Plan the release' } },
    { type: 'assistant', cwd: work, sessionId: id, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
}
const log = path.join(tmp, 'claude-calls.log');
const fake = path.join(tmp, 'fakeclaude');
fs.writeFileSync(fake, `#!/bin/sh\necho "$PWD :: $*" >> ${log}\necho "fake claude $*"\nsleep 600\n`, { mode: 0o755 });
const user = path.join(tmp, 'user');
fs.mkdirSync(path.join(user, 'User'), { recursive: true });
fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
  'claudeCC.claudeDataDir': data, 'claudeCC.claudeCommand': fake, 'claudeCC.restoreOnStartup': false,
  'workbench.startupEditor': 'none', 'terminal.integrated.defaultProfile.linux': 'sh',
}));
process.env.CCC_TMP = tmp;
process.env.CCC_SHOT = process.argv[3] || '';
runTests({
  vscodeExecutablePath: process.argv[4],
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.join(__dirname, 'suite.js'),
  launchArgs: ['--user-data-dir', user, '--disable-extensions', '--disable-workspace-trust', path.join(tmp, 'work')],
}).then(() => console.log('PASS'), e => { console.error('FAIL', e); process.exit(1); });
