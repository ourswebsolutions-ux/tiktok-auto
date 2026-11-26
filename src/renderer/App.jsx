import React, { useCallback, useEffect, useState } from 'react';

const api = window.api;

// Post status shown in the schedule list (real states from the two workers - nothing invented).
function postLabel(h, mode) {
  const retry = !!h.error;
  switch (h.status) {
    case 'scheduled': return retry ? ['Temporarily failed - retrying', 'retry'] : ['Waiting for image', 'scheduled'];
    case 'generating': return ['Generating image', 'generating'];
    case 'ready': return retry ? ['Retrying upload', 'retry'] : ['Image ready - waiting for upload', 'ready'];
    case 'uploading': return ['Uploading to TikTok', 'uploading'];
    case 'posting': return [mode === 'tiktok' ? 'Scheduling on TikTok' : 'Publishing', 'uploading'];
    case 'unverified': return ['Uploading again', 'retry'];
    case 'tiktok_scheduled': return ['Successfully scheduled', 'tiktok_scheduled'];
    case 'published': return ['Published', 'published'];
    case 'failed': return ['Failed', 'failed'];
    case 'missed': return ['Missed', 'missed'];
    case 'cancelled': return ['Cancelled', 'cancelled'];
    default: return [h.status, h.status];
  }
}

const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');

function statusLine(state) {
  const s = state.status;
  if (s.phase === 'attention') return { tone: 'warn', title: 'Needs your attention', text: s.message || 'Action needed in Chrome' };
  if (s.phase === 'chrome') return { tone: 'warn', title: 'Waiting for Chrome', text: s.message || 'Chrome is not reachable' };
  if (s.phase === 'connecting') return { tone: 'busy', title: 'Connecting', text: s.step || 'Connecting to your Chrome...' };
  if (s.phase === 'stopping') return { tone: 'busy', title: 'Stopping', text: 'Finishing the current step...' };
  if (state.running) {
    const sw = state.switches || {};
    const what = sw.generate && sw.upload ? 'Generating and uploading' : sw.generate ? 'Generating and saving images only (upload is off)' : 'Uploading already generated posts only (generation is off)';
    const mode = state.schedulingMode === 'tiktok' ? 'TikTok-Based scheduling' : 'Software-Based scheduling';
    return { tone: 'ok', title: 'Running', text: `${what} · ${mode}` };
  }
  return { tone: 'off', title: 'Paused', text: 'Both switches are off - turn on Generate images and/or Auto upload to TikTok' };
}

// Large on/off switch used for the two automation switches.
function Switch({ label, on, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="track"><span className="knob" /></span>
      <span className="switch-label">{label}<small>{on ? 'ON' : 'OFF'}</small></span>
    </button>
  );
}

const WORKER_STATE = {
  working: ['Working', 'busy'],
  idle: ['Idle', 'ok'],
  waiting: ['Waiting', 'off'],
  paused: ['Paused', 'warn'],
  attention: ['Needs you', 'warn'],
};

// One live status card per worker (image generation / TikTok upload). A progress bar only appears when the website
// itself reports a percentage.
function WorkerCard({ icon, title, worker, running, footer, tabs }) {
  const [label, tone] = running ? (WORKER_STATE[worker.state] || ['Idle', 'ok']) : ['Off', 'off'];
  const pct = (worker.text || '').match(/(\d{1,3})%/);
  return (
    <div className={`worker ${running ? tone : 'off'}`}>
      <div className="worker-head">
        <span className="worker-icon" aria-hidden>{icon}</span>
        <strong>{title}</strong>
        <span className={`pill ${running ? tone : 'off'}`}>{label}</span>
      </div>
      <p className="worker-text">
        {running ? (worker.text || (worker.state === 'idle' ? 'Nothing to do right now' : '...')) : 'Switched off'}
        {worker.postId ? <span className="muted"> · post #{worker.postId}</span> : null}
      </p>
      {running && pct && <div className="bar"><span style={{ width: `${Math.min(100, Number(pct[1]))}%` }} /></div>}
      {running && tabs && tabs.length > 1 && (
        <ul className="tabs-list">
          {tabs.map((t) => {
            const [tl, tt] = WORKER_STATE[t.state] || ['Idle', 'ok'];
            return (
              <li key={t.key}>
                <span className={`pill ${tt}`}>{tl}</span>
                <span className="tab-name">Tab {Number(t.key.slice(4)) + 1}</span>
                <span className="tab-text">{t.text || 'Waiting for the next post'}{t.postId ? ` · post #${t.postId}` : ''}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="worker-foot">{footer}</p>
    </div>
  );
}

function updateText(appInfo) {
  if (!appInfo) return '';
  const u = appInfo.update;
  const v = `v${appInfo.version}`;
  if (!u) return v;
  if (u.status === 'checking') return `${v} · checking for updates...`;
  if (u.status === 'up-to-date') return `${v} · up to date`;
  if (u.status === 'downloading') return `${v} · downloading update ${u.version || ''} ${u.progress != null ? `(${u.progress}%)` : ''}`;
  if (u.status === 'ready') return `${v} · update ${u.version} installs automatically when idle`;
  if (u.status === 'error') return `${v} · update check failed`;
  return v;
}

// Local image file -> URL the dashboard can display (Windows and Linux paths).
const fileUrl = (p) => encodeURI(`file://${p.startsWith('/') ? '' : '/'}${p.replace(/\\/g, '/')}`).replace(/#/g, '%23');

// Errors are shown short (internal details, screenshot paths stay in the tooltip and logs).
const shortError = (e) => {
  const clean = String(e).replace(/\s*\[screenshot:[^\]]*\]/, '').replace(/\s*\(waiting for [^)]*\)/, '');
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
};

function PromptItem({ prompt, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(prompt.text);
  useEffect(() => setText(prompt.text), [prompt.text]);
  if (editing) {
    return (
      <li className="prompt editing">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus />
        <div className="row-actions">
          <button className="btn primary small" onClick={async () => { await onSave(prompt.id, text); setEditing(false); }}>Save</button>
          <button className="btn small" onClick={() => { setText(prompt.text); setEditing(false); }}>Cancel</button>
        </div>
      </li>
    );
  }
  return (
    <li className="prompt">
      <p className="prompt-text" title="Click Edit to see or change the full prompt">{prompt.text}</p>
      <div className="row-actions">
        <button className="btn small" onClick={() => setEditing(true)}>Edit</button>
        <button className="btn small danger" onClick={() => { if (confirm('Delete this prompt?')) onDelete(prompt.id); }}>Delete</button>
      </div>
    </li>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [newPrompt, setNewPrompt] = useState('');
  const [qty, setQty] = useState('');
  const [notice, setNotice] = useState(null); // { tone, title, text }
  const [checking, setChecking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [tabsInput, setTabsInput] = useState('');

  const refresh = useCallback(async () => {
    const s = await api.getState();
    setState(s);
    setQty((q) => (q === '' ? String(s.dailyQuantity) : q));
    setTabsInput((t) => (t === '' && s.genMode ? String(s.genMode.tabs) : t));
  }, []);

  useEffect(() => {
    refresh();
    const off = api.onChange(refresh);
    const t = setInterval(refresh, 5000);
    return () => { off(); clearInterval(t); };
  }, [refresh]);

  if (!state) return <div className="loading">Loading...</div>;
  const st = statusLine(state);
  const s = state.status;

  const saveQty = async (value) => {
    const r = await api.setDailyQuantity(value);
    setQty(String(r.value));
  };

  // The two independent switches (both off = automation paused).
  const toggle = async (which, on) => {
    await saveQty(qty);
    setNotice(null);
    const r = which === 'generate' ? await api.setGenerate(on) : await api.setUpload(on);
    if (r && !r.ok && r.message) setNotice({ tone: 'warn', title: r.message, text: r.instructions });
    refresh();
  };

  const check = async () => {
    setChecking(true);
    setNotice({ tone: 'info', title: 'Checking your Chrome, ChatGPT and TikTok...', text: 'Two tabs open briefly in your Chrome and close again. If Chrome asks "Allow remote debugging?", click Allow.' });
    try {
      const r = await api.checkChrome();
      if (r.ai) {
        setNotice({
          tone: r.ok ? 'ok' : 'warn',
          title: r.ok ? 'Connected to your everyday Chrome' : 'Chrome connected, but something needs attention',
          text: `${r.aiName}: ${r.ai.ok ? 'OK' : 'Problem'} - ${r.ai.detail}\nTikTok: ${r.tiktok.ok ? 'OK' : 'Problem'} - ${r.tiktok.detail}`,
        });
      } else {
        setNotice({ tone: 'warn', title: r.message, text: r.instructions });
      }
    } finally {
      setChecking(false);
      refresh();
    }
  };

  const q = state.queue || { waitingForImage: 0, generating: 0, ready: 0, uploading: 0 };
  const sw = state.switches || { generate: false, upload: false };
  const ov = state.overview || { imagesGenerated: 0, pendingUpload: 0, scheduledOnTikTok: 0, published: 0, publishedToday: 0 };
  const gm = state.genMode || { mode: 'single', tabs: 5, active: 1 };
  const aiName = state.aiProvider === 'gemini' ? 'Gemini' : 'ChatGPT';

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo" aria-hidden>▶</span>
          <h1>TikTok Auto Poster</h1>
          <span className="version" title={(state.app && state.app.update && state.app.update.message) || ''}>{updateText(state.app)}</span>
        </div>
      </header>

      {(s.phase === 'attention' || s.phase === 'chrome') && (
        <div className="banner warn">
          <div>
            <strong>{s.message}</strong>
            {s.phase === 'chrome' && s.instructions && <pre>{s.instructions}</pre>}
          </div>
          {s.phase === 'attention' && <button className="btn primary" onClick={() => api.resume().then(refresh)}>Resume</button>}
          {s.phase === 'chrome' && <button className="btn" disabled={checking} onClick={check}>Check Chrome</button>}
        </div>
      )}
      {notice && (
        <div className={`banner ${notice.tone}`}>
          <div>
            <strong>{notice.title}</strong>
            {notice.text && <pre>{notice.text}</pre>}
          </div>
          <button className="btn small" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <section className="card hero">
        <div className="hero-top">
          <div className={`status-big ${st.tone}`}>
            <span className="dot" />
            <div>
              <strong>{st.title}</strong>
              <span>{st.text}</span>
            </div>
          </div>
          <div className="hero-actions">
            <Switch label="Generate images" on={sw.generate} onChange={(v) => toggle('generate', v)} />
            <Switch label="Auto upload to TikTok" on={sw.upload} onChange={(v) => toggle('upload', v)} />
            <button className="btn ghost" disabled={checking} onClick={check}>{checking ? 'Checking...' : 'Check Chrome'}</button>
          </div>
        </div>
        <div className="workers">
          <WorkerCard
            icon="🖼"
            title={`Image generation · ${aiName} · ${gm.mode === 'multi' ? `${gm.active} tabs` : '1 tab'}`}
            tabs={state.genTabs}
            worker={state.workers ? state.workers.gen : {}}
            running={sw.generate}
            footer={`${q.waitingForImage} waiting for an image · ${q.generating} generating`}
          />
          <WorkerCard
            icon="⬆"
            title="TikTok upload"
            worker={state.workers ? state.workers.upload : {}}
            running={sw.upload}
            footer={`${q.ready} image(s) ready · ${q.uploading} uploading`}
          />
        </div>
      </section>

      <section className="stats">
        <div className="card stat"><span className="num">{ov.imagesGenerated}</span><span className="lbl">Images generated</span></div>
        <div className="card stat"><span className="num">{ov.pendingUpload}</span><span className="lbl">Posts pending upload</span></div>
        <div className="card stat"><span className="num">{ov.scheduledOnTikTok}</span><span className="lbl">Posts scheduled on TikTok</span></div>
        <div className="card stat"><span className="num">{ov.published}</span><span className="lbl">Posts published{ov.publishedToday ? ` · ${ov.publishedToday} today` : ''}</span></div>
      </section>

      <section className="card settings">
        <div className="setting">
          <label htmlFor="qty">Posts per day</label>
          <input
            id="qty"
            type="number"
            min={1}
            max={20}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onBlur={() => saveQty(qty)}
          />
        </div>
        <div className="setting" role="radiogroup" aria-label="Image and caption by">
          <label>Image &amp; caption</label>
          <div className="segmented">
            <button type="button" role="radio" aria-checked={state.aiProvider !== 'gemini'} className={state.aiProvider !== 'gemini' ? 'on' : ''} onClick={() => api.setAiProvider('chatgpt').then(refresh)}>ChatGPT</button>
            <button type="button" role="radio" aria-checked={state.aiProvider === 'gemini'} className={state.aiProvider === 'gemini' ? 'on' : ''} onClick={() => api.setAiProvider('gemini').then(refresh)}>Gemini</button>
          </div>
        </div>
        <div className="setting" role="radiogroup" aria-label="Generation mode">
          <label>Generation mode</label>
          <div className="segmented">
            <button type="button" role="radio" aria-checked={gm.mode !== 'multi'} className={gm.mode !== 'multi' ? 'on' : ''} onClick={() => api.setGenMode('single').then(refresh)}>Single tab</button>
            <button type="button" role="radio" aria-checked={gm.mode === 'multi'} className={gm.mode === 'multi' ? 'on' : ''} onClick={() => api.setGenMode('multi', gm.tabs).then(refresh)}>Multiple tabs</button>
          </div>
        </div>
        {gm.mode === 'multi' && (
          <div className="setting">
            <label htmlFor="tabs">How many ChatGPT tabs do you want to use?</label>
            <div className="tabs-count">
              <input
                id="tabs"
                type="number"
                min={2}
                max={10}
                value={tabsInput}
                onChange={(e) => setTabsInput(e.target.value)}
                onBlur={() => api.setGenMode('multi', tabsInput).then((r) => { setTabsInput(String(r.tabs)); refresh(); })}
              />
              <strong>{gm.tabs} tabs</strong>
            </div>
          </div>
        )}
        <div className="setting" role="radiogroup" aria-label="Sound on posts">
          <label>Sound</label>
          <div className="segmented">
            <button type="button" role="radio" aria-checked={state.soundStyle !== 'music'} className={state.soundStyle !== 'music' ? 'on' : ''} onClick={() => api.setSoundStyle('urdu').then(refresh)}>Urdu motivation</button>
            <button type="button" role="radio" aria-checked={state.soundStyle === 'music'} className={state.soundStyle === 'music' ? 'on' : ''} onClick={() => api.setSoundStyle('music').then(refresh)}>Music</button>
          </div>
        </div>
        <div className="setting" role="radiogroup" aria-label="Scheduling">
          <label>Scheduling</label>
          <div className="segmented">
            <button type="button" role="radio" aria-checked={state.schedulingMode !== 'tiktok'} className={state.schedulingMode !== 'tiktok' ? 'on' : ''} onClick={() => api.setSchedulingMode('software').then(refresh)}>Software-Based</button>
            <button type="button" role="radio" aria-checked={state.schedulingMode === 'tiktok'} className={state.schedulingMode === 'tiktok' ? 'on' : ''} onClick={() => api.setSchedulingMode('tiktok').then(refresh)}>TikTok-Based</button>
          </div>
        </div>
        <div className="setting">
          <label>Export folder</label>
          <button className="btn small" onClick={() => api.openExport()} title={state.exportDir || ''}>Open export folder</button>
        </div>
        <p className="hint">
          {state.schedulingMode === 'tiktok'
            ? 'Images are generated continuously and every ready post is scheduled on TikTok for its calculated time (next 10 days, TikTok\'s maximum).'
            : 'Images are generated ahead of time; each post is published at its calculated time, spread across the full 24 hours.'}
        </p>
      </section>

      <section className="card">
        <h2>Prompts</h2>
        <form
          className="add-prompt"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newPrompt.trim()) return;
            await api.addPrompt(newPrompt);
            setNewPrompt('');
            refresh();
          }}
        >
          <textarea
            placeholder="e.g. Motivational quotes for young entrepreneurs with cinematic, moody visuals"
            value={newPrompt}
            rows={2}
            onChange={(e) => setNewPrompt(e.target.value)}
          />
          <button className="btn primary" type="submit" disabled={!newPrompt.trim()}>Add</button>
        </form>
        {state.prompts.length === 0
          ? <p className="empty">No prompts yet. Add at least one to start.</p>
          : (
            <ul className="prompts">
              {state.prompts.map((p) => (
                <PromptItem
                  key={p.id}
                  prompt={p}
                  onSave={async (id, text) => { await api.updatePrompt(id, text); refresh(); }}
                  onDelete={async (id) => { await api.deletePrompt(id); refresh(); }}
                />
              ))}
            </ul>
          )}
      </section>

      <section className="card">
        <h2>Posting schedule</h2>
        {state.history.length === 0 ? <p className="empty">Nothing waiting - published posts are counted above.</p> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Date</th><th>Time</th><th>Image</th><th>Caption</th><th>Status</th></tr>
              </thead>
              <tbody>
                {(showAll ? state.history : state.history.slice(0, 5)).map((h) => {
                  const t = h.published_at || h.slot_at || h.scheduled_at;
                  return (
                    <tr key={h.id}>
                      <td className="nowrap">{fmtDate(t)}</td>
                      <td className="nowrap">{fmtTime(t)}</td>
                      <td>{h.image_path ? <img className="thumb" src={fileUrl(h.image_path)} alt="" loading="lazy" /> : <span className="thumb empty-thumb" />}</td>
                      <td className="caption"><div className="cap">
                        {h.title && <strong>{h.title}</strong>}
                        <span>{h.caption || <em className="muted">Image will be generated automatically</em>}</span>
                        {h.hashtags.length > 0 && <span className="tags">{h.hashtags.join(' ')}</span>}
                        {h.sound_title && <span className="sound" title={h.sound_evidence || ''}>♪ {h.sound_title}</span>}
                        {h.error && h.status !== 'published' && <span className="error" title={h.error}>{shortError(h.error)}</span>}
                      </div></td>
                      <td>{(() => { const [label, cls] = postLabel(h, state.schedulingMode); return <span className={`badge ${cls}`}>{label}</span>; })()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {state.history.length > 5 && (
              <button className="link more" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show less' : `Show all (${state.history.length})`}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
