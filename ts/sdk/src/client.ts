import { emitDiagnosticLog } from "./logging.js";
import { SDK_VERSION } from "./version.js";
import { verify, nativeRuntime, VerificationError, remoteFailure, roots } from "./verify.js";
import { decode, encode } from "@msgpack/msgpack";
import { decodeMessage } from "./protocol/wire.js";
import { NavigationQuery } from "./navigation.js";
import { packMessage, parseMessage, parseTarget, ProtocolValidationError } from "./protocol/parse.js";
import {
  DEFAULT_URL,
  PROTO_VERSION,
  type AxesMessage,
  type CameraDeltaMessage,
  type CameraPivotMessage,
  type CameraPoseMessage,
  type CapabilitiesMessage,
  type ErrorMessage,
  type FrameMessage,
  type NavigationStateMessage,
  type ObjectDeltaMessage,
  type ObjectPivotMessage,
  type ObjectPoseMessage,
  type OpenAxisInteger,
  type RequestMessage,
  type ResponseMessage,
  type StandardMessage,
  type Target,
  type Vec3,
  type WireMap,
} from "./protocol/types.js";

const OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 1_000;

export enum ConnectionState {
  Disconnected = "disconnected",
  Connecting = "connecting",
  Connected = "connected",
  Disconnecting = "disconnecting",
}

export interface OpenAxisClientOptions {
  clientName: string;
  clientVersion?: string;
  url?: string;
  handshakeTimeoutMs?: number;
  target?: Target;
}

export interface RequestOptions {
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

export interface OpenAxisListener {
  onFrame?(frame: FrameMessage): void;
  onButtons?(buttons: number): void;
  onMotionStart?(gestureId: OpenAxisInteger): void;
  onMotionEnd?(gestureId: OpenAxisInteger): void;
  onNavigationState?(state: NavigationStateMessage): void;
  onCameraPose?(pose: CameraPoseMessage): void;
  onCameraPivot?(pivot: CameraPivotMessage): void;
  onObjectPose?(pose: ObjectPoseMessage): void;
  onObjectPivot?(pivot: ObjectPivotMessage): void;
  onAxes?(axes: readonly string[]): void;
  onNavigationQuery?(query: NavigationQuery): boolean | void;
  onRequest?(request: RequestMessage): boolean | void;
  onResponse?(response: ResponseMessage): void;
  onExtension?(messageType: string, message: WireMap): void;
  onStateChange?(state: ConnectionState): void;
  onError?(code: string, message: string): void;
}

export class RpcRequestError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "RpcRequestError";
  }
}

interface PendingRequest {
  resolve(value: WireMap): void;
  reject(reason: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

type Projection = { fov: number; orthoExtent?: never } | { fov?: never; orthoExtent: number };

export class OpenAxisClient {
  private socket: WebSocket | null = null;
  private connectionState = ConnectionState.Disconnected;
  private readonly listeners = new Set<OpenAxisListener>();
  private navigationOwner?: OpenAxisListener;
  readonly url: string;
  private readonly clientName: string;
  private readonly clientVersion: string | undefined;
  private readonly target: Target | undefined;
  private readonly handshakeTimeoutMs: number;
  private handshakeReject: ((reason: unknown) => void) | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastSendAt = 0;
  private verificationExpiry?: number;
  private verificationRoots = roots;
  private verifyDevice = verify;
  private lastVerificationFailure?: string;
  private reportVerificationFailure = (message: string): void => {
    if (message !== this.lastVerificationFailure) {
      this.lastVerificationFailure = message;
      emitDiagnosticLog("warning", message);
    }
  };
  private verificationDeadline?: number;
  verificationStatus?: string;
  private nextRequestId = 0;
  private readonly pending = new Map<OpenAxisInteger, PendingRequest>();

  constructor(options: OpenAxisClientOptions, listener?: OpenAxisListener) {
    if (!options.clientName?.trim()) throw new TypeError("clientName is required");
    this.clientName = options.clientName;
    if (options.clientVersion !== undefined && (typeof options.clientVersion !== "string" || !options.clientVersion.trim())) throw new TypeError("clientVersion must be a non-empty string");
    this.clientVersion = options.clientVersion;
    this.target = options.target === undefined ? undefined : parseTarget(options.target);
    this.url = options.url ?? DEFAULT_URL;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
    if (!Number.isFinite(this.handshakeTimeoutMs) || this.handshakeTimeoutMs <= 0) {
      throw new TypeError("handshakeTimeoutMs must be a positive finite number");
    }
    if (listener) this.listeners.add(listener);
  }

  get state(): ConnectionState { return this.connectionState }
  getState(): ConnectionState { return this.connectionState }

  addListener(listener: OpenAxisListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Attach one exclusive navigation owner; ordinary listeners retain other events. */
  attachNavigation(listener: OpenAxisListener): () => void {
    if (this.navigationOwner) throw new Error("A NavigationSession is already attached");
    this.navigationOwner = listener;
    return () => { if (this.navigationOwner === listener) this.navigationOwner = undefined };
  }

  /** Sender bound to this connection, never a later reconnect. */
  captureNavigationSender(): (message: StandardMessage) => void {
    const socket = this.socket;
    if (!socket || this.state !== ConnectionState.Connected) throw new Error("OpenAxis client is not connected");
    return message => {
      if(this.verificationExpired()) { void this.disconnect(); throw new VerificationError("expired") }
      if (socket !== this.socket || socket.readyState !== OPEN || this.state !== ConnectionState.Connected) throw new Error("Navigation connection retired");
      socket.send(encode(packMessage(message)));
      this.lastSendAt = Date.now();
    };
  }

  async connect(): Promise<void> {
    if (this.connectionState !== ConnectionState.Disconnected) throw new Error(`Cannot connect from state: ${this.connectionState}`);
    this.setState(ConnectionState.Connecting);
    try {
      const socket = new WebSocket(this.url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.handshakeReject = undefined;
          error === undefined ? resolve() : reject(error);
        };
        const timeout = setTimeout(() => finish(new Error("Timed out waiting for hello_ack")), this.handshakeTimeoutMs);
        this.handshakeReject = finish;
        socket.onopen = () => {
          try { this.sendRaw({ type: "hello", proto: PROTO_VERSION, client_name: this.clientName, sdk: { name: "openaxis-typescript", version: SDK_VERSION }, ...(this.clientVersion !== undefined ? { client_version: this.clientVersion } : {}), ...(this.target ? { target: this.target } : {}) }) }
          catch (error) { finish(error) }
        };
        socket.onerror = () => finish(new Error("WebSocket error during OpenAxis handshake"));
        socket.onclose = () => finish(new Error("OpenAxis connection closed during handshake"));
        socket.onmessage = event => {
          try {
            const message = this.decodeEvent(event.data);
            if (message.type === "error") {
              const error = message as ErrorMessage;
              finish(new Error(`OpenAxis handshake rejected: ${error.code}: ${error.message}`));
              return;
            }
            if (message.type !== "hello_ack") throw new Error(`Expected hello_ack, got ${message.type}`);
            const ack = message as { proto: string };
            if (ack.proto !== PROTO_VERSION) throw new Error(`Server selected unsupported protocol ${ack.proto}`);
            finish();
          } catch (error) {
            finish(error);
          }
        };
      });
      if (this.socket !== socket) throw new Error("OpenAxis connection closed during handshake");
      if (nativeRuntime()) {
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const id = this.allocateRequestId();
        const result = await new Promise<WireMap>((resolve,reject) => {
          const timer = setTimeout(() => finish(new VerificationError("timeout")),10_000);
          let settled=false;
          const finish=(error?:unknown,result?:WireMap)=>{if(settled)return;settled=true;clearTimeout(timer);this.handshakeReject=undefined;error===undefined?resolve(result!):reject(error)};
          this.handshakeReject=finish;
          socket.onclose=()=>finish(new Error("Connection closed during verification"));
          socket.onerror=()=>finish(new Error("WebSocket verification failed"));
          socket.onmessage=event=>{
            try {
              const message=this.decodeEvent(event.data);
              if(message.type!=="response" || (message as ResponseMessage).id!==id) return;
              const response=message as ResponseMessage;
              if(event.data.byteLength>20*1024)throw new VerificationError();
              if(response.error)throw remoteFailure(response.error.code,this.reportVerificationFailure);
              finish(undefined,response.result??{});
            }catch(error){finish(error)}
          };
          try { this.sendRaw({type:"request",id,method:"q",params:{v:1,c:challenge}}) } catch(error){finish(error)}
        });
        const verified=await this.verifyDevice(result,challenge,this.verificationRoots,undefined,this.reportVerificationFailure);
        if(this.socket!==socket || socket.readyState!==OPEN) throw new Error("Connection closed during verification");
        this.lastVerificationFailure=undefined;
        this.verificationStatus=verified.kind+"_verified";
        this.verificationExpiry=verified.expiresAt;
        this.verificationDeadline=verified.expiresAt===undefined?undefined:performance.now()+Math.max(0,verified.expiresAt*1000-Date.now());
      } else this.verificationStatus="not_checked_browser";
      socket.onmessage = event => this.handleMessage(event.data);
      socket.onerror = () => { /* close supplies deterministic cleanup */ };
      socket.onclose = () => this.handleClose();
      this.setState(ConnectionState.Connected);
      this.startHeartbeat();
    } catch (error) {
      this.closeSocket();
      this.setState(ConnectionState.Disconnected);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connectionState === ConnectionState.Disconnected) return;
    this.setState(ConnectionState.Disconnecting);
    this.handshakeReject?.(new Error("OpenAxis connection closed"));
    this.closeSocket();
    this.rejectPending(new Error("OpenAxis connection closed"));
    this.setState(ConnectionState.Disconnected);
  }

  sendTags(tags: readonly string[]): void { this.sendMessage({ type: "tags", tags: [...tags] }) }
  sendFocus(focused: boolean): void { this.sendMessage({ type: "focus", focused }) }
  sendCapabilities(capabilities: readonly string[]): void { this.sendMessage({ type: "capabilities", capabilities: [...capabilities] }) }
  subscribe(axes: readonly string[]): void { this.sendMessage({ type: "subscribe", axes: [...axes] }) }
  sendMotionCancel(gestureId: OpenAxisInteger, reason?: string): void {
    this.sendMessage({ type: "motion_cancel", gesture_id: gestureId, ...(reason === undefined ? {} : { reason }) });
  }
  sendViewportSettled(): void { this.sendMessage({ type: "viewport.settled" }) }

  sendCameraPose(gestureId: OpenAxisInteger, t: Vec3, r: Vec3, projection: Projection): void {
    const message: CameraPoseMessage = { type: "camera.pose", gesture_id: gestureId, t, r };
    if (projection.fov !== undefined) message.fov = projection.fov;
    else message.ortho_extent = projection.orthoExtent;
    this.sendMessage(message);
  }

  sendCameraDelta(
    gestureId: OpenAxisInteger,
    t: Vec3,
    r: Vec3,
    options: { orthoExtentScale?: number; deltaId?: OpenAxisInteger } = {},
  ): void {
    const message: CameraDeltaMessage = { type: "camera.delta", gesture_id: gestureId, t, r };
    if (options.orthoExtentScale !== undefined) message.ortho_extent_scale = options.orthoExtentScale;
    if (options.deltaId !== undefined) message.delta_id = options.deltaId;
    this.sendMessage(message);
  }

  sendObjectPose(gestureId: OpenAxisInteger, t: Vec3, r: Vec3): void {
    this.sendMessage({ type: "object.pose", gesture_id: gestureId, t, r });
  }

  sendObjectDelta(gestureId: OpenAxisInteger, t: Vec3, r: Vec3, deltaId?: OpenAxisInteger): void {
    const message: ObjectDeltaMessage = { type: "object.delta", gesture_id: gestureId, t, r };
    if (deltaId !== undefined) message.delta_id = deltaId;
    this.sendMessage(message);
  }

  sendResponse(requestId: OpenAxisInteger, result: WireMap): void {
    this.sendMessage({ type: "response", id: requestId, result });
  }

  sendResponseError(requestId: OpenAxisInteger, code: string, message?: string): void {
    this.sendMessage({ type: "response", id: requestId, error: { code, ...(message === undefined ? {} : { message }) } });
  }

  request(method: string, params: WireMap = {}, options: RequestOptions = {}): Promise<WireMap> {
    if (!method.trim()) return Promise.reject(new TypeError("Request method is required"));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timeoutMs = options.timeoutMs === undefined ? 5_000 : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      return Promise.reject(new TypeError("timeoutMs must be a non-negative finite number or null"));
    }
    const id = this.allocateRequestId();
    return new Promise<WireMap>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, signal: options.signal };
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          this.finishPending(id);
          reject(new Error(`OpenAxis request timed out: ${method}`));
        }, timeoutMs);
      }
      if (options.signal) {
        pending.abort = () => {
          this.pending.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          reject(options.signal!.reason ?? new DOMException("Aborted", "AbortError"));
        };
        options.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      try { this.sendMessage({ type: "request", id, method, params }); }
      catch (error) { this.finishPending(id); reject(error) }
    });
  }

  executeCommand(name: string, params: WireMap = {}, options?: RequestOptions): Promise<WireMap> {
    if (!name.trim()) return Promise.reject(new TypeError("Command name is required"));
    if (Object.hasOwn(params, "name")) {
      return Promise.reject(new TypeError("Command parameters must not contain the reserved 'name' field"));
    }
    return this.request("command.execute", { name, ...params }, options);
  }

  private sendMessage(message: StandardMessage): void {
    if(this.verificationExpired()) { void this.disconnect(); throw new VerificationError("expired") }
    if (!this.socket || this.socket.readyState !== OPEN || this.connectionState !== ConnectionState.Connected) {
      throw new Error("OpenAxis client is not connected");
    }
    this.sendRaw(message);
  }

  private sendRaw(message: StandardMessage): void {
    if (!this.socket || this.socket.readyState !== OPEN) throw new Error("WebSocket is not open");
    this.socket.send(encode(packMessage(message)));
    this.lastSendAt = Date.now();
  }

  private decodeEvent(data: unknown) {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new ProtocolValidationError("Expected a binary WebSocket message");
    return decodeMessage(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  private handleMessage(data: unknown): void {
    try { this.dispatch(this.decodeEvent(data)); }
    catch (error) {
      if (error instanceof ProtocolValidationError && error.requestId !== undefined) {
        this.sendResponseError(error.requestId, "bad_request", error.message);
      } else emitDiagnosticLog("error", `Failed to handle OpenAxis message: ${error}`);
    }
  }

  private dispatch(message: ReturnType<typeof parseMessage>): void {
    if(this.verificationExpired()) { void this.disconnect(); return }
    switch (message.type) {
      case "response": return this.dispatchResponse(message as ResponseMessage);
      case "request": return this.dispatchRequest(message as RequestMessage);
      case "frame": return this.notify(listener => listener.onFrame?.(message as FrameMessage));
      case "buttons": return this.notify(listener => listener.onButtons?.((message as { buttons: number }).buttons));
      case "motion_start": return this.notifyLifecycle(listener => listener.onMotionStart?.((message as { gesture_id: number }).gesture_id));
      case "motion_end": return this.notifyLifecycle(listener => listener.onMotionEnd?.((message as { gesture_id: number }).gesture_id));
      case "navigation.state": return this.notifyNavigation(listener => listener.onNavigationState?.(message as NavigationStateMessage));
      case "camera.pose": return this.notifyNavigation(listener => listener.onCameraPose?.(message as CameraPoseMessage));
      case "camera.pivot": return this.notifyNavigation(listener => listener.onCameraPivot?.(message as CameraPivotMessage));
      case "object.pose": return this.notifyNavigation(listener => listener.onObjectPose?.(message as ObjectPoseMessage));
      case "object.pivot": return this.notifyNavigation(listener => listener.onObjectPivot?.(message as ObjectPivotMessage));
      case "axes": return this.notify(listener => listener.onAxes?.((message as AxesMessage).axes));
      case "error": {
        const error = message as ErrorMessage;
        return this.notify(listener => listener.onError?.(error.code, error.message));
      }
      case "hello_ack":
      case "hello":
      case "heartbeat":
      case "tags":
      case "capabilities":
      case "subscribe":
      case "motion_cancel":
      case "viewport.settled":
      case "camera.delta":
      case "object.delta":
        return;
      default:
        return this.notify(listener => listener.onExtension?.(message.type, message as WireMap));
    }
  }

  private verificationExpired(): boolean {
    return this.verificationExpiry!==undefined && (Date.now()/1000>=this.verificationExpiry || performance.now()>=this.verificationDeadline!);
  }

  private dispatchResponse(response: ResponseMessage): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.notify(listener => listener.onResponse?.(response));
      return;
    }
    this.finishPending(response.id);
    if (response.error) pending.reject(new RpcRequestError(response.error.code, response.error.message));
    else pending.resolve(response.result ?? {});
  }

  private dispatchRequest(request: RequestMessage): void {
    let query: NavigationQuery | undefined;
    const send = this.captureNavigationSender();
    try {
      let handled = false;
      if (request.method === "navigation.query") {
        query = new NavigationQuery(
          request,
          result => send({ type: "response", id: request.id, result }),
          (code, message) => send({ type: "response", id: request.id, error: { code, ...(message === undefined ? {} : { message }) } }),
        );
        const captured = query;
        handled = this.navigationOwner ? this.navigationOwner.onNavigationQuery?.(captured) === true : this.accept(listener => listener.onNavigationQuery?.(captured) === true || captured.completed);
        handled ||= query.completed;
      }
      if (!handled) handled = this.accept(listener => listener.onRequest?.(request) === true || query?.completed === true);
      if (!handled && !query?.completed) send({ type: "response", id: request.id, error: { code: "unsupported", message: `Unsupported method: ${request.method}` } });
    } catch (error) {
      if (query?.completed) return;
      const code = error instanceof ProtocolValidationError || error instanceof TypeError ? "bad_request" : "unavailable";
      send({ type: "response", id: request.id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private notify(callback: (listener: OpenAxisListener) => void): void {
    for (const listener of [...this.listeners]) {
      try { callback(listener) }
      catch (error) { emitDiagnosticLog("error", `OpenAxis listener callback failed: ${error}`) }
    }
  }

  private notifyNavigation(callback: (listener: OpenAxisListener) => void): void {
    if (this.navigationOwner) callback(this.navigationOwner);
    else this.notify(callback);
  }

  private accept(callback: (listener: OpenAxisListener) => boolean | void | undefined): boolean {
    for (const listener of [...this.listeners]) if (callback(listener) === true) return true;
    return false;
  }

  private allocateRequestId(): OpenAxisInteger {
    if (this.nextRequestId > Number.MAX_SAFE_INTEGER) throw new Error("OpenAxis request IDs exhausted");
    return this.nextRequestId++;
  }

  private notifyLifecycle(callback: (listener: OpenAxisListener) => void): void {
    const listeners = new Set([...(this.navigationOwner ? [this.navigationOwner] : []), ...this.listeners]);
    for (const listener of listeners) {
      try { callback(listener) }
      catch (error) { emitDiagnosticLog("error", `OpenAxis lifecycle listener failed: ${error}`) }
    }
  }

  private finishPending(id: OpenAxisInteger): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    return pending;
  }

  private rejectPending(error: Error): void {
    for (const id of [...this.pending.keys()]) this.finishPending(id)?.reject(error);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if(this.verificationExpired()) { void this.disconnect(); return }
      if (Date.now() - this.lastSendAt < HEARTBEAT_INTERVAL_MS) return;
      try { this.sendMessage({ type: "heartbeat" }) } catch { /* close path owns cleanup */ }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private closeSocket(): void {
    this.verificationExpiry=undefined;
    this.verificationDeadline=undefined;
    this.verificationStatus=undefined;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try { socket.close() } catch { /* already closed */ }
    }
  }

  private handleClose(): void {
    this.closeSocket();
    this.rejectPending(new Error("OpenAxis connection closed"));
    this.setState(ConnectionState.Disconnected);
  }

  private setState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.notifyLifecycle(listener => listener.onStateChange?.(state));
  }
}
