import { z } from "zod";

export type Response<T> =
  | { type: "ok"; value: T }
  | { type: "error"; error: Error };

export const SetBreakpointSchema = z.object({
  urlRegex: z
    .string()
    .describe("Regex matching the script URL (e.g. 'src/foo\\\\.ts')"),
  lineNumber: z.number().int().describe("0-based line number"),
});
export type SetBreakpointRequest = z.infer<typeof SetBreakpointSchema>;

export type SetBreakpointResponse = {
  breakpointId: string;
};

export const DebugTargetSchema = z.object({
  cwd: z.string().describe("Working directory to run the debug target in"),
  command: z.string().describe("Command used to start the debug target"),
  args: z
    .array(z.string())
    .describe(
      "Arguments used to start the debug target. Include --inspect-brk=0.",
    ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Additional environment variables for the debug target"),
});
export type DebugTargetConfig = z.infer<typeof DebugTargetSchema>;

export const ResetSessionSchema = z.object({
  target: DebugTargetSchema.describe("Debug target to start."),
});
export type ResetSessionRequest = z.infer<typeof ResetSessionSchema>;

export const PauseOnExceptionsSchema = z.object({
  state: z
    .enum(["none", "uncaught", "all"])
    .describe("Which exceptions should pause the debugger."),
});
export type PauseOnExceptionsRequest = z.infer<typeof PauseOnExceptionsSchema>;

export type PausedLocation = {
  reason?: string;
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  exception?: {
    type?: string;
    subtype?: string;
    className?: string;
    description?: string;
    objectId?: string;
  };
};

export const EvaluateSchema = z.object({
  expression: z.string().describe("JavaScript expression to evaluate"),
});
export type EvaluateRequest = z.infer<typeof EvaluateSchema>;
