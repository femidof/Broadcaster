const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const nmsModulePath = require.resolve("node-media-server");

class FakeTcpServer {
  closeCalls = 0;

  close() {
    this.closeCalls++;
  }

  on() {}
}

class FakeNodeMediaServer {
  static events = new EventEmitter();
  static instances = [];
  static sessions = new Map();
  static stopCalls = 0;

  constructor() {
    this.nrs = { tcpServer: new FakeTcpServer() };
    FakeNodeMediaServer.instances.push(this);
  }

  run() {}

  stop() {
    FakeNodeMediaServer.stopCalls++;
  }

  on(event, callback) {
    FakeNodeMediaServer.events.on(event, callback);
  }

  getSession(id) {
    return FakeNodeMediaServer.sessions.get(id);
  }

  static connect(id, port, streamPath) {
    FakeNodeMediaServer.sessions.set(id, { socket: { localPort: port } });
    FakeNodeMediaServer.events.emit("preConnect", id, { app: "live" });
    FakeNodeMediaServer.events.emit("prePublish", id, streamPath);
  }

  static disconnect(id, streamPath) {
    FakeNodeMediaServer.events.emit("donePublish", id, streamPath);
    FakeNodeMediaServer.events.emit("doneConnect", id, { app: "live" });
    FakeNodeMediaServer.sessions.delete(id);
  }
}

require.cache[nmsModulePath] = {
  id: nmsModulePath,
  filename: nmsModulePath,
  loaded: true,
  exports: FakeNodeMediaServer,
};

const { RtmpServer } = require("../dist/rtmp-server.js");

test("isolates stream events and shutdown by profile ingest port", () => {
  const eventsA = [];
  const eventsB = [];
  const serverA = new RtmpServer(19441, {
    onStreamConnect: (key) => eventsA.push(`connect:${key}`),
    onStreamDisconnect: (key) => eventsA.push(`disconnect:${key}`),
  });
  const serverB = new RtmpServer(19442, {
    onStreamConnect: (key) => eventsB.push(`connect:${key}`),
    onStreamDisconnect: (key) => eventsB.push(`disconnect:${key}`),
  });

  serverA.start();
  serverB.start();

  FakeNodeMediaServer.connect("a", 19441, "/live/profile-a");
  assert.deepEqual(eventsA, ["connect:profile-a"]);
  assert.deepEqual(eventsB, []);
  assert.equal(serverA.hasActiveStream(), true);
  assert.equal(serverB.hasActiveStream(), false);

  serverA.stop();
  assert.equal(FakeNodeMediaServer.stopCalls, 0);
  assert.equal(FakeNodeMediaServer.instances[0].nrs.tcpServer.closeCalls, 1);
  assert.equal(serverB.isRunning(), true);

  FakeNodeMediaServer.connect("b", 19442, "/live/profile-b");
  assert.deepEqual(eventsB, ["connect:profile-b"]);
  FakeNodeMediaServer.disconnect("b", "/live/profile-b");
  assert.deepEqual(eventsB, ["connect:profile-b", "disconnect:profile-b"]);

  serverB.stop();
});

test("rejects two running profiles configured with the same ingest port", () => {
  const callbacks = {
    onStreamConnect() {},
    onStreamDisconnect() {},
  };
  const first = new RtmpServer(19443, callbacks);
  const second = new RtmpServer(19443, callbacks);

  first.start();
  assert.throws(
    () => second.start(),
    /RTMP ingest port 19443 is already in use by another profile/
  );
  first.stop();
});

test("ignores delayed disconnect events from a previous server generation", () => {
  const oldEvents = [];
  const newEvents = [];
  const oldServer = new RtmpServer(19444, {
    onStreamConnect: (key) => oldEvents.push(`connect:${key}`),
    onStreamDisconnect: (key) => oldEvents.push(`disconnect:${key}`),
  });

  oldServer.start();
  FakeNodeMediaServer.connect("old", 19444, "/live/shared-key");
  oldServer.stop();

  const newServer = new RtmpServer(19444, {
    onStreamConnect: (key) => newEvents.push(`connect:${key}`),
    onStreamDisconnect: (key) => newEvents.push(`disconnect:${key}`),
  });
  newServer.start();
  FakeNodeMediaServer.connect("new", 19444, "/live/shared-key");

  FakeNodeMediaServer.disconnect("old", "/live/shared-key");
  assert.deepEqual(oldEvents, ["connect:shared-key"]);
  assert.deepEqual(newEvents, ["connect:shared-key"]);
  assert.equal(newServer.hasActiveStream(), true);

  FakeNodeMediaServer.disconnect("new", "/live/shared-key");
  assert.deepEqual(newEvents, ["connect:shared-key", "disconnect:shared-key"]);
  newServer.stop();
});
