const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ConfigStore } = require("../dist/config-store.js");

test("migrates only Broadcaster's legacy YouTube preset to RTMPS", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "broadcaster-config-test-"));
  const destination = (id, url) => ({
    id,
    name: id,
    platform: "youtube",
    url,
    streamKey: "secret",
    enabled: true,
  });
  writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      debugMode: false,
      profiles: [
        {
          id: "default",
          name: "Default",
          port: 1935,
          autoStart: false,
          destinations: [
            destination("legacy", "rtmp://a.rtmp.youtube.com/live2/"),
            destination("custom", "rtmp://custom.youtube.example/live/"),
          ],
        },
      ],
    }),
    "utf8"
  );

  try {
    const destinations = new ConfigStore(dataDir).getProfile("default").destinations;
    assert.equal(destinations[0].url, "rtmps://a.rtmps.youtube.com:443/live2/");
    assert.equal(destinations[1].url, "rtmp://custom.youtube.example/live/");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
