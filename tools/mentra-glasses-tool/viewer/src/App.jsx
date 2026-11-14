import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const api = window.glasses;

/** media://local/<path inside the data folder>, each part escaped. */
export const mediaUrl = (rel) => 'media://local/' + rel.split('/').map(encodeURIComponent).join('/');

const fmtTime = (ms) =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : 'unknown time';
const fmtClock = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(ms % 1000).padStart(3, '0') : '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The recorder's live feed, as the app's main process passes it on. */
function useLive() {
  const [state, setState] = useState({
    online: false,
    status: null,
    events: [],
    processes: { status: { recorder: { running: false }, frames: { running: false } }, log: [] },
  });
  useEffect(() => {
    let alive = true;
    api.live().then((s) => alive && setState((prev) => ({ ...prev, ...s })));
    const off = api.onLive((p) =>
      setState((prev) => {
        if (p.type === 'online') return { ...prev, online: p.online, status: p.online ? prev.status : null };
        if (p.type === 'message' && p.msg.kind === 'status') return { ...prev, status: p.msg };
        if (p.type === 'message' && p.msg.kind === 'event') return { ...prev, events: [...prev.events.slice(-199), p.msg] };
        if (p.type === 'proc') return { ...prev, processes: { ...prev.processes, status: p.status } };
        if (p.type === 'log') return { ...prev, processes: { ...prev.processes, log: [...prev.processes.log.slice(-299), p.entry] } };
        return prev;
      }),
    );
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/** 'offline': no recorder. 'waiting': recorder on, no glasses. 'connected': glasses are sending. */
const phaseOf = (live) => (!live.online ? 'offline' : live.status?.sessions?.length ? 'connected' : 'waiting');
const PHASE_TEXT = { offline: 'Recorder off', waiting: 'Waiting for glasses', connected: 'Glasses connected' };
const modeOf = (live) => live.status?.recorder?.mode ?? null;
const CONNECTED_TEXT = { receiver: 'Receiving from glasses', frames: 'Fast screenshots' };
const phaseLabel = (live, phase) => (phase === 'connected' ? CONNECTED_TEXT[modeOf(live)] ?? PHASE_TEXT[phase] : PHASE_TEXT[phase]);

export default function App() {
  const [lib, setLib] = useState(null);
  const [selected, setSelected] = useState({ kind: 'live' }); // { kind: 'live' | 'session', id }
  const live = useLive();
  const phase = phaseOf(live);

  const refresh = useCallback(async () => setLib(await api.scan()), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000); // new screenshots show up by themselves
    return () => clearInterval(t);
  }, [refresh]);

  // A new photo from the glasses: look at the folder again right away.
  // At most once a second: fast screenshots come many a second.
  const lastEvent = live.events.at(-1);
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (lastEvent?.event?.type !== 'photo' || Date.now() - lastRefresh.current < 1000) return;
    lastRefresh.current = Date.now();
    refresh();
  }, [lastEvent, refresh]);

  // Drop a selection whose folder disappeared.
  useEffect(() => {
    if (!lib || selected.kind === 'live') return;
    const exists = lib.sessions.some((x) => x.id === selected.id);
    if (!exists) setSelected({ kind: 'live' });
  }, [lib, selected]);

  const choose = async () => {
    await api.chooseFolder();
    setSelected(null);
    refresh();
  };

  if (!lib) return <div className="loading">Loading…</div>;
  const item = selected.kind === 'session' && lib.sessions.find((x) => x.id === selected.id);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <span className="dot" aria-hidden />
          Glasses Viewer
        </header>
        <button className="folder" onClick={choose} title={lib.root}>
          <span className="folder-label">Data folder</span>
          <span className="folder-path">
            <bdi dir="ltr">{lib.root}</bdi>
          </span>
        </button>

        <button className={`nav live-nav ${selected.kind === 'live' ? 'active' : ''}`} onClick={() => setSelected({ kind: 'live' })}>
          <span className="nav-title">
            <span className={`status-dot ${phase}`} aria-hidden />
            Live
          </span>
          <span className="nav-sub">{phaseLabel(live, phase)}</span>
        </button>

        <Section title="Screenshot sessions" count={lib.sessions.length}>
          {lib.sessions.map((s) => (
            <NavItem
              key={s.id}
              active={selected?.kind === 'session' && selected.id === s.id}
              onClick={() => setSelected({ kind: 'session', id: s.id })}
              title={fmtTime(s.time)}
              sub={`${plural(s.photoCount ?? s.photos.length, 'screenshot')} · ${plural(s.events, 'event')}`}
              live={s.live}
            />
          ))}
        </Section>
      </aside>

      <main className="main">
        {selected.kind === 'live' && <LiveView live={live} phase={phase} lib={lib} onChanged={refresh} />}
        {selected.kind !== 'live' && !item && <Empty lib={lib} onChoose={choose} />}
        {item && <SessionView key={item.id} session={item} />}
      </main>
    </div>
  );
}

function Section({ title, count, children }) {
  return (
    <section className="section">
      <h2>
        {title} <span className="count">{count}</span>
      </h2>
      {count === 0 ? <p className="none">None yet</p> : <ul>{children}</ul>}
    </section>
  );
}

function NavItem({ active, onClick, title, sub, live }) {
  return (
    <li>
      <button className={`nav ${active ? 'active' : ''}`} onClick={onClick}>
        <span className="nav-title">
          {title}
          {live && <span className="live">LIVE</span>}
        </span>
        <span className="nav-sub">{sub}</span>
      </button>
    </li>
  );
}

function Empty({ lib, onChoose }) {
  return (
    <div className="empty">
      <h1>{lib.exists ? 'Nothing recorded yet' : 'No data folder here yet'}</h1>
      <p>
        This app shows the screenshots <code>mentra-glasses-tool</code> saves. Run <code>npm run frames</code> in{' '}
        <code>mentra-glasses-tool</code>, point the glasses' stream at it, and screenshots appear here by themselves.
      </p>
      <p className="muted">Looking in {lib.root}</p>
      <button className="primary" onClick={onChoose}>
        Choose another folder
      </button>
    </div>
  );
}

function Toolbar({ title, meta, reveal, children }) {
  return (
    <div className="toolbar">
      <div>
        <h1>{title}</h1>
        <p className="muted">{meta}</p>
      </div>
      <div className="toolbar-actions">
        {children}
        <button onClick={() => api.reveal(reveal)}>Show in Finder</button>
      </div>
    </div>
  );
}

function SessionView({ session }) {
  const [tab, setTab] = useState('photos');
  const [open, setOpen] = useState(null);
  const [events, setEvents] = useState([]);

  useEffect(() => {
    if (tab !== 'events') return;
    let stop = false;
    const load = async () => {
      const ev = await api.events(session.id);
      if (!stop) setEvents(ev);
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [tab, session.id]);

  const total = session.photoCount ?? session.photos.length;
  const offset = total - session.photos.length; // the library lists the newest ones of a big run
  const meta = [session.label, plural(total, 'screenshot'), plural(session.events, 'event'), session.imu ? plural(session.imu, 'IMU sample') : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="view">
      <Toolbar title={fmtTime(session.time)} meta={meta} reveal={session.photos[0] ?? `${session.id}/events.jsonl`}>
        <div className="tabs" role="tablist">
          {['photos', 'events'].map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'photos' ? 'Screenshots' : 'Events'}
            </button>
          ))}
        </div>
      </Toolbar>

      {tab === 'photos' &&
        (session.photos.length ? (
          <>
            {offset > 0 && (
              <p className="muted pad">Showing the newest {session.photos.length} of {total} screenshots. All of them are in the folder (Show in Finder).</p>
            )}
            <Grid items={session.photos} offset={offset} onOpen={setOpen} />
          </>
        ) : (
          <p className="muted pad">No screenshots in this session.</p>
        ))}
      {tab === 'events' && <EventsTable events={events} />}
      {open !== null && <Lightbox items={session.photos} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Grid({ items, onOpen, offset = 0 }) {
  return (
    <div className="grid">
      {items.map((rel, i) => (
        <button key={rel} className="thumb" onClick={() => onOpen(i)} title={rel.split('/').pop()}>
          <img src={mediaUrl(rel)} alt="" loading="lazy" draggable={false} />
          <span className="thumb-n">{offset + i + 1}</span>
        </button>
      ))}
    </div>
  );
}

function Lightbox({ items, index, onIndex, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onIndex(Math.min(items.length - 1, index + 1));
      if (e.key === 'ArrowLeft') onIndex(Math.max(0, index - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onIndex, onClose]);

  const rel = items[index];
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="Photo">
      <img src={mediaUrl(rel)} alt="" onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <button disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous">
          ←
        </button>
        <span>
          {index + 1} / {items.length} · {rel.split('/').pop()}
        </span>
        <button disabled={index === items.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next">
          →
        </button>
        <button onClick={() => api.reveal(rel)}>Show in Finder</button>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function EventsTable({ events }) {
  const [filter, setFilter] = useState('all');
  const types = useMemo(() => ['all', ...new Set(events.map((e) => e.type))], [events]);
  const shown = (filter === 'all' ? events : events.filter((e) => e.type === filter)).slice().reverse();
  if (!events.length) return <p className="muted pad">No events yet.</p>;
  return (
    <div className="events">
      <div className="chips">
        {types.map((t) => (
          <button key={t} className={filter === t ? 'chip on' : 'chip'} onClick={() => setFilter(t)}>
            {t}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e, i) => {
            const { time, type, ...rest } = e;
            const details = Object.keys(rest).length ? JSON.stringify(rest) : '';
            return (
              <tr key={`${time}-${i}`}>
                <td className="mono">{fmtClock(time)}</td>
                <td>
                  <span className={`tag tag-${String(type).replace(/[^a-z_]/gi, '')}`}>{String(type)}</span>
                </td>
                <td className="mono details" title={details}>
                  {details}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};

function describe(e) {
  switch (e.type) {
    case 'photo': return e.reason === 'mentra-app' ? `Photo received (${Math.round((e.bytes ?? 0) / 1000)} kB)` : e.reason === 'stream' ? `Screenshot saved (${Math.round((e.bytes ?? 0) / 1000)} kB)` : `Photo saved (${e.reason ?? 'timer'})`;
    case 'frames_start': return 'Waiting for the glasses\' stream';
    case 'frames_end': return `Stream ended (${e.frames} screenshots)`;
    case 'receiver_start': return 'Receiver started';
    case 'bodyos_stored': return `Kept in the device API (${e.artifactId ?? 'no id'})`;
    case 'bodyos_failed': return `The device API did not keep it: ${e.error}`;
    case 'bodyos_skipped': return `Not sent to the device API: ${e.reason}`;
    case 'photo_error': return `Photo failed: ${e.message}`;
    case 'head_position': return `Head ${e.position}`;
    case 'button': return `Button: ${e.pressType} press`;
    case 'touch': return `Touch: ${String(e.gesture ?? '').replace(/_/g, ' ')}`;
    case 'battery': return `Battery ${e.level}%${e.charging ? ', charging' : ''}`;
    case 'stream_status': return `Stream: ${e.status}`;
    case 'stream_error': return `Stream failed: ${e.message}`;
    case 'session_start': return 'Glasses connected';
    case 'session_end': return 'Glasses disconnected';
    default: return e.type;
  }
}

function LiveView({ live, phase, lib, onChanged }) {
  const [fast, setFast] = useState(true);
  const [message, setMessage] = useState('');
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 1000); // keeps "5 s ago" fresh
    return () => clearInterval(t);
  }, []);

  const proc = live.processes.status;
  const ours = proc.recorder.running;
  const session = live.status?.sessions?.at(-1) ?? null;
  const mine = session ? live.events.filter((m) => m.sessionId === session.sessionId).map((m) => m.event) : [];
  const last = (type) => [...mine].reverse().find((e) => e.type === type);
  const photos = mine.filter((e) => e.type === 'photo');
  const latestPhoto = photos.at(-1);
  const receiving = modeOf(live) === 'receiver';
  const framesRun = modeOf(live) === 'frames'; // npm run frames started in a terminal
  const uploadUrl = receiving ? live.status?.recorder?.uploadUrl : null;
  const rtmpUrl = receiving || framesRun ? live.status?.recorder?.rtmpUrl : null;
  const [copied, setCopied] = useState('');
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      /* the address stays selectable */
    }
  };
  const battery = last('battery');
  const head = last('head_position');
  const caps = last('session_start')?.capabilities;
  const recorderDir = live.status?.recorder?.dataDir;
  const otherFolder = recorderDir && lib.root !== recorderDir;
  // npm run frames keeps latest.jpg (its newest screenshot) fresh: show it twice a second.
  const liveShot = lib.sessions.find((s) => s.live && s.latest);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!liveShot) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [liveShot]);

  const start = async (mode) => {
    setMessage('');
    const res = await api.startRecorder(mode, mode !== 'demo' && fast);
    if (!res?.ok) setMessage(res?.message ?? 'Could not start.');
  };

  return (
    <div className="view">
      <div className="toolbar">
        <div>
          <h1>Live</h1>
          <p className="muted">
            {receiving || !live.online
              ? 'Glasses → your Wi-Fi → this Mac → here. Mentra’s app sends the commands over Bluetooth.'
              : 'Glasses → phone (Bluetooth) → Mentra cloud → recorder on this Mac → here'}
          </p>
        </div>
        <span className={`pill ${phase}`}>
          <span className={`status-dot ${phase}`} aria-hidden />
          {phaseLabel(live, phase)}
        </span>
      </div>

      <section className="panel controls">
        {ours ? (
          <>
            <p>
              <strong>
                {{ demo: 'Demo glasses running', receiver: 'Receiver running', glasses: 'Cloud recorder running' }[proc.recorder.mode] ?? 'Running'}
              </strong>
              {proc.frames.running && ' · fast screenshots from the live stream'}
            </p>
            <button onClick={() => api.stopRecorder()}>Stop</button>
          </>
        ) : live.online ? (
          <p>A recorder started in a terminal is running. Stop it there with Ctrl+C.</p>
        ) : (
          <>
            <button className="primary" onClick={() => start('receiver')}>Receive from glasses</button>
            <label className="check" title="npm run frames: a screenshot per frame of the glasses' live stream, each sent to the device API when BODYOS_API_URL is set">
              <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} /> fast screenshots
            </label>
            <span className="sep" />
            <button onClick={() => start('demo')}>Try demo glasses</button>
            <button onClick={() => start('glasses')}>Cloud recorder</button>
          </>
        )}
        {message && <p className="warn">{message}. See the recorder output below.</p>}
      </section>

      {otherFolder && (
        <div className="notice panel">
          <p>The recorder saves to {recorderDir}, but this app is showing {lib.root}.</p>
          <button onClick={async () => { await api.useFolder(recorderDir); onChanged(); }}>Show the recorder's folder</button>
        </div>
      )}

      {phase === 'offline' && !ours && (
        <section className="panel hint">
          <h2>Get screenshots from the glasses</h2>
          <ol>
            <li>Connect the glasses in Mentra’s example app (TestFlight, on this Mac or your iPhone) and put them on the same Wi-Fi as this Mac.</li>
            <li>Leave <strong>fast screenshots</strong> ticked and press <strong>Receive from glasses</strong>. It shows two addresses.</li>
            <li>In Mentra’s app: paste the <em>stream</em> address into the <strong>Stream</strong> screen and start it. Every frame becomes a screenshot here and in the device API.</li>
            <li>Single photos work too: Camera screen, <strong>Use cloud server</strong>, paste the <em>Media upload URL</em>.</li>
          </ol>
          <p className="muted">
            No glasses yet? <strong>Try demo glasses</strong>. Using the MentraOS app and ngrok instead? <strong>Cloud recorder</strong> (needs <code>.env</code>).
          </p>
        </section>
      )}

      {phase === 'waiting' && (
        <section className="panel hint">
          <h2>Recorder is on. Waiting for the glasses</h2>
          <p>Open your app on the glasses from the MentraOS phone app. The glasses talk Bluetooth to the phone, the phone sends everything here.</p>
        </section>
      )}

      {framesRun && rtmpUrl && (
        <section className="panel urls">
          <h2>Paste into Mentra’s app</h2>
          <div className="url-row">
            <span className="url-label">Stream (Stream screen)</span>
            <code className="url">{rtmpUrl}</code>
            <button onClick={() => copy(rtmpUrl)}>{copied === rtmpUrl ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="muted">Every frame becomes a screenshot in this Mac’s data folder, and in the device API when BODYOS_API_URL is set.</p>
        </section>
      )}

      {uploadUrl && (
        <section className="panel urls">
          <h2>Paste into Mentra’s app</h2>
          <div className="url-row">
            <span className="url-label">Media upload URL</span>
            <code className="url">{uploadUrl}</code>
            <button onClick={() => copy(uploadUrl)}>{copied === uploadUrl ? 'Copied' : 'Copy'}</button>
          </div>
          {rtmpUrl && proc.frames.running && (
            <div className="url-row">
              <span className="url-label">Stream (Stream screen)</span>
              <code className="url">{rtmpUrl}</code>
              <button onClick={() => copy(rtmpUrl)}>{copied === rtmpUrl ? 'Copied' : 'Copy'}</button>
            </div>
          )}
          <p className="muted">
            Glasses and this Mac must be on the same Wi-Fi.{' '}
            {proc.frames.running
              ? 'Stream address: every frame becomes a screenshot. Media upload URL: single photos.'
              : 'Single photos only. Tick “fast screenshots” before starting for many a second.'}
          </p>
        </section>
      )}

      {phase === 'connected' && (
        <div className="live-grid">
          <section className="panel">
            <h2>{liveShot ? 'Newest screenshot' : 'Newest photo'}</h2>
            {liveShot ? (
              <>
                <img className="live-frame" src={`${mediaUrl(liveShot.latest)}?t=${tick}`} alt="Newest screenshot from the glasses' stream" />
                <p className="muted">{plural(liveShot.photoCount, 'screenshot')} so far</p>
              </>
            ) : latestPhoto ? (
              <>
                <img className="live-frame" src={mediaUrl(`${session.sessionId}/${latestPhoto.file}`)} alt="Newest photo from the glasses" />
                <p className="muted">{fmtClock(latestPhoto.time)} · {ago(latestPhoto.time)}</p>
              </>
            ) : (
              <p className="muted">
                {receiving || framesRun ? 'Nothing yet. Start the stream (or take a photo) in Mentra’s app.' : 'No photo yet. The first one takes a few seconds.'}
              </p>
            )}
          </section>

          <section className="panel glasses-card">
            <h2>{receiving ? 'Received' : 'Glasses'}</h2>
            <dl>
              {receiving ? (
                <>
                  <dt>Since</dt><dd>{ago(session.startedAt)}</dd>
                  <dt>Photos</dt><dd>{photos.length}</dd>
                </>
              ) : (
                <>
              <dt>Model</dt><dd>{caps?.modelName ?? 'unknown'}</dd>
              <dt>Connected</dt><dd>{ago(session.startedAt)}</dd>
              <dt>Battery</dt>
              <dd>
                {battery ? (
                  <span className="battery">
                    <span className="battery-track"><span style={{ width: `${Math.min(100, Math.max(0, battery.level))}%` }} /></span>
                    {battery.level}%
                  </span>
                ) : '…'}
              </dd>
              <dt>Head</dt><dd>{head ? head.position : '…'}</dd>
              <dt>Photos</dt><dd>{photos.length}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="panel feed">
            <h2>{receiving ? 'What arrived' : 'What the glasses send'}</h2>
            <ul>
              {[...mine].reverse().slice(0, 40).map((e, i) => (
                <li key={`${e.time}-${i}`} className={/error/.test(e.type) ? 'bad' : ''}>
                  <span className="mono">{fmtClock(e.time)}</span>
                  <span>{describe(e)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      <details className="panel log" open={!!message}>
        <summary>Recorder output ({live.processes.log.length})</summary>
        <pre>
          {live.processes.log.length
            ? live.processes.log.map((l) => `${fmtClock(l.time)} [${l.source}] ${l.line}`).join('\n')
            : 'Nothing yet. Output appears here when the recorder is started from this app.'}
        </pre>
      </details>
    </div>
  );
}
