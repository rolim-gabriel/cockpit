// Converts Claude Code transcript records (from the .jsonl file or live from the CLI)
// into the display items the chat webview renders.

const fs = require('fs');

const MAX_RESULT = 6000;
const MAX_HISTORY_ITEMS = 600;

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '').join('\n');
}

function clip(s, n = MAX_RESULT) {
  return s.length > n ? s.slice(0, n) + `\n... (${s.length - n} more characters)` : s;
}

/** @returns {object[]} display items for one user/assistant record */
function toItems(rec) {
  if (!rec || rec.isSidechain || rec.isMeta) return [];
  const msg = rec.message;
  if (!msg) return [];
  const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];
  const items = [];
  if (rec.type === 'user') {
    let text = '';
    let images = 0;
    for (const b of content) {
      if (b.type === 'text') text += (text ? '\n' : '') + b.text;
      else if (b.type === 'image') images++;
      else if (b.type === 'tool_result') {
        items.push({ type: 'toolResult', id: b.tool_use_id, text: clip(resultText(b.content)), isError: !!b.is_error });
      }
    }
    text = text.trim();
    const cmd = /<command-name>\/?([^<]+)<\/command-name>/.exec(text);
    if (cmd) {
      const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
      items.push({ type: 'user', text: `/${cmd[1].trim()}${args && args[1] ? ' ' + args[1] : ''}`, images: 0 });
    } else if (text.startsWith('[Request interrupted')) {
      items.push({ type: 'notice', text: 'Interrupted' });
    } else if ((text && !text.startsWith('<')) || images) {
      items.push({ type: 'user', text, images });
    }
  } else if (rec.type === 'assistant') {
    for (const b of content) {
      if (b.type === 'text' && b.text.trim()) items.push({ type: 'assistant', text: b.text, id: msg.id });
      else if (b.type === 'thinking' && b.thinking) items.push({ type: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use') items.push({ type: 'tool', id: b.id, name: b.name, input: b.input });
    }
  }
  return items;
}

/** Display items for an existing transcript, newest MAX_HISTORY_ITEMS kept. */
function loadHistory(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { items: [], truncated: false }; }
  const items = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') items.push({ type: 'notice', text: 'Conversation compacted' });
    else if (rec.type === 'summary' && rec.summary) items.push({ type: 'notice', text: 'Summary: ' + rec.summary });
    else if (rec.isCompactSummary) items.push({ type: 'notice', text: 'Conversation compacted (earlier messages summarised for Claude)' });
    else items.push(...toItems(rec));
  }
  const truncated = items.length > MAX_HISTORY_ITEMS;
  return { items: truncated ? items.slice(-MAX_HISTORY_ITEMS) : items, truncated };
}

module.exports = { toItems, loadHistory };
