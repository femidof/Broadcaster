const assert = require("node:assert/strict");
const test = require("node:test");

const { parseRtmpUrl } = require("../dist/rtmp-relay.js");

test("preserves RTMPS in the connect tcUrl and defaults to port 443", () => {
  assert.deepEqual(parseRtmpUrl("rtmps://live.example.com/app/stream-key"), {
    hostname: "live.example.com",
    port: 443,
    app: "app",
    stream: "stream-key",
    tcurl: "rtmps://live.example.com:443/app",
    isSecure: true,
  });
});

test("keeps plain RTMP connect metadata on port 1935", () => {
  assert.deepEqual(parseRtmpUrl("rtmp://live.example.com/live/stream-key"), {
    hostname: "live.example.com",
    port: 1935,
    app: "live",
    stream: "stream-key",
    tcurl: "rtmp://live.example.com:1935/live",
    isSecure: false,
  });
});

test("rejects destination URLs outside RTMP and RTMPS", () => {
  assert.throws(() => parseRtmpUrl("https://live.example.com/app/key"), {
    message: "Unsupported RTMP protocol: https:",
  });
});
