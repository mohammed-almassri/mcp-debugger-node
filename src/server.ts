import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import IDebugClient from "./client/IDebugClient";
import {
  EvaluateSchema,
  PauseOnExceptionsSchema,
  ResetSessionSchema,
  Response,
  SetBreakpointSchema,
} from "./types";

const requirePackageJson = createRequire(__filename);
const packageJson = requirePackageJson("../package.json") as {
  version: string;
};

const toolResponse = (response: Response<unknown>) => {
  if (response.type === "error") {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: response.error.message,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text:
          response.value === undefined
            ? "OK"
            : JSON.stringify(response.value, null, 2),
      },
    ],
  };
};

export const createServer = (debugClient: IDebugClient): McpServer => {
  const server = new McpServer({
    name: "node-debugger",
    version: packageJson.version,
  });

  server.registerTool(
    "reset",
    {
      title: "Reset",
      description:
        "Restart the debug session with a fresh Node inspector process for the provided target.",
      inputSchema: ResetSessionSchema.shape,
    },
    async (request) => {
      return toolResponse(await debugClient.resetSession(request));
    },
  );

  server.registerTool(
    "set_breakpoint",
    {
      title: "Set breakpoint",
      description: "Set a breakpoint by matching a script URL with a regex.",
      inputSchema: SetBreakpointSchema.shape,
    },
    async (request) => {
      return toolResponse(await debugClient.setBreakpoint(request));
    },
  );

  server.registerTool(
    "stop",
    {
      title: "Stop",
      description: "Stop the current debug target and clear the debug session.",
    },
    async () => {
      return toolResponse(await debugClient.stop());
    },
  );

  server.registerTool(
    "set_pause_on_exceptions",
    {
      title: "Set pause on exceptions",
      description:
        "Configure whether the debugger pauses on no exceptions, uncaught exceptions, or all exceptions.",
      inputSchema: PauseOnExceptionsSchema.shape,
    },
    async (request) => {
      return toolResponse(await debugClient.setPauseOnExceptions(request));
    },
  );

  server.registerTool(
    "continue",
    {
      title: "Continue",
      description:
        "Resume execution of the debugged Node.js process and return immediately.",
    },
    async () => {
      return toolResponse(await debugClient.continue());
    },
  );

  server.registerTool(
    "wait_for_pause",
    {
      title: "Wait for pause",
      description:
        "Wait until the debugged Node.js process pauses and return the current location.",
    },
    async () => {
      return toolResponse(await debugClient.waitForPause());
    },
  );

  server.registerTool(
    "resume",
    {
      title: "Resume",
      description:
        "Resume execution of the debugged Node.js process and wait for the next pause.",
    },
    async () => {
      return toolResponse(await debugClient.resume());
    },
  );

  server.registerTool(
    "step_over",
    {
      title: "Step over",
      description: "Step over the current statement.",
    },
    async () => {
      return toolResponse(await debugClient.stepOver());
    },
  );

  server.registerTool(
    "step_into",
    {
      title: "Step into",
      description: "Step into the next function call.",
    },
    async () => {
      return toolResponse(await debugClient.stepInto());
    },
  );

  server.registerTool(
    "get_variables",
    {
      title: "Get variables",
      description: "Get variables for the latest paused call frame scope.",
    },
    async () => {
      return toolResponse(await debugClient.getVariables());
    },
  );

  server.registerTool(
    "evaluate",
    {
      title: "Evaluate",
      description: "Evaluate a JavaScript expression in the debugged runtime.",
      inputSchema: EvaluateSchema.shape,
    },
    async (request) => {
      return toolResponse(await debugClient.evaluate(request));
    },
  );

  return server;
};
