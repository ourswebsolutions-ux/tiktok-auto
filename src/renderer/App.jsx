import React, { useCallback, useEffect, useState } from 'react';

const api = window.api;

const STATUS_LABELS = {
  published: 'Published',
  scheduled: 'Scheduled',
  generating: 'Generating',
  uploading: 'Uploading',
  posting: 'Publishing',
  unverified: 'Confirming',
  tiktok_scheduled: 'Scheduled on TikTok',
  failed: 'Failed',
  missed: 'Missed',
  cancelled: 'Cancelled',
};

const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');

function statusLine(state) {
  const s = state.status;
  if (s.phase === 'attention') return { tone: 'warn', text: 'Needs your attention' };
  if (s.phase === 'chrome') return { tone: 'warn', text: 'Waiting for Chrome' };
  if (s.phase === 'working' || s.phase === 'connecting') return { tone: 'busy', text: s.step || 'Working...' };
  if (s.phase === 'stopping') return { tone: 'busy', text: 'Stopping...' };
  if (state.running) {
    if (state.schedulingMode === 'tiktok') {
      return { tone: 'ok', text: s.nextPostAt ? `Running (TikTok scheduling) - next upload for ${fmtTime(s.nextPostAt)}` : 'Running (TikTok scheduling) - today\'s posts are scheduled on TikTok' };
    }
    return { tone: 'ok', text: s.nextPostAt ? `Running - next post at ${fmtTime(s.nextPostAt)}` : (s.step || 'Running - daily target reached') };
  }
  return { tone: 'off', text: 'Stopped' };
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
      <p>{prompt.text}</p>
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

  const refresh = useCallback(async () => {
    const s = await api.getState();
    setState(s);
    setQty((q) => (q === '' ? String(s.dailyQuantity) : q));
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

  const start = async () => {
    await saveQty(qty);
    setNotice(null);
    const r = await api.start();
    if (!r.ok) setNotice({ tone: 'warn', title: r.message, text: r.instructions });
    refresh();
  };

  const check = async () => {
    setChecking(true);
    setNotice({ tone: 'info', title: 'Checking your Chrome, ChatGPT and TikTok...', text: 'Two tabs open briefly in your Chrome and close again. If Chrome asks "Allow remote debugging?", click Allow.' });
    try {
      const r = await api.checkChrome();
      if (r.chatgpt) {
        setNotice({
          tone: r.ok ? 'ok' : 'warn',
          title: r.ok ? 'Connected to your everyday Chrome' : 'Chrome connected, but something needs attention',
          text: `ChatGPT: ${r.chatgpt.ok ? 'OK' : 'Problem'} - ${r.chatgpt.detail}\nTikTok: ${r.tiktok.ok ? 'OK' : 'Problem'} - ${r.tiktok.detail}`,
        });
      } else {
        setNotice({ tone: 'warn', title: r.message, text: r.instructions });
      }
    } finally {
      setChecking(false);
      refresh();
    }
  };

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo" aria-hidden>▶</span>
          <h1>TikTok Auto Poster</h1>
          <span className="version" title={(state.app && state.app.update && state.app.update.message) || ''}>{updateText(state.app)}</span>
        </div>
        <div className={`status ${st.tone}`}><span className="dot" />{st.text}</div>
      </header>

      {(s.phase === 'attention' || s.phase === 'chrome') && (
        <div className="banner warn">
          <div>
            <strong>{s.message}</strong>
            {s.phase === 'attention' && <p>{s.step}</p>}
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

      <section className="grid">
        <div className="card controls">
          <label htmlFor="qty">Posts per day</label>
          <div className="qty-row">
            <input
              id="qty"
              type="number"
              min={1}
              max={20}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onBlur={() => saveQty(qty)}
            />
            {state.running
              ? <button className="btn stop" onClick={() => api.stop().then(refresh)}>Stop Automation</button>
              : <button className="btn primary" onClick={start} disabled={!state.prompts.length}>Start Automation</button>}
          </div>
          <div className="mode-row" role="radiogroup" aria-label="Scheduling">
            <span className="mode-label">Scheduling</span>
            <div className="segmented">
              <button
                type="button"
                role="radio"
                aria-checked={state.schedulingMode !== 'tiktok'}
                className={state.schedulingMode !== 'tiktok' ? 'on' : ''}
                onClick={() => api.setSchedulingMode('software').then(refresh)}
              >
                Software-Based
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={state.schedulingMode === 'tiktok'}
                className={state.schedulingMode === 'tiktok' ? 'on' : ''}
                onClick={() => api.setSchedulingMode('tiktok').then(refresh)}
              >
                TikTok-Based
              </button>
            </div>
          </div>
          <p className="hint">
            {state.schedulingMode === 'tiktok'
              ? 'Posts are uploaded one by one ahead of time and scheduled on TikTok for the calculated times (spread across 24 hours).'
              : 'Posting times are calculated automatically and spread across the full 24 hours.'}
            {' '}<button className="link" disabled={checking} onClick={check}>{checking ? 'Checking...' : 'Check Chrome connection'}</button>
          </p>
        </div>
        <div className="card stat"><span className="num">{state.stats.totalPublished}</span><span className="lbl">Total published</span></div>
        <div className="card stat"><span className="num">{state.stats.todayPublished}</span><span className="lbl">Published today</span></div>
        <div className="card stat"><span className="num">{state.stats.pending}</span><span className="lbl">Pending</span></div>
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
        <h2>Publishing history</h2>
        {state.history.length === 0 ? <p className="empty">Nothing scheduled yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Date</th><th>Time</th><th>Caption</th><th>Status</th></tr>
              </thead>
              <tbody>
                {state.history.map((h) => {
                  const t = h.published_at || h.scheduled_at;
                  return (
                    <tr key={h.id}>
                      <td className="nowrap">{fmtDate(t)}</td>
                      <td className="nowrap">{fmtTime(t)}</td>
                      <td className="caption">
                        {h.title && <strong>{h.title}</strong>}
                        <span>{h.caption || <em className="muted">Content is generated at posting time</em>}</span>
                        {h.hashtags.length > 0 && <span className="tags">{h.hashtags.join(' ')}</span>}
                        {h.sound_title && <span className="sound" title={h.sound_evidence || ''}>♪ {h.sound_title}</span>}
                        {h.error && h.status !== 'published' && <span className="error">{h.error}</span>}
                      </td>
                      <td><span className={`badge ${h.status}`}>{STATUS_LABELS[h.status] || h.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
