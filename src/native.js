// "Official panel everywhere": lets the official Claude Code chat panel host chats
// of any project, not only the window's first folder.
//
// The official panel always launches Claude in the first folder and only looks
// for history there. Two pieces fix that without touching the official extension:
//  1. Our small wrapper program is set as the official `claudeCode.claudeProcessWrapper`.
//     It runs the same Claude binary with the same arguments, but in the
//     conversation's own project folder (see wrapper/main.go).
//  2. A hard link (a second name for the same file, not a copy) to the
//     conversation's transcript is added to the first folder's history folder,
//     so the official panel can find and show the history. Claude keeps writing
//     to the original file, which the link always mirrors.
// Everything is reversible: `disable()` restores the setting and removes our links.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessions = require('./sessions');

const WRAPPER_SETTING = 'claudeProcessWrapper';
const PENDING_TTL_MS = 30000;
const NEW_CHAT_LINK_WINDOW_MS = 5 * 60 * 1000;

class NativeEverywhere {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.pendingNew = []; // [{ cwd, firstFolder, since, before }]
  }

  get links() { return this.context.globalState.get('nativeLinks', []); }
  setLinks(list) { return this.context.globalState.update('nativeLinks', list); }

  stateDir() { return process.env.CLAUDE_CC_STATE_DIR || path.join(os.homedir(), '.claude-command-center'); }

  bundledWrapper() {
    const exe = process.platform === 'win32' ? 'claude-cc-wrapper.exe' : 'claude-cc-wrapper';
    return path.join(this.context.extensionPath, 'bin', `${process.platform}-${process.arch}`, exe);
  }

  /** The wrapper lives at a stable path, so the setting survives our updates (and still works if we are uninstalled). */
  installedWrapper() {
    return path.join(this.stateDir(), 'bin', path.basename(this.bundledWrapper()));
  }

  installWrapper() {
    const src = this.bundledWrapper();
    if (!fs.existsSync(src)) throw new Error(`No wrapper build for ${process.platform}-${process.arch}`);
    const dst = this.installedWrapper();
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(fs.readFileSync(src));
    if (!same) {
      // Write next to it and rename, so a running wrapper is never half-written. Windows cannot
      // replace a running .exe, but it can rename it, so move the old one aside first.
      const tmp = dst + '.new';
      fs.copyFileSync(src, tmp);
      fs.chmodSync(tmp, 0o755);
      if (fs.existsSync(dst)) fs.renameSync(dst, `${dst}.old-${Date.now()}`);
      fs.renameSync(tmp, dst);
    }
    // Old copies are removed once no chat runs them any more.
    for (const f of fs.readdirSync(path.dirname(dst))) {
      if (f.includes('.old-')) try { fs.unlinkSync(path.join(path.dirname(dst), f)); } catch { /* still running */ }
    }
    this.writeConfig();
    return dst;
  }

  /** Tells the wrapper about settings it needs (it cannot read VS Code settings). */
  writeConfig() {
    const dataDir = vscode.workspace.getConfiguration('claudeCC').get('claudeDataDir') ? sessions.dataDir() : '';
    fs.mkdirSync(this.stateDir(), { recursive: true });
    fs.writeFileSync(path.join(this.stateDir(), 'config.json'), JSON.stringify({ dataDir }));
  }

  officialConfig() { return vscode.workspace.getConfiguration('claudeCode'); }

  currentWrapper() {
    const v = this.officialConfig().inspect(WRAPPER_SETTING);
    return (v && (v.workspaceFolderValue || v.workspaceValue || v.globalValue)) || '';
  }

  /**
   * 'ours' | 'stale' (ours, but a path from another machine, e.g. via Settings Sync) | 'none' |
   * 'other' (someone else's wrapper: we never override it)
   */
  wrapperState() {
    const current = this.currentWrapper();
    if (!current) return 'none';
    if (path.resolve(current) === path.resolve(this.installedWrapper())) return 'ours';
    return /^claude-cc-wrapper(\.exe)?$/i.test(current.split(/[\\/]/).pop()) ? 'stale' : 'other';
  }

  get active() { return this.wrapperState() === 'ours'; }

  /** Turns the feature on. Returns false (with a message) if it cannot be. */
  async enable({ quiet } = {}) {
    const state = this.wrapperState();
    if (state === 'other') {
      if (!quiet) vscode.window.showWarningMessage('Claude Code already uses another process wrapper (claudeCode.claudeProcessWrapper), so the official panel stays limited to the first folder. Other projects open in the Claude Code CLI.');
      return false;
    }
    let file;
    try { file = this.installWrapper(); } catch (err) {
      if (!quiet) vscode.window.showWarningMessage('Could not install the Claude Command Center wrapper: ' + err.message);
      return false;
    }
    if (state === 'none' || state === 'stale') await this.officialConfig().update(WRAPPER_SETTING, file, vscode.ConfigurationTarget.Global);
    return true;
  }

  /** Turns the feature off: restores the official setting and removes every link we made. */
  async disable() {
    if (['ours', 'stale'].includes(this.wrapperState())) await this.officialConfig().update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
    let removed = 0;
    for (const l of this.links) {
      try {
        // Only ever remove the second name of a file that still exists under its original name.
        if (fs.existsSync(l.link) && fs.existsSync(l.real) && sameFile(l.link, l.real)) { fs.unlinkSync(l.link); removed++; }
      } catch { /* leave it */ }
    }
    await this.setLinks([]);
    return removed;
  }

  /**
   * Claude's history folder for a project folder: the one Claude names after it, or, if Claude
   * named it differently (very long paths), the folder holding that project's own (unlinked) chats.
   */
  projectDirFor(folder, known) {
    const encoded = path.join(sessions.dataDir(), 'projects', sessions.encodeProjectPath(folder));
    if (fs.existsSync(encoded)) return encoded;
    const linked = new Set(this.links.map(l => path.resolve(l.link)));
    const p = known && known.get(sessions.pathKey(folder));
    const own = p && p.sessions.find(s => !linked.has(path.resolve(s.file)));
    return own ? path.dirname(own.file) : encoded;
  }

  /**
   * Makes a conversation visible to the official panel of a window whose first folder is `firstFolder`.
   * Returns true when the panel can open it.
   */
  async linkTranscript(realFile, firstFolder, known) {
    const dir = this.projectDirFor(firstFolder, known);
    const link = path.join(dir, path.basename(realFile));
    if (path.resolve(link) === path.resolve(realFile)) return true; // already a first-folder chat
    if (fs.existsSync(link)) {
      if (sameFile(link, realFile)) return true;
      const ours = this.links.find(l => l.link === link);
      if (!ours) return false; // not ours: never touch it
      try { this.reunite(ours); return true; } catch { return false; }
    }
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.linkSync(realFile, link);
    } catch (err) {
      vscode.window.showWarningMessage(`Could not link this chat for the official panel (${err.code || err.message}); opening it in the Claude Code CLI instead.`);
      return false;
    }
    await this.setLinks([...this.links.filter(l => l.link !== link), { link, real: realFile }]);
    return true;
  }

  /**
   * Hands the folder for the next new official chat of this window to the wrapper. Each request
   * is its own file, claimed only by a launch from this window's first folder (see wrapper).
   */
  prepareNewChat(cwd, firstFolder, known) {
    const dir = path.join(this.stateDir(), 'pending');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file + '.tmp', JSON.stringify({ cwd, from: firstFolder, expires: Date.now() + PENDING_TTL_MS }));
    fs.renameSync(file + '.tmp', file);
    const proj = known && known.get(sessions.pathKey(cwd));
    this.pendingNew.push({ cwd, firstFolder, since: Date.now(), before: new Set(proj ? proj.sessions.map(s => s.id) : []) });
    return file;
  }

  /**
   * Waits until the wrapper has claimed a handover, so several new chats opened in a row each
   * get their own. Returns false (and withdraws it) on timeout.
   */
  async waitForClaim(file, timeoutMs = 20000) {
    for (let t = 0; t < timeoutMs; t += 100) {
      if (!fs.existsSync(file)) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    try { fs.unlinkSync(file); } catch { /* claimed just now */ }
    return false;
  }

  /**
   * After a refresh: link transcripts of new chats started through `prepareNewChat`, and repair
   * links whose original was replaced. Keeps the official panel able to reopen them.
   */
  async sync(projects) {
    // New chats started for other projects: link each new conversation so the panel can reopen it.
    this.pendingNew = this.pendingNew.filter(p => Date.now() - p.since < NEW_CHAT_LINK_WINDOW_MS);
    for (const p of this.pendingNew) {
      const proj = projects.get(sessions.pathKey(p.cwd));
      for (const s of (proj ? proj.sessions : [])) {
        if (!p.before.has(s.id)) { p.before.add(s.id); await this.linkTranscript(s.file, p.firstFolder, projects); }
      }
    }

    let changed = false;
    const keep = [];
    for (const l of this.links) {
      // Deleted from the official panel (link gone) or original gone: stop tracking, never recreate.
      if (!fs.existsSync(l.link) || !fs.existsSync(l.real)) { changed = true; continue; }
      if (!sameFile(l.link, l.real)) {
        // One side was replaced by a new file: keep the newer content under both names, back up the other.
        try { this.reunite(l); } catch { /* retry next time */ }
      }
      keep.push(l);
    }
    if (changed) await this.setLinks(keep);
  }

  /** Makes link and original the same file again, keeping the newer content and backing up the older. */
  reunite(l) {
    const a = fs.statSync(l.real), b = fs.statSync(l.link);
    const linkNewer = b.mtimeMs > a.mtimeMs || (b.mtimeMs === a.mtimeMs && b.size > a.size);
    const [keepFile, oldFile] = linkNewer ? [l.link, l.real] : [l.real, l.link];
    const backups = path.join(this.stateDir(), 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.copyFileSync(oldFile, path.join(backups, `${Date.now()}-${path.basename(oldFile)}`));
    const tmp = oldFile + '.ccc-tmp';
    fs.linkSync(keepFile, tmp);
    fs.renameSync(tmp, oldFile); // the old name now points at the kept content
  }
}

function sameFile(a, b) {
  const x = fs.statSync(a, { bigint: true }), y = fs.statSync(b, { bigint: true });
  // Some network drives report 0 for every file; never treat those as the same file.
  return x.ino !== 0n && x.ino === y.ino && x.dev === y.dev;
}

module.exports = { NativeEverywhere };
