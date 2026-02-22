import NodeMediaServer from "node-media-server";

export interface RtmpServerCallbacks {
  onStreamConnect: (streamKey: string) => void;
  onStreamDisconnect: (streamKey: string) => void;
}

export class RtmpServer {
  private nms: NodeMediaServer | null = null;
  private port: number;
  private running = false;
  private callbacks: RtmpServerCallbacks;
  private activeStreams = new Set<string>();

  constructor(port: number, callbacks: RtmpServerCallbacks) {
    this.port = port;
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.running) return;

    const config = {
      logType: 0, // silence NMS internal logs
      rtmp: {
        port: this.port,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
      },
    };

    this.nms = new NodeMediaServer(config);

    this.nms.on("prePublish", (_id: string, streamPath: string) => {
      const key = this.extractStreamKey(streamPath);
      if (key && !this.activeStreams.has(key)) {
        this.activeStreams.add(key);
        this.callbacks.onStreamConnect(key);
      }
    });

    this.nms.on("donePublish", (_id: string, streamPath: string) => {
      const key = this.extractStreamKey(streamPath);
      if (key && this.activeStreams.has(key)) {
        this.activeStreams.delete(key);
        this.callbacks.onStreamDisconnect(key);
      }
    });

    this.nms.run();
    this.running = true;
  }

  stop(): void {
    if (!this.running || !this.nms) return;
    this.nms.stop();
    this.nms = null;
    this.running = false;
    this.activeStreams.clear();
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
}
