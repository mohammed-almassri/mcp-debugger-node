import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { DebugTargetConfig } from "./types";

const INSPECTOR_URL_PATTERN = /\bws:\/\/[^\s]+/;
const INSPECTOR_STARTUP_TIMEOUT_MS = 10_000;

export const parseInspectorUrl = (output: string): string | null => {
  return output.match(INSPECTOR_URL_PATTERN)?.[0] ?? null;
};

export type InspectorProcess = {
  child: ChildProcessWithoutNullStreams;
  url: string;
};

export const spawnInspectorProcess = (
  target: DebugTargetConfig,
): Promise<InspectorProcess> => {
  return new Promise((resolve, reject) => {
    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      env:
        target.env === undefined
          ? process.env
          : { ...process.env, ...target.env },
    });

    let stderr = "";
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      child.kill();
      settle(() => {
        reject(
          new Error("Timed out waiting for Node inspector URL on stderr."),
        );
      });
    }, INSPECTOR_STARTUP_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      // Keep stdout attached so the child cannot block on a full pipe.
      data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      if (settled) {
        return;
      }

      stderr += data.toString();

      const inspectorUrl = parseInspectorUrl(stderr);
      if (inspectorUrl) {
        settle(() => {
          resolve({ child, url: inspectorUrl });
        });
      }
    });

    child.on("error", (error) => {
      settle(() => {
        reject(
          new Error(`Failed to start inspector process: ${error.message}`),
        );
      });
    });

    child.on("close", (code, signal) => {
      settle(() => {
        const reason =
          signal === null ? `exit code ${code}` : `signal ${signal}`;
        reject(
          new Error(
            `Inspector process closed before reporting a URL (${reason}) while running ${target.command} ${target.args.join(" ")} in ${target.cwd}.\n${stderr.trim()}`,
          ),
        );
      });
    });
  });
};
