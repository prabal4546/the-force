// The link from the band module to the team's device API (the-force, branch codex/api,
// docs/api.md). The band module makes messages; this checks each one against the API's
// contract and posts it. No band and no page in here: `post` is handed in, so it can be tested.
//
// The contract, for a band:
//   POST /v1/devices/connect            { device_id, device_type: 'band', hardware_status }
//   POST /v1/band/events?device_id=ID   one of the bodies below, with an Idempotency-Key header
//     { type: 'adjust', delta }         a finite number from -1 to 1
//     { type: 'step', direction }       the integer -1 or 1
//     { type: 'toggle' }                nothing else
//     { type: 'select' }                nothing else
//     { type: 'command', text }         not blank, at most 4000 characters
// The API answers 202 for an event it kept. It forgets its devices when it restarts and then
// answers 404: register again and send the same event again, under the same key.

export const HUB = {
  maxTextLength: 4000,      // the contract's limit for a command
  maxAgeMs: 3000,           // an event that could not be sent for this long is dropped: a late step is worse than none
  retryMs: [300, 1000],     // waits before trying an event again when the API does not answer
  maxQueue: 100,            // events waiting at once; beyond it the oldest go
};

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const FIELDS = { adjust: ['delta'], step: ['direction'], toggle: [], select: [], command: ['text'] };

/** The device ID for a band number: "vexo-28". */
export function bandDeviceId(number) {
  return 'vexo-' + number;
}

/**
 * Does a message fit the band event contract? Returns null when it does, or a sentence
 * saying what is wrong. The API is strict: no extra fields, no "1" for 1.
 */
export function contractProblem(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return 'not an object';
  const fields = FIELDS[message.type];
  if (!fields) return `"${message.type}" is not a band event (adjust, step, toggle, select, command)`;
  const extra = Object.keys(message).filter((key) => key !== 'type' && !fields.includes(key));
  if (extra.length) return `${message.type} may not carry "${extra[0]}"`;
  if (message.type === 'adjust' && !(typeof message.delta === 'number' && Number.isFinite(message.delta) && Math.abs(message.delta) <= 1)) {
    return 'adjust needs a delta from -1 to 1';
  }
  if (message.type === 'step' && message.direction !== 1 && message.direction !== -1) return 'step needs the direction -1 or 1';
  if (message.type === 'command') {
    if (typeof message.text !== 'string' || message.text.trim() === '') return 'command needs text that is not blank';
    if (message.text.length > HUB.maxTextLength) return `command text is longer than ${HUB.maxTextLength} characters`;
  }
  return null;
}

/**
 * The link.
 *   post(path, body, headers)  sends one request, resolves with { status, body } (body: the
 *                              parsed JSON or null), or rejects when nothing answered
 *   deviceId                   as registered with the API, e.g. "vexo-28"
 *   now, wait                  the clock and a pause, for tests
 *   onChange                   called whenever `state` changed
 *
 *   register(hardwareStatus)   tell the API the band is 'connected' or 'disconnected'
 *   send(message)              check and post one band event; false if it did not fit the contract
 *   state                      { status, accepted, dropped, queued, problem }
 *                              status: 'idle' (nothing tried yet), 'ready', 'unreachable' (no
 *                              answer), 'refused' (the API said no: see problem)
 */
export function createHubLink({ post, deviceId, now = () => Date.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)), onChange = () => {}, config = HUB }) {
  if (!ID.test(deviceId)) throw new Error('A device ID holds letters, numbers, _ and - only, at most 128: got ' + deviceId);
  const session = Math.random().toString(36).slice(2, 10);       // makes this page's keys its own
  const queue = [];
  const state = { status: 'idle', accepted: 0, dropped: 0, queued: 0, problem: null, deviceId };
  let count = 0;
  let draining = false;
  let hardware = 'unknown';

  function set(changes) {
    Object.assign(state, changes, { queued: queue.length });
    onChange(state);
  }

  const detail = (reply) => {
    const d = reply.body && reply.body.detail;
    return typeof d === 'string' ? d : d ? JSON.stringify(d) : 'status ' + reply.status;
  };

  /** Tell the API about the band. Resolves true when it is registered. */
  async function register(hardwareStatus = hardware) {
    hardware = hardwareStatus;
    let reply;
    try {
      reply = await post('/v1/devices/connect', { device_id: deviceId, device_type: 'band', hardware_status: hardware }, {});
    } catch {
      set({ status: 'unreachable', problem: 'The device API did not answer.' });
      return false;
    }
    if (reply.status === 200) { set({ status: 'ready', problem: null }); return true; }
    set({
      status: reply.status >= 500 ? 'unreachable' : 'refused',
      problem: reply.status === 401 ? 'The device API wants the session token (BODYOS_SESSION_TOKEN).'
        : reply.status === 409 ? `"${deviceId}" is registered there as another kind of device.`
          : 'Registering failed: ' + detail(reply),
    });
    return false;
  }

  /** Post one queued event. Resolves 'sent', 'dropped' or 'later' (try again after a wait). */
  async function deliver(item) {
    let reply;
    try {
      reply = await post('/v1/band/events?device_id=' + encodeURIComponent(deviceId), item.message, { 'Idempotency-Key': item.key });
    } catch {
      set({ status: 'unreachable', problem: 'The device API did not answer.' });
      return 'later';
    }
    if (reply.status === 202) { set({ status: 'ready', problem: null, accepted: state.accepted + 1 }); return 'sent'; }
    if (reply.status === 404 && !item.registered) {              // the API restarted and forgot the band
      item.registered = true;
      return (await register()) ? deliver(item) : 'later';
    }
    if (reply.status >= 500) { set({ status: 'unreachable', problem: 'The device API failed: ' + detail(reply) }); return 'later'; }
    set({
      status: 'refused',
      problem: reply.status === 401 ? 'The device API wants the session token (BODYOS_SESSION_TOKEN).'
        : reply.status === 422 ? 'The device API did not accept ' + JSON.stringify(item.message) + ': ' + detail(reply)
          : 'The device API answered ' + detail(reply),
    });
    return 'dropped';
  }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const item = queue[0];
      let result = 'dropped';
      if (now() - item.at <= config.maxAgeMs) {
        result = await deliver(item);
        if (result === 'later' && item.tries < config.retryMs.length) {
          await wait(config.retryMs[item.tries]);
          item.tries += 1;
          continue;                                              // the same event, the same key
        }
      }
      queue.shift();
      if (result !== 'sent') set({ dropped: state.dropped + 1 }); else set({});
    }
    draining = false;
  }

  function send(message) {
    const problem = contractProblem(message);
    if (problem) {
      set({ dropped: state.dropped + 1, problem: 'Not sent, it does not fit the contract: ' + problem });
      return false;
    }
    count += 1;
    queue.push({ message: { ...message }, key: `${deviceId}-${session}-${count}`, at: now(), tries: 0, registered: false });
    while (queue.length > config.maxQueue) { queue.splice(draining ? 1 : 0, 1); state.dropped += 1; }
    set({});
    drain();
    return true;
  }

  return { register, send, state };
}

/** `post` for a page: through serve.py's /hub, which adds the session token and reaches the API. */
export function hubPost(base = '/hub') {
  return async (path, body, headers) => {
    const reply = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    let parsed = null;
    try { parsed = await reply.json(); } catch { /* no body, or not JSON */ }
    return { status: reply.status, body: parsed };
  };
}
