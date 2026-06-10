import {
  EvaluateRequest,
  PauseOnExceptionsRequest,
  PausedLocation,
  Response,
  ResetSessionRequest,
  SetBreakpointRequest,
  SetBreakpointResponse,
} from "../types";

export default interface IDebugClient {
  resetSession(request: ResetSessionRequest): Promise<Response<unknown>>;
  stop(): Promise<Response<unknown>>;
  setBreakpoint(
    request: SetBreakpointRequest,
  ): Promise<Response<SetBreakpointResponse>>;
  setPauseOnExceptions(
    request: PauseOnExceptionsRequest,
  ): Promise<Response<unknown>>;
  continue(): Promise<Response<unknown>>;
  waitForPause(): Promise<Response<PausedLocation>>;
  resume(): Promise<Response<PausedLocation>>;
  stepOver(): Promise<Response<PausedLocation>>;
  stepInto(): Promise<Response<PausedLocation>>;
  getVariables(): Promise<Response<unknown>>;
  evaluate(request: EvaluateRequest): Promise<Response<unknown>>;
}
