/**
 * WebSocket tunnel that speaks the guacd client handshake directly
 * (select -> args -> data -> connect), then streams Guacamole protocol
 * instructions over the socket. Compatible with Guacamole.Client, which
 * only requires: state, latency, connect(), send(), disconnect() and the
 * oninstruction / onstatechange / onerror callbacks.
 */
import Guacamole from 'guacamole-common-js';

export interface TunnelTarget {
  /** ws:// URL of the trdc local bridge. */
  url: string;
  /** guacamole protocol to select, e.g. "rdp". */
  protocol: string;
  /** Connection parameters (guacd argument names). */
  parameters: Record<string, string>;
  /** Client viewport size; guacd only streams frames to users that have
   *  declared a display size, so this is sent as the `size` handshake
   *  instruction. Defaults to 1280x1024@96 when omitted. */
  width?: number;
  height?: number;
  dpi?: number;
}

const TunnelState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSED: 2,
  UNCONNECTED: 3,
} as const;

/** Serialize an instruction the way guacamole expects on the wire. */
export function serializeInstruction(opcode: string, args: (string | number)[]): string {
  let out = String(opcode.length) + '.' + opcode;
  for (const arg of args) {
    const value = String(arg);
    out += ',' + value.length + '.' + value;
  }
  return out + ';';
}

export class WsTunnel {
  state: number = TunnelState.UNCONNECTED;
  latency = 0;
  socket: WebSocket | null = null;
  oninstruction: ((opcode: string, args: string[]) => void) | null = null;
  onstatechange: ((state: number) => void) | null = null;
  onerror: ((status: any) => void) | null = null;

  private parser: any;
  private connectStartTime = 0;
  private target: TunnelTarget | null = null;
  /** Argument names advertised by guacd, in order. */
  private advertisedArgs: string[] = [];
  /** Protocol-version string guacd advertised; echoed back in "connect". */
  private serverVersion = '';
  /** True once the guacd handshake has completed ("ready" received). */
  private handshakeDone = false;

  constructor() {
    this.parser = new Guacamole.Parser();
    this.parser.oninstruction = (opcode: string, args: string[]) => {
      this.handleInstruction(opcode, args);
    };
  }

  private setState(state: number) {
    this.state = state;
    if (this.onstatechange) this.onstatechange(state);
  }

  private handleInstruction(opcode: string, args: string[]) {
    // During the guacd handshake we consume args/select/ready ourselves and
    // only start forwarding instructions to the client once "ready" arrives.
    if (!this.handshakeDone) {
      switch (opcode) {
        case 'args':
          // args,<protocol-version>,<name>,<name>...
          this.serverVersion = args[0] ?? '';
          this.advertisedArgs = args.slice(1);
          this.sendHandshake();
          return;
        case 'ready':
          // ready,<connection-id> - handshake complete, session is live.
          this.latency = Date.now() - this.connectStartTime;
          this.handshakeDone = true;
          this.setState(TunnelState.OPEN);
          return;
        case 'select':
          return; // echoed select (never actually sent by guacd); ignore
        case 'error':
          // Handshake-level error; forward so the client reports it.
          if (this.oninstruction) this.oninstruction(opcode, args);
          return;
        default:
          // Anything else during the handshake is unexpected; forward it so
          // the client's own handlers can deal with it.
          if (this.oninstruction) this.oninstruction(opcode, args);
      }
      return;
    }

    // Steady state: pass every instruction through to the client.
    if (this.oninstruction) this.oninstruction(opcode, args);
  }

  /**
   * Reply to guacd's "args" instruction. The Guacamole handshake requires the
   * client to advertise its capabilities and then send the connection
   * parameter values inside the "connect" instruction, preceded by the server's
   * own protocol-version string (guacd uses argv[0] as the client's advertised
   * version and argv[1..] as the values for each advertised argument).
   */
  private sendHandshake() {
    if (!this.target || !this.socket) return;
    const values = this.advertisedArgs.map((name) => {
      if (name === 'timezone' && !this.target!.parameters.timezone) {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
          return '';
        }
      }
      return this.target!.parameters[name] ?? '';
    });

    // Capability advertisement (mirrors what guacamole-common-js can render).
    // `size` is mandatory: guacd only forwards frame data to users that have
    // declared a viewport (see src/libguac/user-handshake.c).
    this.rawSend('size', [
      String(this.target.width ?? 1280),
      String(this.target.height ?? 1024),
      String(this.target.dpi ?? 96),
    ]);
    this.rawSend('audio', ['audio/L24', 'audio/L16', 'audio/ogg']);
    this.rawSend('video', []);
    this.rawSend('image', ['image/png', 'image/jpeg', 'image/webp']);
    this.rawSend('name', ['trdc']);
    this.rawSend('timezone', [this.tz()]);

    // connect,<server-version>,<value0>,<value1>...
    this.rawSend('connect', [this.serverVersion, ...values]);
  }

  private tz(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return '';
    }
  }

  private rawSend(opcode: string, args: (string | number)[]) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(serializeInstruction(opcode, args));
    }
  }

  /** Open the socket and run the guacd handshake. */
  connect(target: TunnelTarget) {
    if (this.state === TunnelState.CONNECTING || this.state === TunnelState.OPEN) return;
    this.target = target;
    this.handshakeDone = false;
    this.advertisedArgs = [];
    this.serverVersion = '';
    this.setState(TunnelState.CONNECTING);
    this.connectStartTime = Date.now();

    let socket: WebSocket;
    try {
      socket = new WebSocket(target.url);
    } catch {
      this.fail('Unable to connect to the local bridge.');
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.rawSend('select', [target.protocol]);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        this.parser.receive(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this.parser.receive(this.decodeArrayBuffer(event.data));
      }
    };
    socket.onerror = () => {
      this.fail('Connection to the local bridge failed.');
    };
    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      if (this.state === TunnelState.OPEN || this.state === TunnelState.CONNECTING) {
        if (this.state === TunnelState.CONNECTING) {
          this.fail(
            event.reason || 'Bridge closed the connection before the session opened.',
          );
        } else {
          this.setState(TunnelState.CLOSED);
        }
      }
    };
  }

  private pendingText: Uint8Array = new Uint8Array(0);
  /** Incrementally decode binary WS frames as UTF-8 (guac instructions are text). */
  private decodeArrayBuffer(buffer: ArrayBuffer): string {
    const incoming = new Uint8Array(buffer);
    const merged = new Uint8Array(this.pendingText.length + incoming.length);
    merged.set(this.pendingText, 0);
    merged.set(incoming, this.pendingText.length);
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
      this.pendingText = new Uint8Array(0);
      return text;
    } catch {
      return '';
    }
  }

  private fail(message: string) {
    if (this.state === TunnelState.CLOSED || this.state === TunnelState.UNCONNECTED) return;
    this.setState(TunnelState.CLOSED);
    if (this.onerror) {
      this.onerror(new Guacamole.Status(Guacamole.Status.Code.UPSTREAM_TIMEOUT, message));
    }
  }

  /** Guacamole.Tunnel.send */
  send(opcode: string, ...args: unknown[]) {
    if (this.state !== TunnelState.OPEN) return;
    this.rawSend(opcode, args as (string | number)[]);
  }

  /** Guacamole.Tunnel.sendMessage (alias of send used by Client internals). */
  sendMessage(opcode: string, ...args: (string | number)[]) {
    if (this.state !== TunnelState.OPEN) return;
    this.rawSend(opcode, args);
  }

  /** Guacamole.Tunnel.disconnect */
  disconnect() {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
    if (this.state !== TunnelState.UNCONNECTED) {
      this.setState(TunnelState.CLOSED);
    }
  }
}

export { TunnelState };
