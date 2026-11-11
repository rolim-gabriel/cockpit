// Test helper: drives Claude Command Center in a normal VS Code window, then quits or reports.
const vscode = require('vscode');
const fs = require('fs');
const { execSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = (m) => fs.appendFileSync(process.env.CCC_OUT, m + '\n');
exports.activate = async () => {
  const phase = process.env.CCC_PHASE;
  if (!phase) return;
  try {
    const dirs = JSON.parse(process.env.CCC_DIRS), sids = JSON.parse(process.env.CCC_SIDS);
    const ccc = vscode.extensions.getExtension('local.claude-command-center');
    const { board, projects, native } = await ccc.activate();
    for (let i = 0; i < 30 && !native.active; i++) await sleep(500);
    const tabs = () => JSON.stringify(vscode.window.tabGroups.all.map(g => g.tabs.map(t => t.label)));
    if (phase === 'before') {
      await vscode.extensions.getExtension('anthropic.claude-code').activate();
      projects.refresh();
      await board.setLayout(3);
      await board.openSession(dirs.notes, sids.notes, { column: 1 });
      await board.openSession(dirs.docs, sids.docs, { column: 2 });
      await board.openSession(dirs.first, sids.first, { column: 3 });
      await sleep(25000);
      out('before tabs ' + tabs());
      await vscode.commands.executeCommand('workbench.action.quit');
    } else {
      await sleep(45000);
      out('after tabs ' + tabs());
      try { execSync(`import -window root ${process.env.CCC_SHOT}`); } catch (e) { out('shot failed ' + e.message); }
      await vscode.commands.executeCommand('workbench.action.quit');
    }
  } catch (e) { out('driver error ' + e.stack); }
};
