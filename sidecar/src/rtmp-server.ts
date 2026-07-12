import NodeMediaServer from "node-media-server";
import type { Server as NetServer, Socket } from "net";
import { SLATE_RTMP_STREAM_KEY } from "./types";

export interface RtmpServerCallbacks {
  onStreamConnect: (streamKey: string) => void;
  onStreamDisconnect: (streamKey: string) => void;
  onDebugLog?: (source: string, message: string) => void;
}

interface NodeMediaSession {
  socket?: {
    localPort?: number;
  };
}

interface NodeMediaServerRuntime extends NodeMediaServer {
  getSession(id: string): NodeMediaSession | undefined;
  nrs?: {
    tcpServer?: NetServer;
  };
}

export class RtmpServer {
  // node-media-server 2.x keeps its event emitter and sessions in module-global
  // state. A single bridge must route those events to the profile that owns the
  // connection's local port.
  private static readonly serversByPort = new Map<number, RtmpServer>();
  private static readonly sessionOwners = new Map<string, RtmpServer>();
  private static eventSource: NodeMediaServerRuntime | null = null;
  private static eventBridgeInstalled = false;

  private nms: NodeMediaServer | null = null;
  private port: number;
  private running = false;
  private callbacks: RtmpServerCallbacks;
  private activeStreams = new Set<string>();
  private sockets = new Set<Socket>();

  constructor(port: number, callbacks: RtmpServerCallbacks) {
    this.port = port;
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.running) return;

    const existing = RtmpServer.serversByPort.get(this.port);
    if (existing && existing !== this && existing.isRunning()) {
      throw new Error(`RTMP ingest port ${this.port} is already in use by another profile`);
    }

    const config = {
      logType: 0, // silence NMS internal logs
      rtmp: {
        port: this.port,
        chunk_size: 60000,
        gop_cache: true,
        ping: 86400,
        ping_timeout: 86400,
      },
    };

    const nms = new NodeMediaServer(config);
    this.nms = nms;
    RtmpServer.installEventBridge(nms as NodeMediaServerRuntime);
    RtmpServer.serversByPort.set(this.port, this);

    const tcpServer = (nms as NodeMediaServerRuntime).nrs?.tcpServer;
    tcpServer?.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });

    try {
      nms.run();
      this.running = true;
    } catch (error) {
      if (RtmpServer.serversByPort.get(this.port) === this) {
        RtmpServer.serversByPort.delete(this.port);
      }
      this.nms = null;
      throw error;
    }
  }

  stop(): void {
    if (!this.running || !this.nms) return;
    const nms = this.nms as NodeMediaServerRuntime;
    if (RtmpServer.serversByPort.get(this.port) === this) {
      RtmpServer.serversByPort.delete(this.port);
    }
    this.nms = null;
    this.running = false;
    this.activeStreams.clear();

    const tcpServer = nms.nrs?.tcpServer;
    if (tcpServer) {
      // NodeMediaServer.stop() walks a global session map and disconnects every
      // profile. Closing this instance's listener and sockets keeps other ingest
      // ports untouched.
      try {
        tcpServer.close();
      } catch {
        // Already closed.
      }
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();
    } else if (RtmpServer.serversByPort.size === 0) {
      // Compatibility fallback for a future NMS version without the 2.x
      // internal server handle. It is only safe when no other profile is live.
      nms.stop();
    } else {
      this.callbacks.onDebugLog?.(
        "rtmp-server",
        `Unable to close ingest port ${this.port} without affecting other profiles`
      );
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  hasActiveStream(): boolean {
    return this.activeStreams.size > 0;
  }

  getPort(): number {
    return this.port;
  }

  setPort(port: number): void {
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.port = port;
    if (wasRunning) this.start();
  }

  private extractStreamKey(streamPath: string): string | null {
    // streamPath format: /live/streamkey
    const parts = streamPath.split("/");
    return parts.length >= 3 ? parts[2] : null;
  }

  private static installEventBridge(nms: NodeMediaServerRuntime): void {
    if (!RtmpServer.eventSource) {
      RtmpServer.eventSource = nms;
    }
    if (RtmpServer.eventBridgeInstalled) return;
    RtmpServer.eventBridgeInstalled = true;

    nms.on("preConnect", (id: string, args: Record<string, unknown>) => {
      const server = RtmpServer.serverForSession(id);
      if (!server) return;
      RtmpServer.sessionOwners.set(id, server);
      server.callbacks.onDebugLog?.(
        "rtmp-server",
        `Incoming connection: ${JSON.stringify(args)}`
      );
    });
    nms.on("prePublish", (id: string, streamPath: string) => {
      RtmpServer.ownerForSession(id)?.handlePublishStart(streamPath);
    });
    nms.on("donePublish", (id: string, streamPath: string) => {
      RtmpServer.ownerForSession(id)?.handlePublishEnd(streamPath);
    });
    nms.on("doneConnect", (id: string) => {
      RtmpServer.sessionOwners.delete(id);
    });
  }

  private static serverForSession(id: string): RtmpServer | undefined {
    const localPort = RtmpServer.eventSource?.getSession(id)?.socket?.localPort;
    return typeof localPort === "number"
      ? RtmpServer.serversByPort.get(localPort)
      : undefined;
  }

  private static ownerForSession(id: string): RtmpServer | undefined {
    return RtmpServer.sessionOwners.get(id) ?? RtmpServer.serverForSession(id);
  }

  private handlePublishStart(streamPath: string): void {
    if (!this.running) return;
    const key = this.extractStreamKey(streamPath);
    this.callbacks.onDebugLog?.(
      "rtmp-server",
      `Incoming publish: ${JSON.stringify({ streamPath, streamKey: key })}`
    );
    if (key === SLATE_RTMP_STREAM_KEY) return;
    if (key && !this.activeStreams.has(key)) {
      this.activeStreams.add(key);
      this.callbacks.onStreamConnect(key);
    }
  }

  private handlePublishEnd(streamPath: string): void {
    if (!this.running) return;
    const key = this.extractStreamKey(streamPath);
    this.callbacks.onDebugLog?.(
      "rtmp-server",
      `Publish ended: ${JSON.stringify({ streamPath, streamKey: key })}`
    );
    if (key === SLATE_RTMP_STREAM_KEY) return;
    if (key && this.activeStreams.has(key)) {
      this.activeStreams.delete(key);
      this.callbacks.onStreamDisconnect(key);
    }
  }
}
