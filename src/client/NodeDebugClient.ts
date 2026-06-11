import { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnInspectorProcess } from "../inspector";
import {
  DebugTargetConfig,
  EvaluateRequest,
  PauseOnExceptionsRequest,
  PausedLocation,
  Response,
  ResetSessionRequest,
  SetBreakpointRequest,
  SetBreakpointResponse,
} from "../types";
import WsClient from "../ws-client/WsClient";
import IDebugClient from "./IDebugClient";

const PAUSE_TIMEOUT_MS = 10_000;

type PauseWaiter = {
  resolve: (value: PausedLocation) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

type DebuggerPausedParams = {
  reason?: string;
  data?: {
    type?: string;
    subtype?: string;
    className?: string;
    description?: string;
    objectId?: string;
  };
  callFrames?: Array<{
    functionName?: string;
    url?: string;
    location?: {
      scriptId?: string;
      lineNumber?: number;
      columnNumber?: number;
    };
    scopeChain?: Array<{
      type?: string;
      object?: {
        objectId?: string;
      };
    }>;
  }>;
};

type ResetSessionResponse = {
  inspectorUrl: string;
  target: DebugTargetConfig;
};

type InspectorMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export default class NodeDebugClient implements IDebugClient {
  private pauseOnExceptions: PauseOnExceptionsRequest["state"] = "uncaught";
  private target: DebugTargetConfig | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ws: WsClient | null = null;
  private nextId = 1;
  private paused = false;
  private latestPausedLocation: PausedLocation | null = null;
  private latestCallFrameId: string | null = null;
  private latestScopeObjectId: string | null = null;
  private pauseWaiters: PauseWaiter[] = [];
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >();

  static create(): NodeDebugClient {
    return new NodeDebugClient();
  }

  async resetSession(
    request: ResetSessionRequest,
  ): Promise<Response<ResetSessionResponse>> {
    try {
      await this.stopSession();
      const target = request.target;
      this.target = target;
      const inspectorUrl = await this.start();

      return {
        type: "ok",
        value: { inspectorUrl, target },
      };
    } catch (err) {
      return {
        type: "error",
        error: err as Error,
      };
    }
  }

  async stop(): Promise<Response<unknown>> {
    try {
      await this.stopSession();

      return {
        type: "ok",
        value: {},
      };
    } catch (err) {
      return {
        type: "error",
        error: err as Error,
      };
    }
  }

  async init() {
    await this.send("Debugger.enable");
    await this.send("Debugger.setPauseOnExceptions", {
      state: this.pauseOnExceptions,
    });
    await this.send("Runtime.enable");
    await this.send("Debugger.setSkipAllPauses", { skip: false });

    const initialPause = this.waitForNextPause();
    const run = await this.send("Runtime.runIfWaitingForDebugger");
    if (run.type === "error") {
      initialPause.cancel();
      throw run.error;
    }

    await initialPause.promise;
  }

  private async start(): Promise<string> {
    if (this.target === null) {
      throw new Error("Cannot start debug session without a target.");
    }

    const inspector = await spawnInspectorProcess(this.target);
    let ws: WsClient | null = null;

    try {
      ws = new WsClient(inspector.url);
      await ws.connect();

      this.child = inspector.child;
      this.ws = ws;
      this.registerWsHandlers(ws);
      this.clearRuntimeState();
      await this.init();

      return inspector.url;
    } catch (err) {
      ws?.close();
      this.ws = null;
      this.child = null;
      this.clearRuntimeState();
      this.rejectPauseWaiters(new Error("Debug session failed to start."));
      this.rejectPendingRequests(new Error("Debug session failed to start."));
      await this.killChild(inspector.child);
      throw err;
    }
  }

  private async stopSession(): Promise<void> {
    this.ws?.close();
    this.ws = null;

    this.clearRuntimeState();
    this.rejectPauseWaiters(new Error("Debug session was reset."));
    this.rejectPendingRequests(new Error("Debug session was reset."));

    if (this.child === null) {
      return;
    }

    const child = this.child;
    this.child = null;

    await this.killChild(child);
  }

  private async killChild(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      child.kill();
    });
  }

  private registerWsHandlers(ws: WsClient): void {
    ws.onMessage((data) => this.onMessage(data));
    ws.onError((error) => {
      if (this.ws !== ws) {
        return;
      }

      this.rejectPauseWaiters(error);
      this.rejectPendingRequests(error);
    });
    ws.onClose(() => {
      if (this.ws !== ws) {
        return;
      }

      this.clearRuntimeState();
      this.rejectPauseWaiters(
        new Error("WebSocket closed while waiting for pause."),
      );
      this.rejectPendingRequests(new Error("WebSocket closed."));
    });
  }

  async setBreakpoint(
    request: SetBreakpointRequest,
  ): Promise<Response<SetBreakpointResponse>> {
    return this.send("Debugger.setBreakpointByUrl", request);
  }

  async setPauseOnExceptions(
    request: PauseOnExceptionsRequest,
  ): Promise<Response<unknown>> {
    this.pauseOnExceptions = request.state;

    if (!this.hasActiveSession()) {
      return {
        type: "ok",
        value: { state: this.pauseOnExceptions },
      };
    }

    return this.send("Debugger.setPauseOnExceptions", {
      state: this.pauseOnExceptions,
    });
  }

  async continue(): Promise<Response<unknown>> {
    if (!this.hasActiveSession()) {
      return this.sessionNotInitializedResponse();
    }

    if (!this.paused) {
      return this.errorResponse(
        "Cannot continue because the target is not paused.",
      );
    }

    return this.send("Debugger.resume");
  }

  async waitForPause(): Promise<Response<PausedLocation>> {
    if (!this.hasActiveSession()) {
      return this.sessionNotInitializedResponse();
    }

    if (this.paused) {
      if (this.latestPausedLocation === null) {
        return this.errorResponse(
          "The target is paused, but no location is available.",
        );
      }

      return {
        type: "ok",
        value: this.latestPausedLocation,
      };
    }

    try {
      return {
        type: "ok",
        value: await this.waitForNextPause().promise,
      };
    } catch (err) {
      return {
        type: "error",
        error: err as Error,
      };
    }
  }

  async resume(): Promise<Response<PausedLocation>> {
    if (!this.hasActiveSession()) {
      return this.sessionNotInitializedResponse();
    }

    if (!this.paused) {
      return this.errorResponse(
        "Cannot resume because the target is not paused.",
      );
    }

    return this.continueUntilPaused("Debugger.resume");
  }

  async stepOver(): Promise<Response<PausedLocation>> {
    if (!this.hasActiveSession()) {
      return this.sessionNotInitializedResponse();
    }

    if (!this.paused) {
      return this.errorResponse(
        "Cannot step over because the target is not paused.",
      );
    }

    return this.continueUntilPaused("Debugger.stepOver");
  }

  async stepInto(): Promise<Response<PausedLocation>> {
    if (!this.hasActiveSession()) {
      return this.sessionNotInitializedResponse();
    }

    if (!this.paused) {
      return this.errorResponse(
        "Cannot step into because the target is not paused.",
      );
    }

    return this.continueUntilPaused("Debugger.stepInto");
  }

  async getVariables(): Promise<Response<unknown>> {
    if (!this.hasActiveSession()) {
      return this.sessionNotInitializedResponse();
    }

    if (this.latestScopeObjectId === null) {
      return this.errorResponse(
        "No scope object is available. Wait until the debugger is paused before calling getvariables.",
      );
    }

    return this.send("Runtime.getProperties", {
      objectId: this.latestScopeObjectId,
      ownProperties: true,
    });
  }

  async evaluate(request: EvaluateRequest): Promise<Response<unknown>> {
    if (!this.hasActiveSession()) {
      return this.sessionNotInitializedResponse();
    }

    if (this.latestCallFrameId === null) {
      return this.errorResponse(
        "No call frame is available. Wait until the debugger is paused before calling evaluate.",
      );
    }

    return this.send("Debugger.evaluateOnCallFrame", {
      callFrameId: this.latestCallFrameId,
      expression: request.expression,
    });
  }

  private errorResponse<T>(message: string): Response<T> {
    return {
      type: "error",
      error: new Error(message),
    };
  }

  private hasActiveSession(): boolean {
    return this.ws !== null;
  }

  private sessionNotInitializedResponse<T>(): Response<T> {
    return this.errorResponse(
      "Debug session has not been initialized. Call reset with a target first.",
    );
  }

  private async continueUntilPaused(
    method: string,
  ): Promise<Response<PausedLocation>> {
    const pause = this.waitForNextPause();
    const command = await this.send(method);

    if (command.type === "error") {
      pause.cancel();
      return command;
    }

    try {
      return {
        type: "ok",
        value: await pause.promise,
      };
    } catch (err) {
      return {
        type: "error",
        error: err as Error,
      };
    }
  }

  private waitForNextPause(): {
    promise: Promise<PausedLocation>;
    cancel: () => void;
  } {
    let waiter: PauseWaiter;

    const promise = new Promise<PausedLocation>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pauseWaiters = this.pauseWaiters.filter((item) => item !== waiter);
        reject(new Error("Timed out waiting for the next debugger pause."));
      }, PAUSE_TIMEOUT_MS);

      waiter = { resolve, reject, timeout };
      this.pauseWaiters.push(waiter);
    });

    return {
      promise,
      cancel: () => {
        clearTimeout(waiter.timeout);
        this.pauseWaiters = this.pauseWaiters.filter((item) => item !== waiter);
      },
    };
  }

  private async send<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Response<T>> {
    if (this.ws === null) {
      return this.sessionNotInitializedResponse();
    }

    const id = this.nextId++;
    const payload =
      params === undefined ? { id, method } : { id, method, params };
    const ws = this.ws;

    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(payload));
      });

      return {
        type: "ok",
        value: value as T,
      };
    } catch (err) {
      return {
        type: "error",
        error: err as Error,
      };
    }
  }

  private onMessage(text: string) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }

    const message: InspectorMessage = {
      id: typeof parsed.id === "number" ? parsed.id : undefined,
      method: typeof parsed.method === "string" ? parsed.method : undefined,
      params: parsed.params,
      result: parsed.result,
      error: parsed.error,
    };

    if (message.method !== undefined) {
      this.onNotification(message.method, message.params);
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if (message.error) {
      const err = message.error as { message?: string; code?: number };
      pending.reject(new Error(err.message ?? JSON.stringify(message.error)));
      return;
    }

    pending.resolve(message.result);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "Debugger.paused") {
      this.paused = true;
      this.latestPausedLocation = this.parsePausedLocation(params);
      this.latestCallFrameId = this.parseLatestCallFrameId(params);
      this.latestScopeObjectId = this.parseLatestScopeObjectId(params);
      this.resolvePauseWaiters(this.latestPausedLocation);
      return;
    }

    if (method === "Debugger.resumed") {
      this.paused = false;
      this.latestPausedLocation = null;
      this.latestCallFrameId = null;
      this.latestScopeObjectId = null;
      return;
    }

    if (method === "Runtime.executionContextDestroyed") {
      this.paused = false;
      this.latestPausedLocation = null;
      this.latestCallFrameId = null;
      this.latestScopeObjectId = null;
      this.rejectPauseWaiters(
        new Error("Runtime ended before the debugger paused again."),
      );
    }
  }

  private resolvePauseWaiters(location: PausedLocation): void {
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(location);
    }
  }

  private rejectPauseWaiters(error: Error): void {
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  private rejectPendingRequests(error: Error): void {
    const pending = this.pending;
    this.pending = new Map();

    for (const request of pending.values()) {
      request.reject(error);
    }
  }

  private clearRuntimeState(): void {
    this.paused = false;
    this.latestPausedLocation = null;
    this.latestCallFrameId = null;
    this.latestScopeObjectId = null;
  }

  private parsePausedLocation(params: unknown): PausedLocation {
    const pausedParams = params as DebuggerPausedParams;
    const frame = pausedParams.callFrames?.[0];
    const exception =
      pausedParams.reason === "exception" && pausedParams.data !== undefined
        ? {
            type: pausedParams.data.type,
            subtype: pausedParams.data.subtype,
            className: pausedParams.data.className,
            description: pausedParams.data.description,
            objectId: pausedParams.data.objectId,
          }
        : undefined;

    return {
      reason: pausedParams.reason,
      functionName: frame?.functionName ?? "",
      scriptId: frame?.location?.scriptId ?? "",
      url: frame?.url ?? "",
      lineNumber: frame?.location?.lineNumber ?? 0,
      columnNumber: frame?.location?.columnNumber ?? 0,
      exception,
    };
  }

  private parseLatestScopeObjectId(params: unknown): string | null {
    const pausedParams = params as DebuggerPausedParams;
    const frame = pausedParams.callFrames?.[0];

    return frame?.scopeChain?.[0]?.object?.objectId ?? null;
  }

  private parseLatestCallFrameId(params: unknown): string | null {
    const pausedParams = params as DebuggerPausedParams;
    const frame = pausedParams.callFrames?.[0] as
      | { callFrameId?: string }
      | undefined;

    return frame?.callFrameId ?? null;
  }
}
