// Discovers Claude Code conversations from the local data folder.
// Claude Code (CLI and the official VS Code extension) writes one JSONL file
// per session to <dataDir>/projects/<encoded-cwd>/<sessionId>.jsonl.
// We only read these files; we never modify them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

const metaCache = new Map(); // file -> { key, meta }

function dataDir() {
  const configured = vscode.workspace.getConfiguration('claudeCC').get('claudeDataDir');
  if (configured) return configured.replace(/^~(?=$|[\\/])/, os.homedir());
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsDir() {
  return path.join(dataDir(), 'projects');
}

/** Normalised key for comparing folder paths (case-insensitive on Windows/macOS). */
function pathKey(p) {
  let r = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform !== 'linux') r = r.toLowerCase();
  return r;
}

/** Same encoding Claude Code uses for project folder names. */
function encodeProjectPath(p) {
  return path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text, dropFirstPartial) {
  const lines = text.split('\n');
  if (dropFirstPartial) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

/** Plain text of a user message, or '' if it is a tool result / system injection. */
function userText(rec) {
  const c = rec.message && rec.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter(b => b.type === 'text').map(b => b.text).join('\n');
  text = text.trim();
  if (!text || text.startsWith('<') || rec.isMeta) return '';
  return text;
}

function assistantText(rec) {
  const c = rec.message && rec.message.content;
  if (!Array.isArray(c)) return typeof c === 'string' ? c : '';
  return c.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function titleFrom(records) {
  let title = '';
  for (const r of records) {
    if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
    else if (r.type === 'summary' && r.summary && !title) title = r.summary;
    else if (r.type === 'ai-title' && (r.aiTitle || r.title) && !title) title = r.aiTitle || r.title;
  }
  return title;
}

function readMeta(file, stat) {
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = metaCache.get(file);
  if (cached && cached.key === key) return cached.meta;

  const head = parseLines(readSlice(file, 0, Math.min(HEAD_BYTES, stat.size)), false);
  const tail = stat.size > HEAD_BYTES
    ? parseLines(readSlice(file, stat.size - TAIL_BYTES, TAIL_BYTES), true)
    : [];

  let cwd = '';
  let firstPrompt = '';
  let entrypoint = '';
  let gitBranch = '';
  let hasConversation = false;
  for (const r of head) {
    if (!cwd && r.cwd) cwd = r.cwd;
    if (!entrypoint && r.entrypoint) entrypoint = r.entrypoint;
    if (!gitBranch && r.gitBranch) gitBranch = r.gitBranch;
    if (r.type === 'user' && !r.isSidechain) {
      const t = userText(r);
      if (t && !firstPrompt) firstPrompt = t;
    }
    if (r.type === 'assistant') hasConversation = true;
  }
  let lastPrompt = '';
  for (const r of head.concat(tail)) {
    if (r.type === 'last-prompt' && r.lastPrompt) lastPrompt = r.lastPrompt;
    if (r.type === 'assistant') hasConversation = true;
  }
  const custom = titleFrom(head.concat(tail));

  const meta = {
    id: path.basename(file, '.jsonl'),
    file,
    cwd,
    title: oneLine(custom || firstPrompt || lastPrompt || '(untitled)'),
    firstPrompt,
    lastPrompt,
    entrypoint,
    gitBranch,
    mtime: stat.mtimeMs,
    size: stat.size,
    hasConversation,
  };
  metaCache.set(file, { key, meta });
  return meta;
}

function oneLine(s) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 87) + '...' : s;
}

/**
 * Scan all sessions. Returns Map<pathKey, { path, sessions: meta[] }> with
 * sessions sorted newest first.
 */
function scanAll() {
  const root = projectsDir();
  const projects = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return projects; }

  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;
      let meta;
      try { meta = readMeta(file, stat); } catch { continue; }
      if (!meta.cwd || !meta.hasConversation) continue;
      const k = pathKey(meta.cwd);
      if (!projects.has(k)) projects.set(k, { path: meta.cwd, sessions: [] });
      projects.get(k).sessions.push(meta);
    }
  }
  for (const p of projects.values()) p.sessions.sort((a, b) => b.mtime - a.mtime);
  return projects;
}

/** Where a session's transcript will live (works for sessions not yet written). */
function sessionFile(projectPath, sessionId) {
  const encoded = path.join(projectsDir(), encodeProjectPath(projectPath), sessionId + '.jsonl');
  if (fs.existsSync(encoded)) return encoded;
  // Fall back to a search in case the encoding differs between versions.
  try {
    for (const d of fs.readdirSync(projectsDir())) {
      const f = path.join(projectsDir(), d, sessionId + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
  } catch { /* no data dir yet */ }
  return encoded;
}

/**
 * Activity state from the end of a transcript:
 * 'working'  - Claude is mid-turn (last record is a user prompt / tool result, or an unfinished assistant step)
 * 'done'     - last assistant message ended the turn
 * 'unknown'  - nothing readable yet
 * The caller combines 'working' with "no writes for a while" to detect a pending approval.
 */
function activityState(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { state: 'unknown', mtime: 0, size: 0 }; }
  const len = Math.min(TAIL_BYTES, stat.size);
  const recs = parseLines(readSlice(file, stat.size - len, len), stat.size > len);
  let state = 'unknown';
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r.isSidechain) continue;
    if (r.type === 'assistant') {
      const sr = r.message && r.message.stop_reason;
      state = sr === 'end_turn' || sr === 'stop_sequence' || sr === 'max_tokens' || sr === 'refusal' ? 'done' : 'working';
      break;
    }
    if (r.type === 'user') {
      const c = r.message && r.message.content;
      const interrupted = typeof c === 'string'
        ? c.startsWith('[Request interrupted')
        : Array.isArray(c) && c.some(b => b.type === 'text' && /^\[Request interrupted/.test(b.text || ''));
      state = interrupted ? 'done' : 'working';
      break;
    }
  }
  return { state, mtime: stat.mtimeMs, size: stat.size };
}

/** Full transcript rendered as Markdown for read-only preview. */
function transcriptMarkdown(meta) {
  const text = fs.readFileSync(meta.file, 'utf8');
  const recs = parseLines(text, false);
  const out = [`# ${meta.title}`, '', `- Project: \`${meta.cwd}\``, `- Session: \`${meta.id}\``,
    `- Last activity: ${new Date(meta.mtime).toLocaleString()}`, ''];
  for (const r of recs) {
    if (r.isSidechain) continue;
    if (r.type === 'user') {
      const t = userText(r);
      if (t) out.push('---', '', '### You', '', t, '');
    } else if (r.type === 'assistant') {
      const t = assistantText(r);
      if (t) out.push('### Claude', '', t, '');
    } else if (r.type === 'summary' && r.summary) {
      out.push('> _Compacted: ' + r.summary + '_', '');
    }
  }
  return out.join('\n');
}

module.exports = { scanAll, pathKey, sessionFile, activityState, transcriptMarkdown, dataDir, oneLine };
