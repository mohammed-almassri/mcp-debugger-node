# mcp-debugger-node

[![npm version](https://img.shields.io/npm/v/mcp-debugger-node.svg)](https://www.npmjs.com/package/mcp-debugger-node)
[![npm beta](https://img.shields.io/npm/v/mcp-debugger-node/beta.svg?label=beta)](https://www.npmjs.com/package/mcp-debugger-node)
[![npm downloads](https://img.shields.io/npm/dm/mcp-debugger-node.svg)](https://www.npmjs.com/package/mcp-debugger-node)
[![CI](https://github.com/mohammed-almassri/mcp-debugger-node/actions/workflows/ci.yml/badge.svg)](https://github.com/mohammed-almassri/mcp-debugger-node/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/mcp-debugger-node.svg)](LICENSE)

MCP server for debugging Node.js programs through the V8 Inspector Protocol.

This server gives an AI agent debugger-style tools: start a Node process under
`--inspect-brk`, set breakpoints, continue execution, wait for pauses, step,
inspect variables, and evaluate expressions in the current call frame.

> [!WARNING]
> This server starts whatever command is provided in the `reset` target config.
> Only use it in trusted local development environments. A target config can run
> arbitrary commands with your user permissions.

## Run

This package is meant to be started by an MCP client over stdio:

```bash
npx -y mcp-debugger-node@beta
```

You usually do not run that command by hand. Instead, add it to your agent or
editor MCP configuration.

The project is still in beta, so `@beta` is recommended until the first stable
`1.0.0` release.

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.node-debugger]
command = "npx"
args = ["-y", "mcp-debugger-node@beta"]
```

### Claude Code

Use the Claude Code MCP CLI:

```bash
claude mcp add node-debugger -- npx -y mcp-debugger-node@beta
```

For a project-local config, run that command from the project you want to
configure.

### GitHub Copilot in VS Code

Create or update `.vscode/mcp.json`:

```json
{
  "servers": {
    "node-debugger": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-debugger-node@beta"]
    }
  }
}
```

### Other MCP Clients

Use a stdio server entry with:

```json
{
  "command": "npx",
  "args": ["-y", "mcp-debugger-node@beta"]
}
```

## Quick Start

Start a debug session by calling `reset` with an explicit target:

```json
{
  "target": {
    "cwd": "/path/to/project",
    "command": "node",
    "args": ["--inspect-brk=0", "server.js"]
  }
}
```

For a CommonJS TypeScript project using `ts-node`:

```json
{
  "target": {
    "cwd": "/path/to/project",
    "command": "node",
    "args": ["--inspect-brk=0", "-r", "ts-node/register", "src/index.ts"]
  }
}
```

For an ESM TypeScript project:

```json
{
  "target": {
    "cwd": "/path/to/project",
    "command": "node",
    "args": ["--inspect-brk=0", "--loader", "ts-node/esm", "src/index.ts"]
  }
}
```

The target must include `--inspect-brk=0`. The server reads the inspector URL
from the target process stderr and connects to it.

## Common Workflow

For simple scripts:

1. Call `reset` with a target.
2. Call `set_breakpoint`.
3. Call `resume`.
4. Call `get_variables` or `evaluate`.
5. Use `step_over` or `step_into` as needed.

For event-driven servers:

1. Call `reset` with a target.
2. Call `set_breakpoint` in the endpoint or handler.
3. Call `continue`.
4. Trigger the event with curl, a browser, a test runner, or another tool.
5. Call `wait_for_pause`.
6. Inspect runtime state with `get_variables` and `evaluate`.
7. Call `continue` again to let the request finish.

Example endpoint debugging flow:

```json
{
  "urlRegex": "server\\.js$",
  "lineNumber": 42
}
```

Then:

```text
continue
curl http://localhost:3000/api/users
wait_for_pause
evaluate {"expression":"req.url"}
get_variables
continue
```

## Tools

### `reset`

Restart the debug session with a fresh Node inspector process.

Input:

```json
{
  "target": {
    "cwd": "/path/to/project",
    "command": "node",
    "args": ["--inspect-brk=0", "server.js"],
    "env": {
      "NODE_ENV": "development"
    }
  }
}
```

`env` is optional and is merged with the MCP server environment.

### `set_breakpoint`

Set a breakpoint by matching a script URL with a regex.

Input:

```json
{
  "urlRegex": "server\\.js$",
  "lineNumber": 10
}
```

`lineNumber` is zero-based, matching the Chrome DevTools Protocol.

### `set_pause_on_exceptions`

Configure exception pause behavior.

Input:

```json
{
  "state": "uncaught"
}
```

Allowed states:

- `none`
- `uncaught`
- `all`

The default is `uncaught`.

### `continue`

Resume execution and return immediately.

Use this when some external action needs to trigger the breakpoint, such as a
curl request or browser interaction.

### `wait_for_pause`

Wait until the debugged process pauses and return the current location.

Useful after `continue` when another tool is triggering the application.

### `resume`

Resume execution and wait for the next pause.

This is convenient for scripts where the next pause will happen without an
external trigger.

### `step_over`

Step over the current statement and wait for the next pause.

### `step_into`

Step into the next function call and wait for the next pause.

### `get_variables`

Get variables for the latest paused call frame scope.

### `evaluate`

Evaluate JavaScript in the latest paused call frame.

Input:

```json
{
  "expression": "JSON.stringify(req.body)"
}
```

## Exception Reporting

The debugger pauses on uncaught exceptions by default. When an exception pause
happens, the pause result includes exception metadata:

```json
{
  "reason": "exception",
  "lineNumber": 8,
  "columnNumber": 3,
  "exception": {
    "className": "Error",
    "description": "Error: file is not a database ..."
  }
}
```

This lets agents diagnose startup crashes and runtime failures without reading
server logs.
