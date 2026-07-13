const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const TIMEOUT_MS = 30_000;

function parseArgs() {
  const values = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    const value = process.argv[i + 1];
    if (!name?.startsWith("--") || !value) throw new Error(`Invalid argument: ${name}`);
    values.set(name.slice(2), path.resolve(value));
  }
  const sidecar = values.get("sidecar");
  const ffmpeg = values.get("ffmpeg");
  if (!sidecar || !ffmpeg) {
    throw new Error("Usage: node test/relay-smoke.cjs --sidecar <path> --ffmpeg <path>");
  }
  return { sidecar, ffmpeg };
}

function messageStream(child, name) {
  const messages = [];
  const waiters = new Set();
  const stderr = [];
  const stdout = readline.createInterface({ input: child.stdout });

  stdout.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stderr.push(`[stdout] ${line}`);
      return;
    }
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8").trim()));

  return {
    waitFor(predicate, label) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(
            new Error(
              `${name} timed out waiting for ${label}. Messages: ${JSON.stringify(messages)} ` +
                `stderr: ${stderr.join(" | ")}`
            )
          );
        }, TIMEOUT_MS);
        waiters.add(waiter);
      });
    },
    close() {
      stdout.close();
      for (const waiter of waiters) clearTimeout(waiter.timer);
      waiters.clear();
    },
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Process already exited.
  }
}

async function runMode({ sidecar, ffmpeg }, useFfmpeg) {
  const mode = useFfmpeg ? "ffmpeg" : "native";
  const ingestPort = await freePort();
  let sinkPort = await freePort();
  while (sinkPort === ingestPort) sinkPort = await freePort();

  const tempDir = mkdtempSync(path.join(os.tmpdir(), `broadcaster-${mode}-`));
  const profileId = `smoke-${mode}`;
  const streamKey = `destination-${mode}`;
  const config = {
    debugMode: true,
    profiles: [
      {
        id: profileId,
        name: `Smoke ${mode}`,
        port: ingestPort,
        autoStart: false,
        destinations: [
          {
            id: `destination-${mode}`,
            name: `Local ${mode} sink`,
            platform: "custom",
            url: `rtmp://127.0.0.1:${sinkPort}/live/`,
            streamKey,
            enabled: true,
            useFfmpeg,
          },
        ],
      },
    ],
  };
  writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(config), "utf8");

  let sink;
  let sidecarProcess;
  let publisher;
  let sinkMessages;
  let sidecarMessages;
  try {
    sink = spawn(process.execPath, [path.join(__dirname, "rtmp-sink.cjs"), String(sinkPort)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    sinkMessages = messageStream(sink, `${mode} sink`);
    await sinkMessages.waitFor((event) => event.event === "ready", "ready");

    sidecarProcess = spawn(sidecar, ["--data-dir", tempDir], {
      env: { ...process.env, BROADCASTER_FFMPEG_PATH: ffmpeg },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    sidecarMessages = messageStream(sidecarProcess, `${mode} sidecar`);
    await sidecarMessages.waitFor((event) => event.event === "ready", "ready");

    sidecarProcess.stdin.write(`${JSON.stringify({ cmd: "start_server", profileId })}\n`);
    await sidecarMessages.waitFor(
      (event) => event.event === "server_started" && event.profileId === profileId,
      "server_started"
    );

    publisher = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x180:rate=15",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=44100",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "30",
        "-c:a",
        "aac",
        "-f",
        "flv",
        `rtmp://127.0.0.1:${ingestPort}/live/source-${mode}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
    );

    await sidecarMessages.waitFor(
      (event) => event.event === "stream_connected" && event.profileId === profileId,
      "stream_connected"
    );
    sidecarProcess.stdin.write(`${JSON.stringify({ cmd: "push_destinations", profileId })}\n`);

    await sidecarMessages.waitFor(
      (event) => event.event === "relay_started" && event.profileId === profileId,
      "relay_started"
    );
    const media = await sinkMessages.waitFor(
      (event) => event.event === "media" && event.streamPath === `/live/${streamKey}`,
      "audio and video media"
    );
    assert(media.bytesRead > 0);
    process.stdout.write(
      `PASS ${mode}: ${media.videoCodec}/${media.audioCodec}, ${media.bytesRead} bytes received\n`
    );
  } finally {
    if (sidecarProcess?.stdin.writable) {
      sidecarProcess.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
    }
    stopProcess(publisher);
    stopProcess(sidecarProcess);
    stopProcess(sink);
    sinkMessages?.close();
    sidecarMessages?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const binaries = parseArgs();
  await runMode(binaries, false);
  await runMode(binaries, true);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
