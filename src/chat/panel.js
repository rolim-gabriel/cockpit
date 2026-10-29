// A chat pane: a webview in the editor grid bound to one ChatEngine.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ChatEngine } = require('./engine');
const { toItems, loadHistory } = require('./history');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.next', 'target', '.idea', '.vscode-test']);

class ChatPanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {{project: string, sessionId: string, resume: boolean, fork?: string, title: string, name: string,
   *          column: vscode.ViewColumn, preserveFocus: boolean, transcript: string}} o
   */
  constructor(context, o) {
    this.context = context;
    this.o = o;
    this.name = o.name;
    this._onState = new vscode.EventEmitter();
    this.onState = this._onState.event; // 'working' | 'waiting' | 'idle'
    this._onDispose = new vscode.EventEmitter();
    this.onDidDispose = this._onDispose.event;

    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('claudeCC.chat', o.name,
      { viewColumn: o.column, preserveFocus: o.preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true, localResourceRoots: [media] });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'activity.svg');
    this.panel.webview.html = this.html(media);

    const cfg = vscode.workspace.getConfiguration('claudeCC');
    this.engine = new ChatEngine({
      cwd: o.project, sessionId: o.sessionId, resume: o.resume, fork: o.fork,
      model: cfg.get('chatModel') || undefined, permissionMode: cfg.get('chatPermissionMode') || undefined,
    });
    this.wireEngine();

    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.engine.dispose();
      this._onDispose.fire();
    });
  }

  post(msg) {
    this.panel.webview.postMessage(msg);
  }

  wireEngine() {
    const e = this.engine;
    e.on('info', info => this.post({
      type: 'info', commands: info.commands || [], models: info.models || [], account: info.account,
      permissionMode: info.current_permission_mode, version: info.claude_code_version,
    }));
    e.on('init', m => this.post({ type: 'init', model: m.model, permissionMode: m.permissionMode, sessionId: m.session_id }));
    e.on('stream', ev => this.post({ type: 'stream', event: ev }));
    e.on('assistant', m => !m.parent_tool_use_id && this.post({ type: 'items', items: toItems(m) }));
    e.on('user', m => !m.parent_tool_use_id && this.post({ type: 'items', items: toItems(m).filter(i => i.type !== 'user') }));
    e.on('system', m => {
      if (m.subtype === 'compact_boundary') this.post({ type: 'items', items: [{ type: 'notice', text: 'Conversation compacted' }] });
      else if (m.status) this.post({ type: 'status', text: m.status });
    });
    e.on('busy', b => { this.post({ type: 'busy', busy: b }); this._onState.fire(b ? 'working' : 'idle'); });
    e.on('permission', (id, req) => { this.post({ type: 'permission', id, req }); this._onState.fire('waiting'); });
    e.on('permissionCancelled', id => { this.post({ type: 'permissionGone', id }); this._onState.fire(e.busy ? 'working' : 'idle'); });
    e.on('result', r => this.post({
      type: 'result', isError: !!r.is_error, subtype: r.subtype, durationMs: r.duration_ms,
      usage: r.usage, text: r.is_error ? (r.result || (r.errors || []).join('\n')) : undefined,
    }));
    e.on('error', text => this.post({ type: 'error', text }));
    e.on('exit', (code, stderr) => {
      this.post({ type: 'exited', code, stderr: code ? stderr : '' });
      this._onState.fire('idle');
    });
  }

  async onMessage(m) {
    const e = this.engine;
    switch (m.type) {
      case 'ready': {
        const h = this.o.resume || this.o.fork ? loadHistory(this.o.transcript) : { items: [], truncated: false };
        this.post({ type: 'hello', project: this.o.project, projectName: path.basename(this.o.project), title: this.o.title, ...h });
        if (this.o.startDelay) setTimeout(() => !this.disposed && e.start(), this.o.startDelay);
        else e.start();
        break;
      }
      case 'send':
        e.send(m.text, m.images || []);
        break;
      case 'interrupt':
        e.interrupt();
        break;
      case 'permission':
        e.answerPermission(m.id, m.decision);
        this._onState.fire(e.permissions.size ? 'waiting' : 'working');
        break;
      case 'setModel':
        try { await e.setModel(m.model); } catch (err) { this.post({ type: 'error', text: 'Model change failed: ' + err.message }); }
        break;
      case 'setMode':
        try { await e.setPermissionMode(m.mode); } catch (err) { this.post({ type: 'error', text: 'Mode change failed: ' + err.message }); }
        break;
      case 'restart':
        e.start();
        break;
      case 'switchView':
        vscode.commands.executeCommand('claudeCC.switchView', this.o.sessionId);
        break;
      case 'openFile': {
        const p = path.isAbsolute(m.path) ? m.path : path.join(this.o.project, m.path);
        if (fs.existsSync(p)) vscode.window.showTextDocument(vscode.Uri.file(p), { preview: true, viewColumn: vscode.ViewColumn.Beside });
        break;
      }
      case 'files':
        this.post({ type: 'files', q: m.q, list: this.searchFiles(m.q) });
        break;
    }
  }

  /** Relative paths in the project matching a query, for @-mentions. */
  searchFiles(q) {
    if (!this.fileCache || Date.now() - this.fileCache.at > 30000) {
      const list = [];
      const walk = (dir, rel, depth) => {
        if (list.length > 8000 || depth > 12) return;
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const d of ents) {
          if (d.name.startsWith('.') && d.name !== '.github') continue;
          const r = rel ? rel + '/' + d.name : d.name;
          if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) { list.push(r + '/'); walk(path.join(dir, d.name), r, depth + 1); } }
          else list.push(r);
        }
      };
      walk(this.o.project, '', 0);
      this.fileCache = { at: Date.now(), list };
    }
    const needle = (q || '').toLowerCase();
    const hits = this.fileCache.list.filter(f => f.toLowerCase().includes(needle));
    hits.sort((a, b) => a.length - b.length);
    return hits.slice(0, 40);
  }

  get busy() { return this.engine.busy; }
  sendExternal(text) { this.post({ type: 'external', text }); this.engine.send(text); }
  show() { this.panel.reveal(undefined, false); }
  dispose() { this.panel.dispose(); }
  setTitle(title) { this.o.title = title; this.post({ type: 'title', title }); }

  html(media) {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('hex');
    const u = f => w.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${u('chat.css')}" rel="stylesheet"></head>
<body>
<header id="bar">
  <span id="dot" class="dot idle" title="ready"></span>
  <span id="title"></span>
  <span class="spacer"></span>
  <select id="mode" title="Permission mode (Shift+Tab cycles)"></select>
  <select id="model" title="Model"></select>
  <button id="toTerminal" class="icon" title="Switch this session to the terminal (CLI) view">&gt;_</button>
</header>
<main id="log"></main>
<div id="permits"></div>
<footer>
  <div id="statusline"><span id="status"></span><span class="spacer"></span><span id="usage"></span></div>
  <div id="attachments"></div>
  <div id="popup" hidden></div>
  <div id="composer">
    <textarea id="input" rows="1" placeholder="Message Claude  (/ commands, @ files, paste images)" title="Enter to send, Shift+Enter for a new line, Esc to stop, Shift+Tab to change mode"></textarea>
    <button id="send" title="Send (Enter)">Send</button>
    <button id="stop" title="Stop (Esc)" hidden>Stop</button>
  </div>
</footer>
<script nonce="${nonce}" src="${u('marked.umd.js')}"></script>
<script nonce="${nonce}" src="${u('chat.js')}"></script>
</body></html>`;
  }
}

module.exports = { ChatPanel };
