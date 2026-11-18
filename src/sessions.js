// Discovers Claude Code conversations from the local data folder.
// Claude Code (CLI and the official VS Code extension) writes one JSONL file
// per session to <dataDir>/projects/<encoded-cwd>/<sessionId>.jsonl.
// We only read these files; we never modify them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

// Most of what we need (cwd, first prompt) is in the first records; read more only if not.
const HEAD_BYTES = 64 * 1024;
const MAX_HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const KEEP_TEXT = 600; // prompt text kept in the cache (tooltips show 400)

const metaCache = new Map(); // file -> { key, meta, seen }
const CACHE_VERSION = 1; // bump when the metadata format changes

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

function metaFromRecords(file, stat, head, tail) {
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
  return {
    id: path.basename(file, '.jsonl'),
    file,
    cwd,
    title: oneLine(custom || firstPrompt || lastPrompt || '(untitled)'),
    firstPrompt: firstPrompt.slice(0, KEEP_TEXT),
    lastPrompt: lastPrompt.slice(0, KEEP_TEXT),
    entrypoint,
    gitBranch,
    mtime: stat.mtimeMs,
    size: stat.size,
    hasConversation,
  };
}

const headIsEnough = recs => recs.some(r => r.cwd) && recs.some(r => r.type === 'user' && userText(r)) && recs.some(r => r.type === 'assistant');

function readMeta(file, stat) {
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = metaCache.get(file);
  if (cached && cached.key === key) return cached.meta;
  let len = Math.min(HEAD_BYTES, stat.size);
  let head = parseLines(readSlice(file, 0, len), false);
  while (!headIsEnough(head) && len < stat.size && len < MAX_HEAD_BYTES) {
    len = Math.min(len * 4, MAX_HEAD_BYTES, stat.size);
    head = parseLines(readSlice(file, 0, len), false);
  }
  const tail = stat.size > len ? parseLines(readSlice(file, stat.size - TAIL_BYTES, TAIL_BYTES), true) : [];
  const meta = metaFromRecords(file, stat, head, tail);
  metaCache.set(file, { key, meta });
  return meta;
}

async function readSliceAsync(file, start, length) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function readMetaAsync(file, stat) {
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = metaCache.get(file);
  if (cached && cached.key === key) return cached.meta;
  let len = Math.min(HEAD_BYTES, stat.size);
  let head = parseLines(await readSliceAsync(file, 0, len), false);
  while (!headIsEnough(head) && len < stat.size && len < MAX_HEAD_BYTES) {
    len = Math.min(len * 4, MAX_HEAD_BYTES, stat.size);
    head = parseLines(await readSliceAsync(file, 0, len), false);
  }
  const tail = stat.size > len ? parseLines(await readSliceAsync(file, stat.size - TAIL_BYTES, TAIL_BYTES), true) : [];
  const meta = metaFromRecords(file, stat, head, tail);
  metaCache.set(file, { key, meta });
  return meta;
}

/** The metadata cache survives restarts, so only new or changed transcripts are read. */
function loadCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== CACHE_VERSION) return; // older format: rebuild
    for (const [k, v] of Object.entries(data.entries)) metaCache.set(k, v);
  } catch { /* first run */ }
}

function saveCache(file) {
  const tmp = `${file}.${process.pid}.tmp`; // several windows may save at once
  try {
    const live = {};
    for (const [k, v] of metaCache) if (v.seen) live[k] = { key: v.key, meta: v.meta };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries: live }));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing written */ }
  }
}

function oneLine(s) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 87) + '...' : s;
}

/** Groups session metadata by project; a chat with two names (linked) is listed once. */
function group(metas) {
  const projects = new Map();
  const byId = new Map();
  for (const meta of metas) {
    if (!meta || !meta.cwd || !meta.hasConversation) continue;
    // A chat can have two names (Claude Command Center links it into another history folder
    // for the official panel). List it once, by the name in its own project's folder.
    const prev = byId.get(meta.id);
    if (prev) {
      if (path.basename(path.dirname(prev.file)) === encodeProjectPath(prev.cwd)) continue;
      if (path.basename(path.dirname(meta.file)) !== encodeProjectPath(meta.cwd)) continue;
      const pk = projects.get(pathKey(prev.cwd));
      if (pk) pk.sessions = pk.sessions.filter(s => s !== prev);
    }
    byId.set(meta.id, meta);
    const k = pathKey(meta.cwd);
    if (!projects.has(k)) projects.set(k, { path: meta.cwd, sessions: [] });
    projects.get(k).sessions.push(meta);
  }
  for (const p of projects.values()) p.sessions.sort((a, b) => b.mtime - a.mtime);
  return projects;
}

function markSeen(file) {
  const c = metaCache.get(file);
  if (c) c.seen = true;
}

/**
 * Scan all sessions. Returns Map<pathKey, { path, sessions: meta[] }> with
 * sessions sorted newest first.
 */
// Only transcripts found by the latest full scan are saved, so deleted ones drop out of the cache.
function resetSeen() {
  for (const v of metaCache.values()) v.seen = false;
}

function scanAll() {
  resetSeen();
  const root = projectsDir();
  const metas = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return new Map(); }
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size === 0) continue;
        metas.push(readMeta(file, stat));
        markSeen(file);
      } catch { /* unreadable: skip */ }
    }
  }
  return group(metas);
}

/** Same as scanAll, without blocking VS Code: reads in small batches and yields in between. */
async function scanAllAsync() {
  resetSeen();
  const root = projectsDir();
  const metas = [];
  let dirs = [];
  try { dirs = (await fs.promises.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()); } catch { return new Map(); }
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files = [];
    try { files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-')); } catch { continue; }
    for (let i = 0; i < files.length; i += 16) {
      const batch = await Promise.all(files.slice(i, i + 16).map(async f => {
        const file = path.join(dir, f);
        try {
          const stat = await fs.promises.stat(file);
          if (!stat.isFile() || stat.size === 0) return undefined;
          const meta = await readMetaAsync(file, stat);
          markSeen(file);
          return meta;
        } catch { return undefined; }
      }));
      metas.push(...batch);
    }
  }
  return group(metas);
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

module.exports = { scanAll, scanAllAsync, loadCache, saveCache, pathKey, sessionFile, activityState, transcriptMarkdown, dataDir, oneLine, encodeProjectPath };
