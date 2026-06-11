import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import NodeDebugClient from "../src/client/NodeDebugClient";
import { Response } from "../src/types";

const fixturePath = (name: string): string =>
  resolve(__dirname, "fixtures", name);

const fixtureTarget = (name: string) => ({
  cwd: resolve(__dirname, ".."),
  command: "node",
  args: ["--inspect-brk=0", fixturePath(name)],
});

const unwrap = <T>(response: Response<T>): T => {
  if (response.type === "error") {
    throw response.error;
  }

  return response.value;
};

const textValue = (response: unknown): string | undefined =>
  (response as { result?: { value?: string } }).result?.value;

const numberValue = (response: unknown): number | undefined =>
  (response as { result?: { value?: number } }).result?.value;

const propertyValue = (
  response: unknown,
  name: string,
): string | number | boolean | undefined => {
  const properties = (
    response as {
      result?: Array<{
        name?: string;
        value?: { value?: string | number | boolean };
      }>;
    }
  ).result;

  return properties?.find((property) => property.name === name)?.value?.value;
};

describe("NodeDebugClient integration", () => {
  let client: NodeDebugClient | null = null;

  const createClient = (): NodeDebugClient => {
    client = NodeDebugClient.create();
    return client;
  };

  const resetToFixture = async (
    name: string,
  ): Promise<Awaited<ReturnType<NodeDebugClient["resetSession"]>>> => {
    const debugClient = client ?? createClient();

    return debugClient.resetSession({
      target: fixtureTarget(name),
    });
  };

  const pauseAtSimpleScriptBreakpoint = async (): Promise<NodeDebugClient> => {
    const debugClient = createClient();
    unwrap(await resetToFixture("simple-script.js"));
    unwrap(
      await debugClient.setBreakpoint({
        urlRegex: "simple-script\\.js$",
        lineNumber: 5,
      }),
    );
    unwrap(await debugClient.resume());

    return debugClient;
  };

  const pauseAtFunctionCallBreakpoint = async (): Promise<NodeDebugClient> => {
    const debugClient = createClient();
    unwrap(await resetToFixture("function-call.js"));
    unwrap(
      await debugClient.setBreakpoint({
        urlRegex: "function-call\\.js$",
        lineNumber: 6,
      }),
    );
    unwrap(await debugClient.resume());

    return debugClient;
  };

  afterEach(async () => {
    if (client !== null) {
      await client.stop();
      client = null;
    }
  });

  it("resetSession starts a target and returns the inspector URL", async () => {
    const debugClient = createClient();

    const result = unwrap(await resetToFixture("long-running.js"));

    expect(result).toMatchObject({
      target: fixtureTarget("long-running.js"),
    });
    expect(result.inspectorUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//);
    expect(unwrap(await debugClient.waitForPause()).reason).toBe(
      "Break on start",
    );
  });

  it("stop stops the active target and clears the session", async () => {
    const debugClient = createClient();
    unwrap(await resetToFixture("long-running.js"));

    unwrap(await debugClient.stop());

    const result = await debugClient.evaluate({ expression: "process.pid" });
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error.message).toContain("Call reset with a target first");
    }
  });

  it("setBreakpoint binds a breakpoint by URL regex", async () => {
    const debugClient = createClient();
    unwrap(await resetToFixture("simple-script.js"));

    const breakpoint = unwrap(
      await debugClient.setBreakpoint({
        urlRegex: "simple-script\\.js$",
        lineNumber: 5,
      }),
    );

    expect(breakpoint.breakpointId).toContain("simple-script");
  });

  it("setPauseOnExceptions configures startup exception pauses", async () => {
    const debugClient = createClient();

    unwrap(await debugClient.setPauseOnExceptions({ state: "all" }));
    unwrap(await resetToFixture("startup-exception.js"));

    const pause = unwrap(await debugClient.resume());
    expect(pause.reason).toBe("exception");
    expect(pause.exception?.className).toBe("Error");
    expect(pause.exception?.description).toContain("fixture startup failure");
  });

  it("continue resumes execution and returns immediately", async () => {
    const debugClient = createClient();
    unwrap(await resetToFixture("long-running.js"));

    unwrap(await debugClient.continue());

    const secondContinue = await debugClient.continue();
    expect(secondContinue.type).toBe("error");
    if (secondContinue.type === "error") {
      expect(secondContinue.error.message).toContain("paused");
    }
  });

  it("waitForPause returns the current pause when already paused", async () => {
    const debugClient = createClient();
    unwrap(await resetToFixture("long-running.js"));

    const pause = unwrap(await debugClient.waitForPause());

    expect(pause.reason).toBe("Break on start");
    expect(pause.lineNumber).toBe(0);
  });

  it("resume resumes execution and waits for the next pause", async () => {
    const debugClient = createClient();
    unwrap(await resetToFixture("simple-script.js"));
    unwrap(
      await debugClient.setBreakpoint({
        urlRegex: "simple-script\\.js$",
        lineNumber: 5,
      }),
    );

    const pause = unwrap(await debugClient.resume());

    expect(pause.reason).toBe("other");
    expect(pause.lineNumber).toBe(5);
  });

  it("stepOver steps over the current statement and returns the next pause", async () => {
    const debugClient = await pauseAtSimpleScriptBreakpoint();

    const pause = unwrap(await debugClient.stepOver());

    expect(pause.reason).toBe("step");
    expect(pause.lineNumber).toBe(7);
  });

  it("stepInto steps into the next function call", async () => {
    const debugClient = await pauseAtFunctionCallBreakpoint();

    const pause = unwrap(await debugClient.stepInto());

    expect(pause.reason).toBe("step");
    expect(pause.functionName).toBe("double");
  });

  it("getVariables reads variables from the latest paused scope", async () => {
    const debugClient = await pauseAtFunctionCallBreakpoint();
    unwrap(await debugClient.stepInto());
    unwrap(await debugClient.stepOver());

    const variables = unwrap(await debugClient.getVariables());

    expect(propertyValue(variables, "value")).toBe(21);
    expect(propertyValue(variables, "result")).toBe(42);
  });

  it("evaluate evaluates an expression on the latest paused call frame", async () => {
    const debugClient = await pauseAtSimpleScriptBreakpoint();

    const arr = unwrap(
      await debugClient.evaluate({ expression: "JSON.stringify(arr)" }),
    );

    expect(textValue(arr)).toBe("[10,20,30]");

    unwrap(await debugClient.stepOver());
    const doubled = unwrap(
      await debugClient.evaluate({ expression: "doubled.length" }),
    );

    expect(numberValue(doubled)).toBe(3);
  });
});
