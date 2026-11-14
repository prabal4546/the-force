import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorGesture, createCoordinatorLink } from '../coordinator-link.js';

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen();
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.readyState = 3;
  }
}

test('single tap maps to grab and double-tap maps to throw', () => {
  assert.equal(coordinatorGesture({ type: 'toggle' }), 'grab');
  assert.equal(coordinatorGesture({ type: 'select' }), 'throw');
  assert.equal(coordinatorGesture({ type: 'step', direction: 1 }), null);
  assert.equal(coordinatorGesture({ type: 'command', text: 'grab' }), null);
});

test('the coordinator link sends versioned wire messages only while connected', () => {
  FakeSocket.instances = [];
  const link = createCoordinatorLink({
    Socket: FakeSocket,
    makeId: () => 'event-1',
    schedule: () => {},
  });
  const socket = FakeSocket.instances[0];

  assert.equal(link.send({ type: 'toggle' }), false);
  assert.equal(link.state.dropped, 1);

  socket.open();
  assert.equal(link.send({ type: 'toggle' }), true);
  assert.equal(link.send({ type: 'select' }), true);
  assert.equal(link.send({ type: 'step', direction: 1 }), false);
  assert.deepEqual(socket.sent, [
    { version: 1, id: 'event-1', type: 'gesture.detected', gesture: 'grab', confidence: 1 },
    { version: 1, id: 'event-1', type: 'gesture.detected', gesture: 'throw', confidence: 1 },
  ]);
  assert.equal(link.state.sent, 2);
});
