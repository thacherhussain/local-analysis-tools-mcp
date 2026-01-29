# AI Setup Instructions

Instructions for an AI assistant to set up the Local Analysis Tools MCP server.

**For users:** Tell your AI: _"Follow the instructions in AI-SETUP.md to configure the Local Analysis Tools MCP"_

---

## AI Instructions

You are setting up the Local Analysis Tools MCP server for Cursor. This MCP enables local linting, test coverage, and duplication checks without waiting for CI/CD.

**Important:** This file lives in the `local-analysis-tools-mcp` directory. Use that directory's absolute path for the steps below.

### Step 1: Build the Server

Run from this directory (where this AI-SETUP.md file is located):

```bash
npm install
npm run build
```

Verify that `dist/index.js` exists after the build.

### Step 2: Configure Cursor

Read the existing `~/.cursor/mcp.json` file. If it doesn't exist, create it.

Add the `local-analysis-tools` entry to `mcpServers`, using the **absolute path** to this directory's `dist/index.js`:

```json
{
  "mcpServers": {
    "local-analysis-tools": {
      "command": "node",
      "args": ["<absolute-path-to-this-directory>/dist/index.js"]
    }
  }
}
```

**Important:** Preserve any existing `mcpServers` entries—merge, don't replace.

Write the updated configuration back to `~/.cursor/mcp.json`.

### Step 3: Notify the User

Tell the user:

> Setup complete! To activate the MCP:
>
> 1. Quit Cursor completely (Cmd+Q on Mac)
> 2. Reopen Cursor
> 3. Test by asking: "Test the MCP server"
>
> If all checks pass, you're good to go.

### Step 4: Offer Next Steps

Ask the user if they'd like you to:

- Run a check on their current branch
- Check for convention violations
- Show available commands
