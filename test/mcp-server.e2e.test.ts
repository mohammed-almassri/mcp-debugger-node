import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type E2ESession = {
  client: Client;
  transport: StdioClientTransport;
};

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

type PauseResult = {
  reason?: string;
  functionName: string;
  lineNumber: number;
  exception?: {
    className?: string;
    description?: string;
  };
};

const fixturePath = (name: string): string =>
  resolve(__dirname, "fixtures", name);

const fixtureTarget = (name: string) => ({
  cwd: resolve(__dirname, ".."),
  command: "node",
  args: ["--inspect-brk=0", fixturePath(name)],
});

const firstText = (result: ToolResult): string => {
  const content = result.content[0];

  if (content?.type !== "text") {
    throw new Error("Expected first tool result content item to be text.");
  }

  return content.text;
};

const parseToolJson = <T>(result: ToolResult): T =>
  JSON.parse(firstText(result)) as T;

const propertyValue = (
  response: unknown,
  name: string,
): string | number | boolean | undefined => {
  const properties = (response as {
    result?: Array<{
      name?: string;
      value?: { value?: string | number | boolean };
    }>;
  }).result;

  return properties?.find((property) => property.name === name)?.value?.value;
};

const callJsonTool = async <T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> =>
  parseToolJson<T>(
    await client.callTool({
      name,
      arguments: args,
    }),
  );

const callTextTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> =>
  firstText(
    await client.callTool({
      name,
      arguments: args,
    }),
  );

const startServer = async (): Promise<E2ESession> => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve(__dirname, "..", "dist", "index.js")],
    cwd: resolve(__dirname, ".."),
    stderr: "pipe",
  });
  const client = new Client({
    name: "node-debugger-e2e-test",
    version: "0.0.0",
  });

  await client.connect(transport);

  return { client, transport };
};

describe("MCP server e2e", () => {
  let session: E2ESession | null = null;

  const createSession = async (): Promise<E2ESession> => {
    session = await startServer();
    return session;
  };

  const resetToFixture = async (
    client: Client,
    name: string,
  ): Promise<{ inspectorUrl: string; target: ReturnType<typeof fixtureTarget> }> =>
    callJsonTool(client, "reset", { target: fixtureTarget(name) });

  const pauseAtSimpleScriptBreakpoint = async (
    client: Client,
  ): Promise<void> => {
    await resetToFixture(client, "simple-script.js");
    await callJsonTool(client, "set_breakpoint", {
      urlRegex: "simple-script\\.js$",
      lineNumber: 5,
    });
    await callJsonTool(client, "resume");
  };

  const pauseAtFunctionCallBreakpoint = async (
    client: Client,
  ): Promise<void> => {
    await resetToFixture(client, "function-call.js");
    await callJsonTool(client, "set_breakpoint", {
      urlRegex: "function-call\\.js$",
      lineNumber: 6,
    });
    await callJsonTool(client, "resume");
  };

  afterEach(async () => {
    if (session !== null) {
      await session.client.close();
      session = null;
    }
  });

  it("exposes the debugger tools over stdio", async () => {
    const { client } = await createSession();

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "continue",
      "evaluate",
      "get_variables",
      "reset",
      "resume",
      "set_breakpoint",
      "set_pause_on_exceptions",
      "step_into",
      "step_over",
      "stop",
      "wait_for_pause",
    ]);
  });

  it("reset starts a debug target and returns the inspector URL", async () => {
    const { client } = await createSession();

    const reset = await resetToFixture(client, "long-running.js");

    expect(reset.target).toEqual(fixtureTarget("long-running.js"));
    expect(reset.inspectorUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//);
  });

  it("set_breakpoint binds a breakpoint by URL regex", async () => {
    const { client } = await createSession();
    await resetToFixture(client, "simple-script.js");

    const breakpoint = await callJsonTool<{ breakpointId: string }>(
      client,
      "set_breakpoint",
      {
        urlRegex: "simple-script\\.js$",
        lineNumber: 5,
      },
    );

    expect(breakpoint.breakpointId).toContain("simple-script");
  });

  it("stop stops the debug target and clears the session", async () => {
    const { client } = await createSession();
    await resetToFixture(client, "long-running.js");

    expect(await callTextTool(client, "stop")).toBe("{}");

    const result = await client.callTool({
      name: "evaluate",
      arguments: { expression: "process.pid" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Call reset with a target first");
  });

  it("set_pause_on_exceptions configures exception pause behavior", async () => {
    const { client } = await createSession();

    await callJsonTool(client, "set_pause_on_exceptions", { state: "all" });
    await resetToFixture(client, "startup-exception.js");

    const pause = await callJsonTool<PauseResult>(client, "resume");
    expect(pause.reason).toBe("exception");
    expect(pause.exception?.className).toBe("Error");
    expect(pause.exception?.description).toContain("fixture startup failure");
  });

  it("continue resumes the debug target and returns immediately", async () => {
    const { client } = await createSession();
    await resetToFixture(client, "long-running.js");

    expect(await callTextTool(client, "continue")).toBe("{}");

    const result = await client.callTool({
      name: "continue",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("paused");
  });

  it("wait_for_pause returns the current paused location", async () => {
    const { client } = await createSession();
    await resetToFixture(client, "long-running.js");

    const pause = await callJsonTool<PauseResult>(client, "wait_for_pause");

    expect(pause.reason).toBe("Break on start");
    expect(pause.lineNumber).toBe(0);
  });

  it("resume resumes execution and waits for the next pause", async () => {
    const { client } = await createSession();
    await resetToFixture(client, "simple-script.js");
    await callJsonTool(client, "set_breakpoint", {
      urlRegex: "simple-script\\.js$",
      lineNumber: 5,
    });

    const pause = await callJsonTool<PauseResult>(client, "resume");

    expect(pause.reason).toBe("other");
    expect(pause.lineNumber).toBe(5);
  });

  it("step_over steps over the current statement", async () => {
    const { client } = await createSession();
    await pauseAtSimpleScriptBreakpoint(client);

    const pause = await callJsonTool<PauseResult>(client, "step_over");

    expect(pause.reason).toBe("step");
    expect(pause.lineNumber).toBe(7);
  });

  it("step_into steps into the next function call", async () => {
    const { client } = await createSession();
    await pauseAtFunctionCallBreakpoint(client);

    const pause = await callJsonTool<PauseResult>(client, "step_into");

    expect(pause.reason).toBe("step");
    expect(pause.functionName).toBe("double");
  });

  it("get_variables reads the latest paused scope", async () => {
    const { client } = await createSession();
    await pauseAtFunctionCallBreakpoint(client);
    await callJsonTool(client, "step_into");
    await callJsonTool(client, "step_over");

    const variables = await callJsonTool<unknown>(client, "get_variables");

    expect(propertyValue(variables, "value")).toBe(21);
    expect(propertyValue(variables, "result")).toBe(42);
  });

  it("evaluate evaluates an expression on the current call frame", async () => {
    const { client } = await createSession();
    await pauseAtSimpleScriptBreakpoint(client);

    const evaluated = await callJsonTool<{ result?: { value?: string } }>(
      client,
      "evaluate",
      { expression: "JSON.stringify(arr)" },
    );

    expect(evaluated.result?.value).toBe("[10,20,30]");
  });
});
