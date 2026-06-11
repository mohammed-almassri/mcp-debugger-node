#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import NodeDebugClient from "./client/NodeDebugClient";
import { createServer } from "./server";

void (async () => {
  let debugClient: NodeDebugClient | null = null;
  let shuttingDown = false;

  const shutdown = async (exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await debugClient?.stop();
    process.exit(exitCode);
  };

  try {
    debugClient = NodeDebugClient.create();
    const server = createServer(debugClient);

    process.once("SIGINT", () => {
      void shutdown(0);
    });
    process.once("SIGTERM", () => {
      void shutdown(0);
    });
    process.stdin.once("close", () => {
      void shutdown(0);
    });

    const transport = new StdioServerTransport();
    server
      .connect(transport)
      .then(() => {})
      .catch((error: Error) => {
        console.error(error);
        void shutdown(1);
      });
  } catch (error) {
    console.error(error);
    await shutdown(1);
  }
})();
