const NodeMediaServer = require("node-media-server");

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid RTMP sink port: ${process.argv[2] ?? "<missing>"}`);
}

const nms = new NodeMediaServer({
  logType: 0,
  rtmp: {
    port,
    chunk_size: 60000,
    gop_cache: false,
    ping: 30,
    ping_timeout: 60,
  },
});

let mediaReported = false;
let mediaTimer = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

nms.on("postPublish", (id, streamPath) => {
  send({ event: "published", streamPath });
  mediaTimer = setInterval(() => {
    const session = nms.getSession(id);
    if (!session || mediaReported) return;
    if (session.videoCodec > 0 && session.audioCodec > 0 && session.socket?.bytesRead > 0) {
      mediaReported = true;
      clearInterval(mediaTimer);
      mediaTimer = null;
      send({
        event: "media",
        streamPath,
        audioCodec: session.audioCodecName,
        videoCodec: session.videoCodecName,
        bytesRead: session.socket.bytesRead,
      });
    }
  }, 100);
});

nms.run();
nms.nrs.tcpServer.once("listening", () => send({ event: "ready", port }));

function stop() {
  if (mediaTimer) clearInterval(mediaTimer);
  try {
    nms.stop();
  } catch {
    // The smoke runner may close the process after the socket is already gone.
  }
  setTimeout(() => process.exit(0), 25);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
