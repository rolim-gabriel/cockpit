// Chat pane UI. Talks to src/chat/panel.js via postMessage.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const log = $('log'), input = $('input'), popup = $('popup'), permits = $('permits');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  marked.use({ gfm: true, breaks: false, renderer: { html: t => esc(t.text || t.raw || '') } });
  const md = text => { try { return marked.parse(text); } catch { return esc(text); } };

  const S = {
    commands: [], models: [], mode: 'default', busy: false, tools: new Map(), stream: null, streamText: '',
    images: [], popupItems: [], popupIndex: 0, popupKind: null, startedAt: 0, project: '',
    opts: {}, rc: false, ctx: null,
  };
  const MODES = [
    ['default', 'Ask before edits'], ['acceptEdits', 'Edit automatically'], ['plan', 'Plan mode'], ['auto', 'Auto mode'],
  ];

  // ---- scrolling ---------------------------------------------------------
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const toBottom = force => { if (force || S.stick) log.scrollTop = log.scrollHeight; };
  log.addEventListener('scroll', () => { S.stick = nearBottom(); });
  S.stick = true;

  // ---- rendering -----------------------------------------------------------
  function add(node) { log.appendChild(node); toBottom(); return node; }

  function userBubble(text, images) {
    const b = el('div', 'msg user');
    if (images) b.appendChild(el('div', 'chip', `${images} image${images > 1 ? 's' : ''}`));
    b.appendChild(el('div', 'text', text));
    return add(b);
  }

  function assistantBubble(text, node) {
    const b = node || el('div', 'msg assistant');
    b.classList.remove('streaming');
    b.innerHTML = md(text);
    linkify(b);
    return node ? b : add(b);
  }

  function linkify(root) {
    root.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!/^[a-z]+:/i.test(href)) a.addEventListener('click', ev => { ev.preventDefault(); vscode.postMessage({ type: 'openFile', path: href.replace(/#.*$/, '') }); });
    });
  }

  function brief(name, i) {
    i = i || {};
    switch (name) {
      case 'Bash': return i.description || i.command;
      case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return rel(i.file_path || i.notebook_path);
      case 'Grep': return `${i.pattern}${i.path ? ' in ' + rel(i.path) : ''}`;
      case 'Glob': return i.pattern;
      case 'WebFetch': return i.url;
      case 'WebSearch': return i.query;
      case 'Task': case 'Agent': return i.description;
      case 'TodoWrite': return `${(i.todos || []).length} items`;
      default: { const v = Object.values(i).find(x => typeof x === 'string'); return v || ''; }
    }
  }
  const rel = p => (p && S.project && p.startsWith(S.project) ? p.slice(S.project.length + 1) : p) || '';

  function inputView(name, i) {
    const box = el('div', 'tool-input');
    if (name === 'Bash' && i.command) box.appendChild(el('pre', 'code', '$ ' + i.command));
    else if ((name === 'Edit' || name === 'MultiEdit') && (i.old_string != null || i.edits)) {
      const edits = i.edits || [{ old_string: i.old_string, new_string: i.new_string }];
      for (const e of edits) box.appendChild(diffView(e.old_string || '', e.new_string || ''));
    } else if (name === 'Write' && i.content != null) box.appendChild(el('pre', 'code', i.content.length > 3000 ? i.content.slice(0, 3000) + '\n...' : i.content));
    else if (name === 'TodoWrite' && i.todos) {
      const ul = el('ul', 'todos');
      for (const t of i.todos) ul.appendChild(el('li', 'todo ' + t.status, (t.status === 'completed' ? '[x] ' : t.status === 'in_progress' ? '[~] ' : '[ ] ') + (t.content || t.activeForm)));
      box.appendChild(ul);
    } else if (name === 'ExitPlanMode' && i.plan) { const d = el('div', 'plan'); d.innerHTML = md(i.plan); box.appendChild(d); }
    else box.appendChild(el('pre', 'code', JSON.stringify(i, null, 2)));
    return box;
  }

  function diffView(a, b) {
    const pre = el('pre', 'code diff');
    for (const l of a.split('\n')) pre.appendChild(el('div', 'del', '- ' + l));
    for (const l of b.split('\n')) pre.appendChild(el('div', 'ins', '+ ' + l));
    return pre;
  }

  function toolCard(item) {
    const d = el('details', 'tool');
    const s = el('summary');
    s.appendChild(el('span', 'tname', item.name));
    const b = brief(item.name, item.input);
    if (b) {
      const span = el('span', 'tbrief', b);
      const fp = item.input && (item.input.file_path || item.input.notebook_path);
      if (fp) { span.classList.add('link'); span.addEventListener('click', ev => { ev.preventDefault(); vscode.postMessage({ type: 'openFile', path: fp }); }); }
      s.appendChild(span);
    }
    s.appendChild(el('span', 'tstate', '...'));
    d.appendChild(s);
    d.appendChild(inputView(item.name, item.input || {}));
    if (item.name === 'TodoWrite') d.open = true;
    S.tools.set(item.id, d);
    return add(d);
  }

  function toolResult(item) {
    const card = S.tools.get(item.id);
    if (!card) return;
    card.querySelector('.tstate').textContent = item.isError ? 'error' : 'done';
    card.classList.add(item.isError ? 'err' : 'ok');
    if (item.text && item.text.trim()) card.appendChild(el('pre', 'code result', item.text));
  }

  function render(items) {
    for (const it of items) {
      if (it.type === 'user') userBubble(it.text, it.images);
      else if (it.type === 'assistant') {
        if (S.stream) { assistantBubble(it.text, S.stream); S.stream = null; S.streamText = ''; }
        else assistantBubble(it.text);
      } else if (it.type === 'thinking') {
        const d = el('details', 'thinking'); d.appendChild(el('summary', null, 'Thinking')); d.appendChild(el('div', 'text', it.text)); add(d);
      } else if (it.type === 'tool') toolCard(it);
      else if (it.type === 'toolResult') toolResult(it);
      else if (it.type === 'notice') add(el('div', 'notice', it.text));
    }
  }

  // Live token streaming of the current text block.
  let streamTimer;
  function onStream(ev) {
    if (ev.type === 'content_block_start') {
      const t = ev.content_block && ev.content_block.type;
      if (t === 'text') { S.stream = add(el('div', 'msg assistant streaming')); S.streamText = ''; }
      setStatus(t === 'thinking' ? 'Thinking...' : t === 'tool_use' ? `Using ${ev.content_block.name}...` : 'Writing...');
    } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && S.stream) {
      S.streamText += ev.delta.text;
      if (!streamTimer) streamTimer = setTimeout(() => { streamTimer = null; if (S.stream) { S.stream.innerHTML = md(S.streamText); toBottom(); } }, 80);
    }
  }

  // ---- permission prompts ------------------------------------------------
  function permissionCard(id, req) {
    const card = el('div', 'permit');
    card.dataset.id = id;
    const name = req.display_name || req.tool_name;
    const answer = decision => { vscode.postMessage({ type: 'permission', id, decision }); card.remove(); updateDot(); };

    if (req.tool_name === 'AskUserQuestion' && req.input && Array.isArray(req.input.questions)) {
      card.appendChild(el('div', 'ptitle', 'Claude has a question'));
      const answers = {};
      for (const q of req.input.questions) {
        card.appendChild(el('div', 'pq', q.question));
        const row = el('div', 'prow');
        for (const opt of q.options || []) {
          const btn = el('button', 'opt', opt.label);
          if (opt.description) btn.title = opt.description;
          btn.onclick = () => {
            if (q.multiSelect) { btn.classList.toggle('on'); answers[q.question] = [...row.querySelectorAll('.on')].map(b => b.textContent).join(', '); }
            else { row.querySelectorAll('.opt').forEach(b => b.classList.remove('on')); btn.classList.add('on'); answers[q.question] = opt.label; }
          };
          row.appendChild(btn);
        }
        const other = el('input', 'other'); other.placeholder = 'Other...';
        other.oninput = () => { answers[q.question] = other.value; row.querySelectorAll('.opt').forEach(b => b.classList.remove('on')); };
        row.appendChild(other);
        card.appendChild(row);
      }
      const row = el('div', 'prow');
      const ok = el('button', 'primary', 'Submit answers');
      ok.onclick = () => answer({ behavior: 'allow', updatedInput: { ...req.input, answers } });
      const no = el('button', null, 'Skip');
      no.onclick = () => answer({ behavior: 'deny', message: 'The user declined to answer.' });
      row.append(ok, no);
      card.appendChild(row);
    } else {
      const plan = req.tool_name === 'ExitPlanMode';
      card.appendChild(el('div', 'ptitle', plan ? 'Ready to code? Review the plan' : (req.title || `Allow ${name}?`)));
      if (req.description && !plan) card.appendChild(el('div', 'pdesc', req.description));
      if (req.decision_reason) card.appendChild(el('div', 'pdesc dim', req.decision_reason));
      card.appendChild(inputView(req.tool_name, req.input || {}));
      const row = el('div', 'prow');
      const allow = el('button', 'primary', plan ? 'Approve plan' : 'Allow');
      allow.onclick = () => answer({ behavior: 'allow' });
      row.appendChild(allow);
      if (req.permission_suggestions && req.permission_suggestions.length && !plan) {
        const always = el('button', null, labelForSuggestions(req.permission_suggestions));
        always.onclick = () => answer({ behavior: 'allow', updatedPermissions: req.permission_suggestions });
        row.appendChild(always);
      }
      const fb = el('input', 'other'); fb.placeholder = plan ? 'What should change in the plan?' : 'Or tell Claude what to do instead...';
      const deny = el('button', 'danger', plan ? 'Keep planning' : 'Deny');
      deny.onclick = () => answer({ behavior: 'deny', message: fb.value || (plan ? 'The user wants to keep planning.' : 'The user declined this action.') });
      fb.onkeydown = e => { if (e.key === 'Enter') deny.click(); };
      row.append(deny, fb);
      card.appendChild(row);
    }
    permits.appendChild(card);
    updateDot();
    const first = card.querySelector('button.primary');
    if (first) first.focus();
  }

  function labelForSuggestions(s) {
    const mode = s.find(x => x.type === 'setMode');
    if (mode && mode.mode === 'acceptEdits') return 'Allow all edits this session';
    const rules = s.flatMap(x => x.rules || []).map(r => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    return rules.length ? `Always allow ${rules.slice(0, 2).join(', ')}` : "Allow, don't ask again";
  }

  // ---- header controls ---------------------------------------------------
  function fillModels(models, current) {
    const sel = $('model');
    sel.innerHTML = '';
    for (const m of models) { const o = el('option', null, m.displayName || m.value); o.value = m.value; o.title = m.description || ''; sel.appendChild(o); }
    if (current) {
      const match = models.find(m => m.value === current || m.resolvedModel === current);
      if (match) sel.value = match.value;
      else { const o = el('option', null, current); o.value = current; sel.appendChild(o); sel.value = current; }
    }
    fillModelOptions();
  }
  // Effort levels and fast mode depend on the selected model.
  function fillModelOptions() {
    const m = S.models.find(x => x.value === $('model').value) || {};
    const eff = $('effort');
    const levels = m.supportsEffort ? (m.supportedEffortLevels || ['low', 'medium', 'high']) : [];
    eff.hidden = !levels.length;
    eff.innerHTML = '';
    const def = el('option', null, 'Effort: default'); def.value = ''; eff.appendChild(def);
    for (const l of levels) { const o = el('option', null, 'Effort: ' + l); o.value = l; eff.appendChild(o); }
    eff.value = levels.includes(S.opts.effort) ? S.opts.effort : '';
    $('fast').hidden = !m.supportsFastMode;
    $('fast').classList.toggle('on', !!S.opts.fast && !!m.supportsFastMode);
  }
  function fillModes(current, autoAvailable) {
    const sel = $('mode');
    sel.innerHTML = '';
    for (const [v, label] of MODES) {
      if (v === 'auto' && !autoAvailable && current !== 'auto') continue;
      const o = el('option', null, label); o.value = v; sel.appendChild(o);
    }
    if (current) { S.mode = current; sel.value = current; }
  }
  $('model').onchange = e => { S.opts.model = e.target.value; fillModelOptions(); vscode.postMessage({ type: 'setModel', model: e.target.value }); };
  $('effort').onchange = e => { S.opts.effort = e.target.value; vscode.postMessage({ type: 'setEffort', effort: e.target.value }); };
  $('fast').onclick = () => { S.opts.fast = !S.opts.fast; $('fast').classList.toggle('on', S.opts.fast); vscode.postMessage({ type: 'setFast', on: S.opts.fast }); };
  $('ctx').onclick = () => { openMenu([{ label: 'Loading context usage...' }]); S.menuKind = 'context'; vscode.postMessage({ type: 'context' }); };
  $('more').onclick = e => { e.stopPropagation(); if (!menu.hidden) return closeMenu(); mainMenu(); };

  // ---- per-chat options menu ------------------------------------------------
  const menu = $('menu');
  function openMenu(items) {
    menu.innerHTML = '';
    for (const it of items) {
      if (it.sep) { menu.appendChild(el('div', 'msep')); continue; }
      const row = el('div', 'mitem' + (it.action ? '' : ' static'));
      row.appendChild(el('span', 'mlabel', it.label));
      if (it.hint) row.appendChild(el('span', 'mhint', it.hint));
      if (it.action) row.onclick = ev => { ev.stopPropagation(); it.action(); };
      menu.appendChild(row);
    }
    menu.hidden = false;
  }
  function closeMenu() { menu.hidden = true; S.menuKind = null; }
  document.addEventListener('click', ev => { if (!menu.contains(ev.target)) closeMenu(); });
  function mainMenu() {
    S.menuKind = 'main';
    openMenu([
      { label: 'Rename chat...', action: () => { closeMenu(); vscode.postMessage({ type: 'rename' }); } },
      { label: 'Compact conversation', hint: '/compact', action: () => { closeMenu(); vscode.postMessage({ type: 'compact' }); } },
      { label: 'Context usage', hint: S.ctx ? S.ctx + '%' : '', action: () => $('ctx').onclick() },
      { label: 'MCP servers...', action: () => { openMenu([{ label: 'Loading MCP servers...' }]); S.menuKind = 'mcp'; vscode.postMessage({ type: 'mcp' }); } },
      { label: S.rc ? 'Remote Control: on (turn off)' : 'Remote Control: turn on', hint: 'continue from phone / claude.ai',
        action: () => { closeMenu(); vscode.postMessage({ type: 'remoteControl', enabled: !S.rc }); } },
      { sep: true },
      { label: 'Switch to terminal (CLI) view', hint: '>_', action: () => { closeMenu(); vscode.postMessage({ type: 'switchView' }); } },
      { label: 'Command Center settings', action: () => { closeMenu(); vscode.postMessage({ type: 'settings' }); } },
    ]);
  }
  function mcpMenu(servers) {
    if (!servers.length) return openMenu([{ label: 'No MCP servers configured for this project.' }]);
    openMenu(servers.map(s => ({
      label: `${s.status === 'connected' ? '\u25CF' : '\u25CB'} ${s.name}`,
      hint: s.status === 'disabled' ? 'disabled - click to enable' : s.status === 'failed' ? 'failed - click to reconnect' : `${s.status} - click to disable`,
      action: () => vscode.postMessage(s.status === 'failed' ? { type: 'mcpReconnect', name: s.name } : { type: 'mcpToggle', name: s.name, enabled: s.status === 'disabled' }),
    })));
  }
  function contextMenu(m) {
    const k = n => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
    openMenu([{ label: `${m.percentage}% used: ${k(m.total)} of ${k(m.max)} tokens`, hint: m.model || '' }, { sep: true },
      ...(m.categories || []).map(c => ({ label: c.name, hint: k(c.tokens) })), { sep: true },
      { label: 'Compact now', hint: '/compact', action: () => { closeMenu(); vscode.postMessage({ type: 'compact' }); } }]);
  }
  $('mode').onchange = e => { S.mode = S.opts.permissionMode = e.target.value; vscode.postMessage({ type: 'setMode', mode: S.mode }); };
  $('toTerminal').onclick = () => vscode.postMessage({ type: 'switchView' });

  function setStatus(text) { $('status').textContent = text || ''; }
  function updateDot() {
    const dot = $('dot');
    const waiting = permits.children.length > 0;
    dot.className = 'dot ' + (waiting ? 'waiting' : S.busy ? 'working' : 'idle');
    dot.title = waiting ? 'waiting for you' : S.busy ? 'working' : 'ready';
  }
  let ticker;
  function setBusy(b) {
    S.busy = b;
    $('send').hidden = false;
    $('stop').hidden = !b;
    updateDot();
    clearInterval(ticker);
    if (b) {
      S.startedAt = Date.now();
      ticker = setInterval(() => { if (!$('status').textContent.startsWith('Error')) $('statusline').dataset.elapsed = Math.round((Date.now() - S.startedAt) / 1000) + 's'; }, 1000);
    } else { setStatus(''); $('statusline').dataset.elapsed = ''; }
  }

  // ---- composer ----------------------------------------------------------
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 260) + 'px'; }
  function send() {
    const text = input.value.trim();
    if (!text && !S.images.length) return;
    userBubble(text, S.images.length);
    toBottom(true); S.stick = true;
    vscode.postMessage({ type: 'send', text, images: S.images.map(i => ({ media_type: i.media_type, data: i.data })) });
    input.value = ''; S.images = []; renderAttachments(); autosize(); hidePopup(); saveDraft();
    setBusy(true);
  }
  $('send').onclick = send;
  $('stop').onclick = () => vscode.postMessage({ type: 'interrupt' });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) { closeMenu(); return; }
    if (!popup.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); movePopup(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickPopup(S.popupIndex); return; }
      if (e.key === 'Escape') { e.preventDefault(); hidePopup(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && S.busy) { e.preventDefault(); vscode.postMessage({ type: 'interrupt' }); }
    else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const opts = [...$('mode').options].map(o => o.value);
      const next = opts[(opts.indexOf(S.mode) + 1) % opts.length];
      $('mode').value = next; S.mode = next; vscode.postMessage({ type: 'setMode', mode: next });
    }
  });
  input.addEventListener('input', () => { autosize(); updatePopup(); saveDraft(); });
  input.addEventListener('paste', e => {
    for (const item of e.clipboardData.items) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      const r = new FileReader();
      r.onload = () => { const [, data] = String(r.result).split(','); S.images.push({ media_type: item.type, data }); renderAttachments(); };
      r.readAsDataURL(item.getAsFile());
    }
  });
  function renderAttachments() {
    const box = $('attachments'); box.innerHTML = '';
    S.images.forEach((img, i) => {
      const c = el('span', 'chip'); const im = el('img'); im.src = `data:${img.media_type};base64,${img.data}`; c.appendChild(im);
      const x = el('button', 'x', 'x'); x.onclick = () => { S.images.splice(i, 1); renderAttachments(); }; c.appendChild(x); box.appendChild(c);
    });
  }

  // Slash-command and @-file popups.
  function updatePopup() {
    const v = input.value, caret = input.selectionStart;
    const before = v.slice(0, caret);
    const slash = /^\/(\S*)$/.exec(before);
    const at = /(?:^|\s)@([^\s]*)$/.exec(before);
    if (slash) {
      const q = slash[1].toLowerCase();
      const list = S.commands.filter(c => c.name.toLowerCase().includes(q) || (c.aliases || []).some(a => a.includes(q)))
        .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name)).slice(0, 50);
      showPopup('slash', list.map(c => ({ label: '/' + c.name, hint: c.argumentHint || '', desc: c.description || '', value: c.name })));
    } else if (at) {
      S.atQuery = at[1];
      vscode.postMessage({ type: 'files', q: at[1] });
    } else hidePopup();
  }
  function showPopup(kind, items) {
    S.popupKind = kind; S.popupItems = items; S.popupIndex = 0;
    if (!items.length) return hidePopup();
    popup.innerHTML = '';
    items.forEach((it, i) => {
      const row = el('div', 'pitem' + (i === 0 ? ' sel' : ''));
      row.appendChild(el('span', 'plabel', it.label));
      if (it.hint) row.appendChild(el('span', 'phint', it.hint));
      if (it.desc) row.appendChild(el('span', 'pdesc', it.desc));
      row.onmousedown = e => { e.preventDefault(); pickPopup(i); };
      popup.appendChild(row);
    });
    popup.hidden = false;
  }
  function hidePopup() { popup.hidden = true; S.popupKind = null; }
  function movePopup(d) {
    const rows = popup.children; if (!rows.length) return;
    rows[S.popupIndex].classList.remove('sel');
    S.popupIndex = (S.popupIndex + d + rows.length) % rows.length;
    rows[S.popupIndex].classList.add('sel'); rows[S.popupIndex].scrollIntoView({ block: 'nearest' });
  }
  function pickPopup(i) {
    const it = S.popupItems[i]; if (!it) return;
    const caret = input.selectionStart, v = input.value;
    if (S.popupKind === 'slash') input.value = '/' + it.value + ' ' + v.slice(caret);
    else {
      const start = v.slice(0, caret).lastIndexOf('@');
      input.value = v.slice(0, start) + '@' + it.value + ' ' + v.slice(caret);
    }
    hidePopup(); input.focus(); autosize();
  }

  function saveDraft() { vscode.setState({ draft: input.value }); }
  const st = vscode.getState(); if (st && st.draft) { input.value = st.draft; setTimeout(autosize); }

  // ---- messages from the extension ---------------------------------------
  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'hello':
        S.project = m.project;
        S.opts = m.options || {};
        $('title').textContent = `${m.projectName}: ${m.title}`;
        $('title').title = m.project;
        if (m.truncated) add(el('div', 'notice', 'Earlier messages are hidden here, but Claude still has them in context.'));
        render(m.items);
        if (m.items.length) add(el('div', 'notice', 'Resumed. Claude has the full conversation above in context.'));
        toBottom(true);
        input.focus();
        break;
      case 'title': $('title').textContent = `${S.project.split(/[\\/]/).pop()}: ${m.title}`; break;
      case 'info':
        S.commands = m.commands;
        S.models = m.models;
        fillModels(m.models, S.opts.model || 'default');
        fillModes(S.opts.permissionMode || m.permissionMode || S.mode, m.models.some(x => x.supportsAutoMode));
        break;
      case 'init':
        if (S.models.length && !S.opts.model) fillModels(S.models, m.model);
        if (m.permissionMode) { S.mode = m.permissionMode; $('mode').value = m.permissionMode; }
        break;
      case 'external': userBubble(m.text, 0); toBottom(true); setBusy(true); break;
      case 'stream': onStream(m.event); break;
      case 'items': render(m.items); break;
      case 'status': setStatus(m.text); break;
      case 'busy': setBusy(m.busy); break;
      case 'permission': permissionCard(m.id, m.req); break;
      case 'permissionGone': { const c = permits.querySelector(`[data-id="${m.id}"]`); if (c) c.remove(); updateDot(); break; }
      case 'result': {
        if (S.stream && S.streamText) { assistantBubble(S.streamText, S.stream); S.stream = null; }
        if (m.isError && m.text) add(el('div', 'notice err', m.text));
        $('usage').textContent = `last turn ${Math.round((m.durationMs || 0) / 100) / 10}s`;
        setBusy(false);
        break;
      }
      case 'options':
        S.opts = { ...m.options };
        if (S.models.length) fillModels(S.models, S.opts.model || 'default');
        if (S.opts.permissionMode) { S.mode = S.opts.permissionMode; $('mode').value = S.mode; }
        break;
      case 'context': {
        S.ctx = m.percentage;
        const c = $('ctx');
        c.textContent = m.percentage + '%';
        c.className = 'meter' + (m.percentage >= 80 ? ' hot' : m.percentage >= 60 ? ' warm' : '');
        c.title = `Context used by this chat: ${m.total} of ${m.max} tokens. Click for details.`;
        if (m.categories && S.menuKind === 'context') contextMenu(m);
        break;
      }
      case 'mcp': if (S.menuKind === 'mcp') mcpMenu(m.servers); break;
      case 'remoteControl':
        S.rc = !!m.enabled && !m.error;
        if (m.error) add(el('div', 'notice err', 'Remote Control: ' + m.error));
        else {
          const n = el('div', 'notice', m.enabled ? 'Remote Control is on: continue this chat from claude.ai/code or the Claude app. ' : 'Remote Control is off.');
          if (m.url) { const a = el('a', null, m.url); a.href = m.url; n.appendChild(a); }
          add(n);
        }
        break;
      case 'files': if (S.atQuery === m.q) showPopup('file', m.list.map(f => ({ label: f, value: f }))); break;
      case 'error': add(el('div', 'notice err', m.text)); setBusy(false); break;
      case 'exited': {
        const n = el('div', 'notice' + (m.code ? ' err' : ''), m.code ? `Claude stopped (exit ${m.code}). ${m.stderr || ''}` : 'Claude process ended.');
        const b = el('button', null, 'Restart'); b.onclick = () => { vscode.postMessage({ type: 'restart' }); b.remove(); };
        n.appendChild(b); add(n);
        permits.innerHTML = '';
        setBusy(false);
        break;
      }
    }
  });

  fillModes('default', false);
  vscode.postMessage({ type: 'ready' });
})();
