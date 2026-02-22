declare module "node-media-server" {
  interface NmsConfig {
    logType?: number;
    rtmp?: {
      port?: number;
      chunk_size?: number;
      gop_cache?: boolean;
      ping?: number;
      ping_timeout?: number;
    };
    http?: {
      port?: number;
      allow_origin?: string;
    };
  }

  class NodeMediaServer {
    constructor(config: NmsConfig);
    run(): void;
    stop(): void;
    on(event: string, callback: (...args: any[]) => void): void;
  }

  export = NodeMediaServer;
}
