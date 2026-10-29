// Drives one Claude Code session through the CLI's stream-json mode
// (the same headless protocol the official extension and the Agent SDK use).
// It runs your locally installed, logged-in `claude`, so it uses your subscription.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const vscode = require('vscode');

class ChatEngine extends EventEmitter {
  /**
   * @param {{cwd: string, sessionId: string, resume: boolean, fork?: string, model?: string, permissionMode?: string, effort?: string, fast?: boolean}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.proc = undefined;
    this.buf = '';
    this.pending = new Map(); // our control requests awaiting a response
    this.permissions = new Map(); // CLI permission requests awaiting the user
    this.info = undefined; // initialize response: commands, models, account...
    this.busy = false;
    this.started = false;
  }

  start() {
    if (this.proc) return;
    const cfg = vscode.workspace.getConfiguration('claudeCC');
    const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio', '--include-partial-messages'];
    // First launch of a fork branches the old history; later restarts resume the fork itself.
    if (this.opts.fork && !this.started) args.push('--resume', this.opts.fork, '--fork-session', '--session-id', this.sessionId);
    else if (this.opts.resume || this.started) args.push('--resume', this.sessionId);
    else args.push('--session-id', this.sessionId);
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode);
    if (this.opts.effort) args.push('--effort', this.opts.effort);
    const extra = (cfg.get('extraArgs') || '').trim();
    if (extra) args.push(...extra.split(/\s+/));

    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_SESSION.*|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_REMOTE_SESSION_ID)$/.test(k)) delete env[k];

    const cmd = cfg.get('claudeCommand') || 'claude';
    const win = process.platform === 'win32';
    this.proc = spawn(win && /\s/.test(cmd) ? `"${cmd}"` : cmd, args, { cwd: this.opts.cwd, env, shell: win, windowsHide: true });
    this.started = true;
    this.stderr = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => this.onData(d));
    this.proc.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on('error', err => this.emit('error', `Could not start "${cmd}": ${err.message}. Set claudeCC.claudeCommand to the full path of the Claude Code CLI.`));
    this.proc.on('exit', code => {
      this.proc = undefined;
      this.setBusy(false);
      for (const { reject } of this.pending.values()) reject(new Error('Claude exited'));
      this.pending.clear();
      this.permissions.clear();
      this.emit('exit', code, this.stderr.trim());
    });
    this.request({ subtype: 'initialize' }).then(info => {
      this.info = info;
      if (this.opts.fast) this.applySettings({ fastMode: true }).catch(() => {});
      this.emit('info', info);
    }, () => {});
  }

  write(obj) {
    if (!this.proc) this.start();
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(request) {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ type: 'control_request', request_id: id, request });
    });
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.handle(msg);
    }
  }

  handle(msg) {
    switch (msg.type) {
      case 'control_response': {
        const r = msg.response || {};
        const p = this.pending.get(r.request_id);
        if (!p) return;
        this.pending.delete(r.request_id);
        if (r.subtype === 'error') p.reject(new Error(r.error)); else p.resolve(r.response || {});
        return;
      }
      case 'control_request':
        if (msg.request && msg.request.subtype === 'can_use_tool') {
          this.permissions.set(msg.request_id, msg.request);
          this.emit('permission', msg.request_id, msg.request);
        } else {
          // Requests we do not implement (hooks, MCP bridging...): answer so the CLI is never stuck.
          this.write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'Not supported by Claude Command Center' } });
        }
        return;
      case 'control_cancel_request':
        if (this.permissions.delete(msg.request_id)) this.emit('permissionCancelled', msg.request_id);
        return;
      case 'system':
        if (msg.subtype === 'init') {
          if (msg.session_id) this.sessionId = msg.session_id;
          this.emit('init', msg);
        } else if (msg.subtype === 'status' || msg.subtype === 'compact_boundary') {
          this.emit('system', msg);
        }
        return;
      case 'stream_event':
        this.emit('stream', msg.event, msg.parent_tool_use_id);
        return;
      case 'assistant':
        this.emit('assistant', msg);
        return;
      case 'user':
        this.emit('user', msg);
        return;
      case 'result':
        this.setBusy(false);
        this.emit('result', msg);
        return;
    }
  }

  setBusy(b) {
    if (this.busy === b) return;
    this.busy = b;
    this.emit('busy', b);
  }

  /** @param {string} text @param {{media_type: string, data: string}[]} images */
  send(text, images = []) {
    const content = [];
    for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    if (text) content.push({ type: 'text', text });
    this.setBusy(true);
    this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.sessionId });
  }

  /** decision: {behavior:'allow', updatedInput?, updatedPermissions?} | {behavior:'deny', message} */
  answerPermission(requestId, decision) {
    const req = this.permissions.get(requestId);
    if (!req) return;
    this.permissions.delete(requestId);
    const response = decision.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: decision.updatedInput || req.input, ...(decision.updatedPermissions && { updatedPermissions: decision.updatedPermissions }) }
      : { behavior: 'deny', message: decision.message || 'The user declined this action.', ...(decision.interrupt && { interrupt: true }) };
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { ...response, toolUseID: req.tool_use_id } } });
  }

  interrupt() {
    if (this.proc && this.busy) this.request({ subtype: 'interrupt' }).catch(() => {});
  }

  setModel(model) {
    this.opts.model = model === 'default' ? undefined : model;
    if (this.proc) return this.request({ subtype: 'set_model', model: this.opts.model });
  }

  setPermissionMode(mode) {
    this.opts.permissionMode = mode;
    if (this.proc) return this.request({ subtype: 'set_permission_mode', mode });
  }

  /** Session-only settings layer (same as CLI flags): effortLevel, fastMode... */
  applySettings(settings) {
    return this.request({ subtype: 'apply_flag_settings', settings });
  }

  setEffort(level) {
    this.opts.effort = level || undefined;
    if (this.proc) return this.applySettings({ effortLevel: level || null });
  }

  setFast(on) {
    this.opts.fast = !!on;
    if (this.proc) return this.applySettings({ fastMode: !!on });
  }

  contextUsage() { return this.request({ subtype: 'get_context_usage' }); }
  mcpStatus() { return this.request({ subtype: 'mcp_status' }).then(r => r.mcpServers || []); }
  mcpToggle(serverName, enabled) { return this.request({ subtype: 'mcp_toggle', serverName, enabled }); }
  mcpReconnect(serverName) { return this.request({ subtype: 'mcp_reconnect', serverName }); }
  remoteControl(enabled) { return this.request({ subtype: 'remote_control', enabled }); }
  rename(title) { return this.request({ subtype: 'rename_session', title, source: 'host', session_id: this.sessionId }); }

  dispose() {
    this.removeAllListeners();
    if (this.proc) {
      try { this.proc.stdin.end(); } catch { /* already closed */ }
      const p = this.proc;
      setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500);
    }
  }
}

module.exports = { ChatEngine };
