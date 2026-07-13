import { EventEmitter } from "events";
import * as net from "net";
import * as tls from "tls";
import * as crypto from "crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AMF = require("node-media-server/src/node_core_amf");

const FLASHVER = "FMLE/3.0 (compatible; FMSc/1.0)";

const RTMP_HANDSHAKE_SIZE = 1536;
const RTMP_HANDSHAKE_UNINIT = 0;
const RTMP_HANDSHAKE_0 = 1;
const RTMP_HANDSHAKE_1 = 2;
const RTMP_HANDSHAKE_2 = 3;

const RTMP_PARSE_INIT = 0;
const RTMP_PARSE_BASIC_HEADER = 1;
const RTMP_PARSE_MESSAGE_HEADER = 2;
const RTMP_PARSE_EXTENDED_TIMESTAMP = 3;
const RTMP_PARSE_PAYLOAD = 4;

const RTMP_CHUNK_HEADER_MAX = 18;
const RTMP_CHUNK_TYPE_0 = 0;
const RTMP_CHUNK_TYPE_3 = 3;

const RTMP_CHANNEL_PROTOCOL = 2;
const RTMP_CHANNEL_INVOKE = 3;
const RTMP_CHANNEL_AUDIO = 4;
const RTMP_CHANNEL_VIDEO = 5;
const RTMP_CHANNEL_DATA = 6;

const rtmpHeaderSize = [11, 7, 3, 0];

const RTMP_TYPE_SET_CHUNK_SIZE = 1;
const RTMP_TYPE_ABORT = 2;
const RTMP_TYPE_ACKNOWLEDGEMENT = 3;
const RTMP_TYPE_WINDOW_ACKNOWLEDGEMENT_SIZE = 5;
const RTMP_TYPE_SET_PEER_BANDWIDTH = 6;
const RTMP_TYPE_EVENT = 4;
const RTMP_TYPE_AUDIO = 8;
const RTMP_TYPE_VIDEO = 9;
const RTMP_TYPE_FLEX_STREAM = 15;
const RTMP_TYPE_DATA = 18;
const RTMP_TYPE_FLEX_MESSAGE = 17;
const RTMP_TYPE_INVOKE = 20;

const RTMP_CHUNK_SIZE = 128;
const RTMP_PORT = 1935;
const RTMPS_PORT = 443;

const RTMP_TRANSACTION_CONNECT = 1;
const RTMP_TRANSACTION_CREATE_STREAM = 2;

interface RtmpPacketHeader {
  fmt: number;
  cid: number;
  timestamp: number;
  length: number;
  type: number;
  stream_id: number;
}

interface RtmpPacket {
  header: RtmpPacketHeader;
  clock: number;
  delta: number;
  payload: Buffer | null;
  capacity: number;
  bytes: number;
}

function createPacket(fmt = 0, cid = 0): RtmpPacket {
  return {
    header: { fmt, cid, timestamp: 0, length: 0, type: 0, stream_id: 0 },
    clock: 0,
    delta: 0,
    payload: null,
    capacity: 0,
    bytes: 0,
  };
}

interface UrlInfo {
  hostname: string;
  port: number;
  app: string;
  stream: string;
  tcurl: string;
  isSecure: boolean;
}

export function parseRtmpUrl(rtmpUrl: string): UrlInfo {
  const parsed = new URL(rtmpUrl);
  if (parsed.protocol !== "rtmp:" && parsed.protocol !== "rtmps:") {
    throw new Error(`Unsupported RTMP protocol: ${parsed.protocol}`);
  }
  const pathname = parsed.pathname || "/";
  const parts = pathname.split("/").filter(Boolean);
  const app = parts[0] ?? "";
  const stream = parts.slice(1).join("/");
  const isSecure = parsed.protocol === "rtmps:";
  const defaultPort = isSecure ? RTMPS_PORT : RTMP_PORT;
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  const hostname = parsed.hostname || "localhost";
  const scheme = isSecure ? "rtmps" : "rtmp";
  const tcurl = `${scheme}://${hostname}:${port}/${app}`;

  return { hostname, port, app, stream, tcurl, isSecure };
}

class RtmpClient extends EventEmitter {
  private url: string;
  private info: UrlInfo;
  private isPublish: boolean;
  private socket: net.Socket | tls.TLSSocket | null = null;
  private handshakePayload: Buffer | null = Buffer.alloc(RTMP_HANDSHAKE_SIZE);
  private handshakeState = RTMP_HANDSHAKE_UNINIT;
  private handshakeBytes = 0;
  private parserBuffer = Buffer.alloc(RTMP_CHUNK_HEADER_MAX);
  private parserState = RTMP_PARSE_INIT;
  private parserBytes = 0;
  private parserBasicBytes = 0;
  private parserPacket: RtmpPacket | null = null;
  private inPackets = new Map<number, RtmpPacket>();
  private inChunkSize = RTMP_CHUNK_SIZE;
  private outChunkSize = RTMP_CHUNK_SIZE;
  private streamId = 0;
  private _connected = false;

  constructor(rtmpUrl: string, publish: boolean) {
    super();
    this.url = rtmpUrl;
    this.info = parseRtmpUrl(rtmpUrl);
    this.isPublish = publish;
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    const onConnect = () => {
      const c0c1 = crypto.randomBytes(1537);
      c0c1.writeUInt8(3);
      c0c1.writeUInt32BE(Math.floor(Date.now() / 1000), 1);
      c0c1.writeUInt32BE(0, 5);
      this.socket!.write(c0c1);
    };

    if (this.info.isSecure) {
      this.socket = tls.connect(
        {
          host: this.info.hostname,
          port: this.info.port,
          servername: this.info.hostname,
          rejectUnauthorized: true,
        },
        onConnect
      );
    } else {
      this.socket = net.createConnection(this.info.port, this.info.hostname, onConnect);
    }

    this.socket.on("data", (data: Buffer) => this.onSocketData(data));
    this.socket.on("error", (err: Error) => this.onSocketError(err));
    this.socket.on("close", () => this.onSocketClose());
    this.socket.on("timeout", () => this.onSocketTimeout());
    this.socket.setTimeout(0);
  }

  stop(): void {
    if (this.socket && !this.socket.destroyed) {
      if (this.streamId > 0 && this.isPublish) {
        this.sendInvokeMessage(this.streamId, {
          cmd: "FCUnpublish", transId: 0, cmdObj: null,
          streamName: this.info.stream,
        });
        this.sendInvokeMessage(this.streamId, {
          cmd: "deleteStream", transId: 0, cmdObj: null,
          streamId: this.streamId,
        });
      }
      this.socket.destroy();
    }
    this.socket = null;
    this.streamId = 0;
    this._connected = false;
  }

  pushAudio(audioData: Buffer, timestamp: number): void {
    if (this.streamId === 0 || !this.socket || this.socket.destroyed) return;
    const packet = createPacket();
    packet.header.fmt = RTMP_CHUNK_TYPE_0;
    packet.header.cid = RTMP_CHANNEL_AUDIO;
    packet.header.type = RTMP_TYPE_AUDIO;
    packet.payload = audioData;
    packet.header.length = audioData.length;
    packet.header.timestamp = timestamp;
    this.socket.write(this.rtmpChunksCreate(packet));
  }

  pushVideo(videoData: Buffer, timestamp: number): void {
    if (this.streamId === 0 || !this.socket || this.socket.destroyed) return;
    const packet = createPacket();
    packet.header.fmt = RTMP_CHUNK_TYPE_0;
    packet.header.cid = RTMP_CHANNEL_VIDEO;
    packet.header.type = RTMP_TYPE_VIDEO;
    packet.payload = videoData;
    packet.header.length = videoData.length;
    packet.header.timestamp = timestamp;
    this.socket.write(this.rtmpChunksCreate(packet));
  }

  pushScript(scriptData: Buffer, timestamp: number): void {
    if (this.streamId === 0 || !this.socket || this.socket.destroyed) return;
    const packet = createPacket();
    packet.header.fmt = RTMP_CHUNK_TYPE_0;
    packet.header.cid = RTMP_CHANNEL_DATA;
    packet.header.type = RTMP_TYPE_DATA;
    packet.payload = scriptData;
    packet.header.length = scriptData.length;
    packet.header.timestamp = timestamp;
    this.socket.write(this.rtmpChunksCreate(packet));
  }

  private onSocketData(data: Buffer): void {
    let bytes = data.length;
    let p = 0;
    let n: number;
    while (bytes > 0) {
      switch (this.handshakeState) {
        case RTMP_HANDSHAKE_UNINIT:
          this.handshakeState = RTMP_HANDSHAKE_0;
          this.handshakeBytes = 0;
          bytes -= 1;
          p += 1;
          break;
        case RTMP_HANDSHAKE_0:
          n = RTMP_HANDSHAKE_SIZE - this.handshakeBytes;
          n = n <= bytes ? n : bytes;
          data.copy(this.handshakePayload!, this.handshakeBytes, p, p + n);
          this.handshakeBytes += n;
          bytes -= n;
          p += n;
          if (this.handshakeBytes === RTMP_HANDSHAKE_SIZE) {
            this.handshakeState = RTMP_HANDSHAKE_1;
            this.handshakeBytes = 0;
            this.socket!.write(this.handshakePayload!);
          }
          break;
        case RTMP_HANDSHAKE_1:
          n = RTMP_HANDSHAKE_SIZE - this.handshakeBytes;
          n = n <= bytes ? n : bytes;
          this.handshakePayload!.set(data.subarray(p, p + n), this.handshakeBytes);
          this.handshakeBytes += n;
          bytes -= n;
          p += n;
          if (this.handshakeBytes === RTMP_HANDSHAKE_SIZE) {
            this.handshakeState = RTMP_HANDSHAKE_2;
            this.handshakeBytes = 0;
            this.handshakePayload = null;
            this.rtmpSendConnect();
          }
          break;
        case RTMP_HANDSHAKE_2:
          this.rtmpChunkRead(data, p, bytes);
          return;
      }
    }
  }

  private onSocketError(err: Error): void {
    this._connected = false;
    this.emit("error", err);
  }

  private onSocketClose(): void {
    this._connected = false;
    this.streamId = 0;
    this.emit("close");
  }

  private onSocketTimeout(): void {
    this._connected = false;
    this.stop();
    this.emit("close");
  }

  private rtmpSendConnect(): void {
    this.sendInvokeMessage(0, {
      cmd: "connect",
      transId: RTMP_TRANSACTION_CONNECT,
      cmdObj: {
        app: this.info.app,
        flashVer: FLASHVER,
        tcUrl: this.info.tcurl,
        fpad: 0,
        capabilities: 15,
        audioCodecs: 4071,
        videoCodecs: 252,
        videoFunction: 1,
        encoding: 0,
      },
    });
  }

  private rtmpOnConnect(): void {
    if (this.isPublish) {
      this.sendInvokeMessage(0, {
        cmd: "releaseStream", transId: 0, cmdObj: null,
        streamName: this.info.stream,
      });
      this.sendInvokeMessage(0, {
        cmd: "FCPublish", transId: 0, cmdObj: null,
        streamName: this.info.stream,
      });
    }
    this.sendInvokeMessage(0, {
      cmd: "createStream",
      transId: RTMP_TRANSACTION_CREATE_STREAM,
      cmdObj: null,
    });
  }

  private rtmpOnCreateStream(sid: number): void {
    this.streamId = sid;
    if (this.isPublish) {
      this.sendInvokeMessage(this.streamId, {
        cmd: "publish", transId: 0, cmdObj: null,
        streamName: this.info.stream, type: "live",
      });
      this.rtmpSendSetChunkSize();
      // Don't emit status here — wait for the server's onStatus acknowledgement
      // in rtmpHandler(). Emitting prematurely causes data to flow before the
      // remote server (e.g. Facebook RTMPS) has confirmed the publish.
    } else {
      this.sendInvokeMessage(this.streamId, {
        cmd: "play", transId: 0, cmdObj: null,
        streamName: this.info.stream, start: -2, duration: -1, reset: 1,
      });
      this.rtmpSendSetBufferLength(1000);
      // Same here — let the server confirm play before signalling readiness.
    }
  }

  private rtmpSendSetChunkSize(): void {
    const outChunk = 60000;
    const rtmpBuffer = Buffer.from("02000000000004010000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(outChunk, 12);
    this.socket!.write(rtmpBuffer);
    this.outChunkSize = outChunk;
  }

  private rtmpSendSetBufferLength(bufferTime: number): void {
    const packet = createPacket();
    packet.header.fmt = RTMP_CHUNK_TYPE_0;
    packet.header.cid = RTMP_CHANNEL_PROTOCOL;
    packet.header.type = RTMP_TYPE_EVENT;
    packet.payload = Buffer.alloc(10);
    packet.header.length = 10;
    packet.payload.writeUInt16BE(0x03);
    packet.payload.writeUInt32BE(this.streamId, 2);
    packet.payload.writeUInt32BE(bufferTime, 6);
    this.socket!.write(this.rtmpChunksCreate(packet));
  }

  private rtmpSendPingResponse(time: number): void {
    const packet = createPacket();
    packet.header.fmt = RTMP_CHUNK_TYPE_0;
    packet.header.cid = RTMP_CHANNEL_PROTOCOL;
    packet.header.type = RTMP_TYPE_EVENT;
    packet.payload = Buffer.alloc(6);
    packet.header.length = 6;
    packet.payload.writeUInt16BE(0x07);
    packet.payload.writeUInt32BE(time, 2);
    this.socket!.write(this.rtmpChunksCreate(packet));
  }

  private sendInvokeMessage(sid: number, opt: Record<string, unknown>): void {
    const packet = createPacket();
    packet.header.fmt = RTMP_CHUNK_TYPE_0;
    packet.header.cid = RTMP_CHANNEL_INVOKE;
    packet.header.type = RTMP_TYPE_INVOKE;
    packet.header.stream_id = sid;
    packet.payload = AMF.encodeAmf0Cmd(opt);
    packet.header.length = packet.payload!.length;
    this.socket!.write(this.rtmpChunksCreate(packet));
  }

  private rtmpChunkBasicHeaderCreate(fmt: number, cid: number): Buffer {
    if (cid >= 64 + 255) {
      const out = Buffer.alloc(3);
      out[0] = (fmt << 6) | 1;
      out[1] = (cid - 64) & 0xff;
      out[2] = ((cid - 64) >> 8) & 0xff;
      return out;
    } else if (cid >= 64) {
      const out = Buffer.alloc(2);
      out[0] = (fmt << 6) | 0;
      out[1] = (cid - 64) & 0xff;
      return out;
    } else {
      const out = Buffer.alloc(1);
      out[0] = (fmt << 6) | cid;
      return out;
    }
  }

  private rtmpChunkMessageHeaderCreate(header: RtmpPacketHeader): Buffer {
    const out = Buffer.alloc(rtmpHeaderSize[header.fmt % 4]);
    if (header.fmt <= 2) {
      out.writeUIntBE(header.timestamp >= 0xffffff ? 0xffffff : header.timestamp, 0, 3);
    }
    if (header.fmt <= 1) {
      out.writeUIntBE(header.length, 3, 3);
      out.writeUInt8(header.type, 6);
    }
    if (header.fmt === RTMP_CHUNK_TYPE_0) {
      out.writeUInt32LE(header.stream_id, 7);
    }
    return out;
  }

  private rtmpChunksCreate(packet: RtmpPacket): Buffer {
    const header = packet.header;
    const payload = packet.payload!;
    let payloadSize = header.length;
    const chunkSize = this.outChunkSize;
    let chunksOffset = 0;
    let payloadOffset = 0;

    const chunkBasicHeader = this.rtmpChunkBasicHeaderCreate(header.fmt, header.cid);
    const chunkBasicHeader3 = this.rtmpChunkBasicHeaderCreate(RTMP_CHUNK_TYPE_3, header.cid);
    const chunkMessageHeader = this.rtmpChunkMessageHeaderCreate(header);
    const useExtendedTimestamp = header.timestamp >= 0xffffff;
    const headerSize = chunkBasicHeader.length + chunkMessageHeader.length + (useExtendedTimestamp ? 4 : 0);

    let n = headerSize + payloadSize + Math.floor(payloadSize / chunkSize);
    if (useExtendedTimestamp) {
      n += Math.floor(payloadSize / chunkSize) * 4;
    }
    if (payloadSize > 0 && payloadSize % chunkSize === 0) {
      n -= 1;
      if (useExtendedTimestamp) n -= 4;
    }

    const chunks = Buffer.alloc(n);
    chunkBasicHeader.copy(chunks, chunksOffset);
    chunksOffset += chunkBasicHeader.length;
    chunkMessageHeader.copy(chunks, chunksOffset);
    chunksOffset += chunkMessageHeader.length;
    if (useExtendedTimestamp) {
      chunks.writeUInt32BE(header.timestamp, chunksOffset);
      chunksOffset += 4;
    }
    while (payloadSize > 0) {
      if (payloadSize > chunkSize) {
        payload.copy(chunks, chunksOffset, payloadOffset, payloadOffset + chunkSize);
        payloadSize -= chunkSize;
        chunksOffset += chunkSize;
        payloadOffset += chunkSize;
        chunkBasicHeader3.copy(chunks, chunksOffset);
        chunksOffset += chunkBasicHeader3.length;
        if (useExtendedTimestamp) {
          chunks.writeUInt32BE(header.timestamp, chunksOffset);
          chunksOffset += 4;
        }
      } else {
        payload.copy(chunks, chunksOffset, payloadOffset, payloadOffset + payloadSize);
        chunksOffset += payloadSize;
        payloadOffset += payloadSize;
        payloadSize = 0;
      }
    }
    return chunks;
  }

  private rtmpChunkRead(data: Buffer, p: number, bytes: number): void {
    let size: number;
    let offset = 0;
    let extended_timestamp = 0;

    while (offset < bytes) {
      switch (this.parserState) {
        case RTMP_PARSE_INIT:
          this.parserBytes = 1;
          this.parserBuffer[0] = data[p + offset++];
          if ((this.parserBuffer[0] & 0x3f) === 0) {
            this.parserBasicBytes = 2;
          } else if ((this.parserBuffer[0] & 0x3f) === 1) {
            this.parserBasicBytes = 3;
          } else {
            this.parserBasicBytes = 1;
          }
          this.parserState = RTMP_PARSE_BASIC_HEADER;
          break;
        case RTMP_PARSE_BASIC_HEADER:
          while (this.parserBytes < this.parserBasicBytes && offset < bytes) {
            this.parserBuffer[this.parserBytes++] = data[p + offset++];
          }
          if (this.parserBytes >= this.parserBasicBytes) {
            this.parserState = RTMP_PARSE_MESSAGE_HEADER;
          }
          break;
        case RTMP_PARSE_MESSAGE_HEADER:
          size = rtmpHeaderSize[this.parserBuffer[0] >> 6] + this.parserBasicBytes;
          while (this.parserBytes < size && offset < bytes) {
            this.parserBuffer[this.parserBytes++] = data[p + offset++];
          }
          if (this.parserBytes >= size) {
            this.rtmpPacketParse();
            this.parserState = RTMP_PARSE_EXTENDED_TIMESTAMP;
          }
          break;
        case RTMP_PARSE_EXTENDED_TIMESTAMP:
          size = rtmpHeaderSize[this.parserPacket!.header.fmt] + this.parserBasicBytes;
          if (this.parserPacket!.header.timestamp === 0xffffff) size += 4;
          while (this.parserBytes < size && offset < bytes) {
            this.parserBuffer[this.parserBytes++] = data[p + offset++];
          }
          if (this.parserBytes >= size) {
            if (this.parserPacket!.header.timestamp === 0xffffff) {
              extended_timestamp = this.parserBuffer.readUInt32BE(
                rtmpHeaderSize[this.parserPacket!.header.fmt] + this.parserBasicBytes
              );
            }
            if (this.parserPacket!.bytes === 0) {
              if (this.parserPacket!.header.fmt === RTMP_CHUNK_TYPE_0) {
                this.parserPacket!.clock =
                  this.parserPacket!.header.timestamp === 0xffffff
                    ? extended_timestamp
                    : this.parserPacket!.header.timestamp;
                this.parserPacket!.delta = 0;
              } else {
                this.parserPacket!.delta =
                  this.parserPacket!.header.timestamp === 0xffffff
                    ? extended_timestamp
                    : this.parserPacket!.header.timestamp;
              }
              this.rtmpPacketAlloc();
            }
            this.parserState = RTMP_PARSE_PAYLOAD;
          }
          break;
        case RTMP_PARSE_PAYLOAD:
          size = Math.min(
            this.inChunkSize - (this.parserPacket!.bytes % this.inChunkSize),
            this.parserPacket!.header.length - this.parserPacket!.bytes
          );
          size = Math.min(size, bytes - offset);
          if (size > 0) {
            data.copy(this.parserPacket!.payload!, this.parserPacket!.bytes, p + offset, p + offset + size);
          }
          this.parserPacket!.bytes += size;
          offset += size;
          if (this.parserPacket!.bytes >= this.parserPacket!.header.length) {
            this.parserState = RTMP_PARSE_INIT;
            this.parserPacket!.bytes = 0;
            this.parserPacket!.clock += this.parserPacket!.delta;
            this.rtmpHandler();
          } else if (this.parserPacket!.bytes % this.inChunkSize === 0) {
            this.parserState = RTMP_PARSE_INIT;
          }
          break;
      }
    }
  }

  private rtmpPacketParse(): void {
    const fmt = this.parserBuffer[0] >> 6;
    let cid: number;
    if (this.parserBasicBytes === 2) {
      cid = 64 + this.parserBuffer[1];
    } else if (this.parserBasicBytes === 3) {
      cid = 64 + this.parserBuffer[1] + (this.parserBuffer[2] << 8);
    } else {
      cid = this.parserBuffer[0] & 0x3f;
    }
    if (!this.inPackets.has(cid)) {
      this.parserPacket = createPacket(fmt, cid);
      this.inPackets.set(cid, this.parserPacket);
    } else {
      this.parserPacket = this.inPackets.get(cid)!;
    }
    this.parserPacket.header.fmt = fmt;
    this.parserPacket.header.cid = cid;
    this.rtmpChunkMessageHeaderRead();
  }

  private rtmpChunkMessageHeaderRead(): void {
    let offset = this.parserBasicBytes;
    if (this.parserPacket!.header.fmt <= 2) {
      this.parserPacket!.header.timestamp = this.parserBuffer.readUIntBE(offset, 3);
      offset += 3;
    }
    if (this.parserPacket!.header.fmt <= 1) {
      this.parserPacket!.header.length = this.parserBuffer.readUIntBE(offset, 3);
      this.parserPacket!.header.type = this.parserBuffer[offset + 3];
      offset += 4;
    }
    if (this.parserPacket!.header.fmt === RTMP_CHUNK_TYPE_0) {
      this.parserPacket!.header.stream_id = this.parserBuffer.readUInt32LE(offset);
    }
  }

  private rtmpPacketAlloc(): void {
    if (this.parserPacket!.capacity < this.parserPacket!.header.length) {
      this.parserPacket!.payload = Buffer.alloc(this.parserPacket!.header.length + 1024);
      this.parserPacket!.capacity = this.parserPacket!.header.length + 1024;
    }
  }

  private rtmpHandler(): void {
    switch (this.parserPacket!.header.type) {
      case RTMP_TYPE_SET_CHUNK_SIZE:
        this.inChunkSize = this.parserPacket!.payload!.readUInt32BE();
        break;
      case RTMP_TYPE_ABORT:
      case RTMP_TYPE_ACKNOWLEDGEMENT:
      case RTMP_TYPE_SET_PEER_BANDWIDTH:
        break;
      case RTMP_TYPE_WINDOW_ACKNOWLEDGEMENT_SIZE:
        break;
      case RTMP_TYPE_EVENT: {
        const payload = this.parserPacket!.payload!.subarray(0, this.parserPacket!.header.length);
        const event = payload.readUInt16BE();
        if (event === 6) {
          const value = payload.readUInt32BE(2);
          this.rtmpSendPingResponse(value);
        }
        break;
      }
      case RTMP_TYPE_AUDIO: {
        const payload = this.parserPacket!.payload!.subarray(0, this.parserPacket!.header.length);
        this.emit("audio", Buffer.from(payload), this.parserPacket!.clock);
        break;
      }
      case RTMP_TYPE_VIDEO: {
        const payload = this.parserPacket!.payload!.subarray(0, this.parserPacket!.header.length);
        this.emit("video", Buffer.from(payload), this.parserPacket!.clock);
        break;
      }
      case RTMP_TYPE_FLEX_STREAM:
      case RTMP_TYPE_DATA: {
        const payload = this.parserPacket!.payload!.subarray(0, this.parserPacket!.header.length);
        this.emit("script", Buffer.from(payload), this.parserPacket!.clock);
        break;
      }
      case RTMP_TYPE_FLEX_MESSAGE:
      case RTMP_TYPE_INVOKE: {
        const invokeOffset = this.parserPacket!.header.type === RTMP_TYPE_FLEX_MESSAGE ? 1 : 0;
        const payload = this.parserPacket!.payload!.subarray(invokeOffset, this.parserPacket!.header.length);
        const msg = AMF.decodeAmf0Cmd(payload);
        if (msg.cmd === "_result") {
          if (msg.transId === RTMP_TRANSACTION_CONNECT) {
            this.rtmpOnConnect();
          } else if (msg.transId === RTMP_TRANSACTION_CREATE_STREAM) {
            this.rtmpOnCreateStream(msg.info as number);
          }
        } else if (msg.cmd === "_error") {
          this.emit("error", new Error(JSON.stringify(msg.info)));
        } else if (msg.cmd === "onStatus") {
          const info = msg.info as Record<string, string> | undefined;
          if (info?.code === "NetStream.Play.Start" || info?.code === "NetStream.Publish.Start") {
            this._connected = true;
          }
          this.emit("status", info);
        }
        break;
      }
    }
  }
}

export interface RelayStats {
  bitrateKbps: number;
}

export interface DirectRelayCallbacks {
  onStarted: () => void;
  /** Publisher closed — session is fully over. */
  onStopped: (reason: string) => void;
  /** Publisher error — session is fully over. */
  onError: (error: string) => void;
  /** Pull-side failed while publisher is still open (e.g. source dropped). */
  onPullFailed?: (reason: string) => void;
  onDebugLog: (message: string) => void;
}

export class DirectRelay {
  private pullClient: RtmpClient | null = null;
  private pushClient: RtmpClient | null = null;
  private running = false;
  private inputUrl: string;
  private readonly outputUrl: string;
  private readonly name: string;
  private readonly callbacks: DirectRelayCallbacks;
  private bytesSent = 0;
  private lastStatBytes = 0;
  private lastStatTime = Date.now();

  // Session-ID pattern: bumped each time we start a new pull session so that
  // stale event handlers from a previous pull are silently ignored.
  private pullSessionId = 0;

  // Timestamp offset for seamless source transitions: all outgoing timestamps
  // are raw_ts + tsOffset, which is recalculated on each switchInput.
  private tsOffset = 0;
  private lastPushedTs = 0;
  // Set before starting a new pull; resolved to tsOffset on first packet.
  private pendingTsBase: number | null = null;

  // Cached RTMP packets for the hold-last-frame mode
  private cachedVideoSeqHeader: Buffer | null = null;
  private cachedVideoKeyframe: Buffer | null = null;
  private cachedAudioSeqHeader: Buffer | null = null;
  private cachedLastAudio: Buffer | null = null;
  private holdInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    inputUrl: string,
    outputUrl: string,
    name: string,
    callbacks: DirectRelayCallbacks
  ) {
    this.inputUrl = inputUrl;
    this.outputUrl = outputUrl;
    this.name = name;
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.callbacks.onDebugLog(`Starting direct relay: ${this.inputUrl} -> ${this.outputUrl}`);

    this.pushClient = new RtmpClient(this.outputUrl, true);

    this.pushClient.on("status", (info: Record<string, string>) => {
      this.callbacks.onDebugLog(`Push status: ${JSON.stringify(info)}`);
      if (info?.code === "NetStream.Publish.Start") {
        this.callbacks.onDebugLog("Push client connected, starting pull client");
        this.startPull(this.inputUrl);
      }
    });

    this.pushClient.on("error", (err: Error) => {
      this.callbacks.onDebugLog(`Push error: ${err.message}`);
      if (this.running) {
        this.running = false;
        this.stopHoldLastFrame();
        this.stopCurrentPull();
        this.pushClient = null;
        this.callbacks.onError(`Push connection failed: ${err.message}`);
      }
    });

    this.pushClient.on("close", () => {
      this.callbacks.onDebugLog("Push connection closed");
      if (this.running) {
        this.running = false;
        this.stopHoldLastFrame();
        this.stopCurrentPull();
        this.pushClient = null;
        this.callbacks.onStopped("push_connection_closed");
      }
    });

    this.pushClient.start();
  }

  /**
   * Swap the pull source without touching the publisher.
   * Call this when the ingest source changes (OBS→slate or slate→OBS).
   * Timestamps are offset so the outgoing stream remains monotonic.
   */
  switchInput(newInputUrl: string): void {
    if (!this.running) return;
    this.callbacks.onDebugLog(`Switching pull source to: ${newInputUrl}`);
    this.inputUrl = newInputUrl;
    // Schedule ts continuation: next first packet from new source will set tsOffset
    this.pendingTsBase = this.lastPushedTs + 33; // ≈1 video frame gap
    this.startPull(newInputUrl);
  }

  /**
   * Freeze the stream by replaying the last cached keyframe + audio on a fixed
   * interval. This keeps the publisher alive with continuous media while the
   * real source (e.g. OBS) is momentarily unavailable and the slate warms up.
   * Call switchInput() to resume a live source.
   */
  holdLastFrame(fps = 30): void {
    if (!this.running || this.holdInterval !== null) return;
    if (!this.cachedVideoKeyframe && !this.cachedAudioSeqHeader) {
      this.callbacks.onDebugLog("holdLastFrame: no cached frames available yet");
      return;
    }
    this.callbacks.onDebugLog("Holding last frame while waiting for slate");
    // Discard the existing pull without triggering onPullFailed
    ++this.pullSessionId;
    this.stopCurrentPull();

    const interval = Math.round(1000 / fps);
    let nextTs = this.lastPushedTs + interval;

    this.holdInterval = setInterval(() => {
      if (!this.pushClient?.connected) return;
      // Codec header + keyframe keep decoders happy
      if (this.cachedVideoSeqHeader) {
        this.pushClient.pushVideo(this.cachedVideoSeqHeader, nextTs);
      }
      if (this.cachedVideoKeyframe) {
        this.pushClient.pushVideo(this.cachedVideoKeyframe, nextTs);
      }
      if (this.cachedAudioSeqHeader) {
        this.pushClient.pushAudio(this.cachedAudioSeqHeader, nextTs);
      }
      if (this.cachedLastAudio) {
        this.pushClient.pushAudio(this.cachedLastAudio, nextTs);
      }
      this.lastPushedTs = nextTs;
      nextTs += interval;
    }, interval);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    ++this.pullSessionId; // invalidate any pending pull callbacks
    this.stopHoldLastFrame();
    this.stopCurrentPull();
    try { this.pushClient?.stop(); } catch { /* ignore */ }
    this.pushClient = null;
  }

  getStats(): RelayStats {
    const now = Date.now();
    const elapsed = (now - this.lastStatTime) / 1000;
    const bytes = this.bytesSent - this.lastStatBytes;
    const bitrateKbps = elapsed > 0 ? Math.round((bytes * 8) / elapsed / 1000) : 0;
    this.lastStatBytes = this.bytesSent;
    this.lastStatTime = now;
    return { bitrateKbps };
  }

  private adjustTs(rawTs: number): number {
    if (this.pendingTsBase !== null) {
      this.tsOffset = this.pendingTsBase - rawTs;
      this.pendingTsBase = null;
    }
    const ts = Math.max(0, rawTs + this.tsOffset);
    if (ts > this.lastPushedTs) this.lastPushedTs = ts;
    return ts;
  }

  private startPull(inputUrl: string): void {
    this.stopHoldLastFrame();
    this.stopCurrentPull();

    const sessionId = ++this.pullSessionId;
    const pull = new RtmpClient(inputUrl, false);
    this.pullClient = pull;

    pull.on("status", (info: Record<string, string>) => {
      if (sessionId !== this.pullSessionId) return;
      this.callbacks.onDebugLog(`Pull status: ${JSON.stringify(info)}`);
      if (info?.code === "NetStream.Play.Start") {
        this.callbacks.onStarted();
      }
    });

    pull.on("audio", (data: Buffer, rawTs: number) => {
      if (sessionId !== this.pullSessionId || !this.pushClient) return;
      // Cache audio sequence header and last raw audio frame for hold-last-frame mode
      if (data.length > 1 && (data[0] & 0xf0) === 0xa0) {
        if (data[1] === 0x00) this.cachedAudioSeqHeader = Buffer.from(data);
        else this.cachedLastAudio = Buffer.from(data);
      }
      const ts = this.adjustTs(rawTs);
      this.pushClient.pushAudio(data, ts);
      this.bytesSent += data.length;
    });

    pull.on("video", (data: Buffer, rawTs: number) => {
      if (sessionId !== this.pullSessionId || !this.pushClient) return;
      // Cache H.264 sequence header and last IDR keyframe for hold-last-frame mode
      if (data.length > 1) {
        const isKey = (data[0] & 0xf0) === 0x10; // frame type 1 = keyframe
        if (isKey && data[1] === 0x00) this.cachedVideoSeqHeader = Buffer.from(data);
        else if (isKey) this.cachedVideoKeyframe = Buffer.from(data);
      }
      const ts = this.adjustTs(rawTs);
      this.pushClient.pushVideo(data, ts);
      this.bytesSent += data.length;
    });

    pull.on("script", (data: Buffer, rawTs: number) => {
      if (sessionId !== this.pullSessionId || !this.pushClient) return;
      const ts = this.adjustTs(rawTs);
      this.pushClient.pushScript(data, ts);
      this.bytesSent += data.length;
    });

    pull.on("error", (err: Error) => {
      if (sessionId !== this.pullSessionId) return;
      this.callbacks.onDebugLog(`Pull error: ${err.message}`);
      this.pullClient = null;
      this.callbacks.onPullFailed?.(`Pull connection failed: ${err.message}`);
    });

    pull.on("close", () => {
      if (sessionId !== this.pullSessionId) return;
      this.callbacks.onDebugLog("Pull connection closed");
      this.pullClient = null;
      this.callbacks.onPullFailed?.("pull_connection_closed");
    });

    pull.start();
  }

  private stopCurrentPull(): void {
    const p = this.pullClient;
    this.pullClient = null;
    try { p?.stop(); } catch { /* ignore */ }
  }

  private stopHoldLastFrame(): void {
    if (this.holdInterval) {
      clearInterval(this.holdInterval);
      this.holdInterval = null;
    }
  }
}
