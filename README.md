# Local Analysis Tools MCP

An MCP server that runs ESLint, Jest coverage, and duplication checks locally using your project's own tools —- no more waiting for your CI/CD pipeline to run, no API calls needed.

## Why I Built This

I got tired of pushing code, waiting for CI to run, and then finding out I had a lint error or needed 1% more test coverage. This MCP server lets me catch those issues locally before I push using the exact same tools and configs as CI so there are no surprises.

Built with: TypeScript, Model Context Protocol SDK, Node.js

## Architecture

The MCP server is a **pure orchestration tool**. It does not bundle ESLint, Jest, or jscpd. Instead, it runs your project's tools via subprocess, ensuring:

- **Exact CI/CD parity** - Uses the same tool versions and configs as your pipeline
- **Plugin compatibility** - All your ESLint plugins work automatically
- **Independence** - The MCP works with any JavaScript/TypeScript project

## Setup

**Want AI to do this for you?** Tell your AI: _"Follow the instructions in AI-SETUP.md to configure the Local Analysis Tools MCP"_

If you want to do it the long way, you can follow the Manual Setup instructions below.

### Manual Setup

1. Build the server

```bash
git clone https://github.com/thacherhussain/local-analysis-tools-mcp.git
cd <path-to>/local-analysis-tools-mcp
npm install && npm run build

```

2. Add to Cursor's MCP config (~/.cursor/mcp.json)

```json
{
  "mcpServers": {
    "local-analysis-tools": {
      "command": "node",
      "args": ["<path-to>/local-analysis-tools-mcp/dist/index.js"]
    }
  }
}
```

3. Restart Cursor (full quit + reopen)

4. Verify that the MCP has been built correctly: ask "Test the MCP server"

### Tools Testing

After you have verified that the MCP is setup correctly. Open a repo you would like to use and ask: "check branch with the local analysis tools mcp"

## Available Tools

| Tool                | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `lint_branch`       | Lint all branch files                                            |
| `lint_local`        | Lint uncommitted/staged files                                    |
| `lint_last_commit`  | Lint files from most recent commit                               |
| `lint_files`        | Lint specific files                                              |
| `check_coverage`    | Test coverage (overall + new code %)                             |
| `check_duplication` | Find copy-pasted code                                            |
| `ai_review`         | Gather context for convention/consistency checking               |
| `check_branch`      | Run all checks on your branch (committed + uncommitted + staged) |
| `check_committed`   | Run all checks on committed changes only                         |
| `check_local`       | Run all checks on uncommitted/staged files                       |
| `test_mcp`          | Verify the MCP server is working                                 |

### Scope Options

`check_coverage` and `check_duplication` support a `scope` parameter:

- **`branch`** (default) - Check files changed on your branch vs base
- **`directory`** - Check all files in a specific directory (e.g., `packages/mobile`, `src/components`)
- **`files`** - Check specific files you provide

When using `scope: "directory"`, the tool searches for the directory in:

1. Exact path from project root (e.g., `src/components`)
2. `packages/<name>` (e.g., `mobile` → `packages/mobile`)
3. `packages/<name>/src` (e.g., `mobile` → `packages/mobile/src`)
4. `src/<name>` (e.g., `components` → `src/components`)

If the directory isn't found, you'll get a helpful error showing where it searched.

## Common Workflows

**Before pushing:**

> "Check my branch"

**Before creating a merge request:**

> "Check my committed changes"

**Quick work-in-progress check:**

> "Check my local changes"

## What the Checks Return

The combined checks (`check_branch`, `check_committed`, `check_local`) run linting, coverage, and duplication in parallel and return a summary like the following:

## Check Branch Summary

Checked **5 file(s)**: 3 committed, 1 uncommitted, 1 staged. ⏱️ _Total: 19.1s_

| Check                    | Status       | Time  | Details                    |
| ------------------------ | ------------ | ----- | -------------------------- |
| **Linting**              | ✅ No issues | 3.1s  | ESLint                     |
| **New Code Coverage**    | ✅ 92%       | 16.2s | Test coverage on new lines |
| **New Code Duplication** | ✅ 0%        | 4.8s  | Copy-pasted code           |

**Thresholds:** Linting (0 issues = pass), Coverage (≥80% = pass), Duplication (≤3% = pass)

## Performance

| Operation         | Time   |
| ----------------- | ------ |
| Lint checks       | 1-5s   |
| Full branch check | 15-45s |
| AI review context | <2s    |

Checks run in parallel. Coverage is usually the slowest (Jest needs to run tests).

## Workspace Detection

The MCP server automatically detects your project workspace using multiple strategies (in order):

1. **MCP Roots Protocol** - Requests workspace from Cursor via the MCP `roots/list` capability
2. **File Path Detection** - When you use `lint_files` with absolute paths, detects workspace from those paths
3. **WORKSPACE_PATH env var** - Explicit override in your MCP config
4. **Project Root Detection** - Walks up from current directory looking for `.git` + `package.json`
5. **Fallback** - Uses current working directory

### Overriding the Workspace

If auto-detection isn't working, you can explicitly set the workspace.

**Option 1: Using a `.env` file**

Copy `.env.example` to `.env` in the MCP server directory and set your workspace path:

```bash
cp .env.example .env
# Edit .env and set WORKSPACE_PATH
```

```env
WORKSPACE_PATH=/path/to/your/project
```

**Option 2: Using MCP config**

Set the workspace directly in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "local-analysis-tools": {
      "command": "node",
      "args": ["<path-to>/local-analysis-tools-mcp/dist/index.js"],
      "env": {
        "WORKSPACE_PATH": "/path/to/your/project"
      }
    }
  }
}
```

Run `test_mcp` to verify workspace detection - it shows the detected workspace and how it was detected.

## Troubleshooting

**MCP not loading?**

1. Verify the path in `~/.cursor/mcp.json` is correct
2. Run `npm run build` in the server directory
3. Restart Cursor completely

**Wrong workspace detected?**

- Run "Test the MCP server" to see what workspace is detected and how
- Add `WORKSPACE_PATH` env var to your MCP config to override

**ESLint/Jest errors?**

- Make sure you're in your project directory
- Run `npm install` to ensure dependencies are installed

**Slow checks?**

- Coverage is expected to be slowest (runs Jest)
- Check per-check timing in output to identify bottlenecks

---

If you find this useful or have questions, feel free to [open an issue](https://github.com/thacherhussain/local-analysis-tools-mcp/issues) or reach out on [GitHub](https://github.com/thacherhussain).

This project is licensed under the [MIT License](LICENSE).
