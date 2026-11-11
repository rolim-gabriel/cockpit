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
    this.pendingNew = undefined; // { cwd, firstFolder, since }
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
      // Write next to it and rename, so a running wrapper is never half-written.
      const tmp = dst + '.new';
      fs.copyFileSync(src, tmp);
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, dst);
    }
    return dst;
  }

  officialConfig() { return vscode.workspace.getConfiguration('claudeCode'); }

  /** 'ours' | 'none' | 'other' (someone else's wrapper: we never override it) */
  wrapperState() {
    const v = this.officialConfig().inspect(WRAPPER_SETTING);
    const current = (v && (v.workspaceFolderValue || v.workspaceValue || v.globalValue)) || '';
    if (!current) return 'none';
    return path.resolve(current) === path.resolve(this.installedWrapper()) ? 'ours' : 'other';
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
    if (state === 'none') await this.officialConfig().update(WRAPPER_SETTING, file, vscode.ConfigurationTarget.Global);
    return true;
  }

  /** Turns the feature off: restores the official setting and removes every link we made. */
  async disable() {
    if (this.wrapperState() === 'ours') await this.officialConfig().update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
    let removed = 0;
    for (const l of this.links) {
      try {
        if (fs.existsSync(l.link) && fs.existsSync(l.real) && sameFile(l.link, l.real)) { fs.unlinkSync(l.link); removed++; }
      } catch { /* leave it */ }
    }
    await this.setLinks([]);
    return removed;
  }

  /** Claude's history folder for a project folder: an existing one if Claude already made it. */
  projectDirFor(folder, known) {
    const p = known && known.get(sessions.pathKey(folder));
    if (p && p.sessions.length) return path.dirname(p.sessions[0].file);
    return path.join(sessions.dataDir(), 'projects', path.resolve(folder).replace(/[^a-zA-Z0-9]/g, '-'));
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
      // A link of ours that Claude replaced with a new file: point it at the real one again.
      if (!this.links.some(l => l.link === link)) return false; // not ours: never touch it
      fs.unlinkSync(link);
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

  /** Hands the folder for the next new official chat to the wrapper. */
  prepareNewChat(cwd, firstFolder, known) {
    fs.mkdirSync(this.stateDir(), { recursive: true });
    const file = this.pendingFile();
    fs.writeFileSync(file + '.tmp', JSON.stringify({ cwd, expires: Date.now() + PENDING_TTL_MS }));
    fs.renameSync(file + '.tmp', file);
    const proj = known && known.get(sessions.pathKey(cwd));
    this.pendingNew = { cwd, firstFolder, since: Date.now(), before: new Set(proj ? proj.sessions.map(s => s.id) : []) };
  }

  pendingFile() { return path.join(this.stateDir(), 'pending-new-chat.json'); }

  /**
   * Waits until the wrapper has claimed the handed-over folder, so several new chats
   * opened in a row each get their own. Returns false (and withdraws it) on timeout.
   */
  async waitForClaim(timeoutMs = 20000) {
    const file = this.pendingFile();
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
    const p = this.pendingNew;
    if (p && Date.now() - p.since < NEW_CHAT_LINK_WINDOW_MS) {
      const proj = projects.get(sessions.pathKey(p.cwd));
      for (const s of (proj ? proj.sessions : [])) {
        if (!p.before.has(s.id)) await this.linkTranscript(s.file, p.firstFolder, projects);
      }
    } else this.pendingNew = undefined;

    let changed = false;
    const keep = [];
    for (const l of this.links) {
      if (!fs.existsSync(l.real)) { changed = true; continue; }
      if (!fs.existsSync(l.link) || !sameFile(l.link, l.real)) {
        try {
          if (fs.existsSync(l.link)) fs.unlinkSync(l.link);
          fs.linkSync(l.real, l.link);
        } catch { changed = true; continue; }
      }
      keep.push(l);
    }
    if (changed) await this.setLinks(keep);
  }
}

function sameFile(a, b) {
  const x = fs.statSync(a, { bigint: true }), y = fs.statSync(b, { bigint: true });
  return x.ino === y.ino && x.dev === y.dev;
}

module.exports = { NativeEverywhere };
