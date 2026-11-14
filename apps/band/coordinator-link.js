// Direct, low-latency demo link from the band dashboard to the Mac WebSocket
// runtime. The HTTP device API still records every original band event; this
// link maps taps into the coordinator grammar and wrist steps into presentation
// arrow keys for a reliable Mac fallback demo.

export function coordinatorGesture(message) {
  if (message && message.type === 'toggle') return 'grab';
  if (message && message.type === 'select') return 'throw';
  return null;
}

export function coordinatorAction(message) {
  const gesture = coordinatorGesture(message);
  if (gesture) return { type: 'gesture.detected', gesture, confidence: 1 };
  if (message && message.type === 'step' && (message.direction === -1 || message.direction === 1)) {
    return { type: 'mac.key', key: message.direction === 1 ? 'right' : 'left' };
  }
  return null;
}

export function createCoordinatorLink({
  url = 'ws://127.0.0.1:8765',
  Socket = globalThis.WebSocket,
  makeId = () => globalThis.crypto.randomUUID(),
  reconnectMs = 1000,
  schedule = (callback, delay) => setTimeout(callback, delay),
  onChange = () => {},
} = {}) {
  const state = { status: 'idle', sent: 0, dropped: 0, problem: null, url };
  let socket = null;
  let stopped = false;

  function set(changes) {
    Object.assign(state, changes);
    onChange({ ...state });
  }

  function connect() {
    if (stopped || !Socket) return;
    set({ status: 'connecting', problem: null });
    try {
      socket = new Socket(url);
    } catch (error) {
      set({ status: 'unreachable', problem: error.message || 'Could not open the coordinator link.' });
      schedule(connect, reconnectMs);
      return;
    }
    socket.onopen = () => set({ status: 'ready', problem: null });
    socket.onerror = () => set({ status: 'unreachable', problem: 'Mac runtime is not reachable.' });
    socket.onclose = () => {
      socket = null;
      if (!stopped) {
        set({ status: 'unreachable', problem: 'Mac runtime disconnected.' });
        schedule(connect, reconnectMs);
      }
    };
  }

  function send(message) {
    const action = coordinatorAction(message);
    if (!action) return false;
    if (!socket || socket.readyState !== 1) {
      set({ dropped: state.dropped + 1, problem: 'Gesture not sent: Mac runtime is disconnected.' });
      return false;
    }
    socket.send(JSON.stringify({
      version: 1,
      id: makeId(),
      ...action,
    }));
    set({ sent: state.sent + 1, problem: null });
    return true;
  }

  function stop() {
    stopped = true;
    if (socket) socket.close();
    socket = null;
    set({ status: 'idle' });
  }

  connect();
  return { send, stop, state };
}
