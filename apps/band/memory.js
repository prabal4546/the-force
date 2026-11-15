// The Memory panel: shows what the brain has remembered about you (facts) and a
// timeline of what it saw and heard. It reads the device API through serve.py's
// /hub proxy (GET /v1/agent/memory, and /v1/artifacts/<id> for each photo).
//
// Standalone on purpose: it takes a band device id and fetches on demand or on a
// timer, so it works whether or not a band is currently connected.

const ID = /^[a-zA-Z0-9_-]{1,128}$/;

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]),
  );
}

function clockTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso || '';
  }
}

function turnCard(turn, base) {
  const photo = turn.image_artifact_id
    ? `<img class="memthumb" alt="what the glasses saw" src="${base}/v1/artifacts/${encodeURIComponent(turn.image_artifact_id)}">`
    : '<div class="memthumb memthumb-empty">no photo</div>';
  const tool = turn.tool ? `<span class="pill">${escapeHtml(turn.tool)}</span>` : '';
  const saw = turn.understanding
    ? `<div class="muted"><b>Saw:</b> ${escapeHtml(turn.understanding)}</div>`
    : '';
  const answer = turn.answer ? `<div><b>Agent:</b> ${escapeHtml(turn.answer)}</div>` : '';
  return `<div class="memturn">${photo}<div class="membody">
      <div class="memtop"><span class="muted">${escapeHtml(clockTime(turn.created_at))}</span> ${tool}</div>
      <div><b>You:</b> ${escapeHtml(turn.command)}</div>
      ${saw}${answer}
    </div></div>`;
}

/**
 * Wire the Memory card.
 *   root        the <section> that holds #memDevice, #memRefresh, #memAuto,
 *               #memState, #memFacts, #memTimeline
 *   base        proxy prefix, default '/hub'
 *   deviceId    prefill for the device input
 *   intervalMs  how often "auto" refreshes
 */
export function createMemoryPanel({ root, base = '/hub', deviceId = '', intervalMs = 2500 } = {}) {
  const device = root.querySelector('#memDevice');
  const refresh = root.querySelector('#memRefresh');
  const auto = root.querySelector('#memAuto');
  const stateEl = root.querySelector('#memState');
  const factsEl = root.querySelector('#memFacts');
  const timelineEl = root.querySelector('#memTimeline');
  const saved = localStorage.getItem('memDevice');
  device.value = saved || deviceId || '';
  let timer = null;

  function render(data) {
    factsEl.innerHTML = data.facts.length
      ? '<h3 class="memhead">What it knows about you</h3>' +
        data.facts.map((fact) => `<div class="memfact">• ${escapeHtml(fact)}</div>`).join('')
      : '<p class="muted">No facts remembered yet.</p>';
    timelineEl.innerHTML =
      '<h3 class="memhead">Timeline</h3>' +
      (data.recent_turns.length
        ? data.recent_turns.map((turn) => turnCard(turn, base)).join('')
        : '<p class="muted">Nothing seen or said yet.</p>');
  }

  async function load() {
    const id = (device.value || '').trim();
    if (!ID.test(id)) {
      stateEl.textContent = 'enter a band id';
      return;
    }
    localStorage.setItem('memDevice', id);
    stateEl.textContent = 'loading…';
    let reply;
    try {
      reply = await fetch(`${base}/v1/agent/memory?device_id=${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json' },
      });
    } catch {
      stateEl.textContent = 'API unreachable';
      return;
    }
    if (!reply.ok) {
      stateEl.textContent = 'API ' + reply.status;
      return;
    }
    const data = await reply.json();
    render(data);
    stateEl.textContent = `${data.facts.length} facts · ${data.recent_turns.length} turns`;
  }

  refresh.addEventListener('click', load);
  device.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') load();
  });
  auto.addEventListener('change', () => {
    clearInterval(timer);
    timer = null;
    if (auto.checked) {
      load();
      timer = setInterval(load, intervalMs);
    }
  });

  return {
    load,
    setDevice(id) {
      if (ID.test(id || '')) {
        device.value = id;
        localStorage.setItem('memDevice', id);
      }
    },
  };
}
