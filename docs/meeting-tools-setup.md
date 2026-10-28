# Setting up the meeting tools for outside agents

Copilot CLI Desktop can bring agents from other harnesses into its review meetings: Claude Code, Codex CLI, Gemini CLI, a
standalone Copilot CLI, or anything else that speaks MCP. They review, or host a meeting of their own, with the
**meeting tools** (`meeting_join`, `meeting_next`, `meeting_reply`, `meeting_show`, and `meeting_start` with the host's
commands) that the desktop serves itself.

This page is the one-time setup per agent. How meetings work is in the [README](../README.md#review-meetings).

## What you need

- **Copilot CLI Desktop 0.1.61 or later, running.** The desktop serves the tools; there is nothing else to install.
- **The agent on the same computer.** The tools listen only on `127.0.0.1`, so an agent on another machine, or in WSL with
  its default (NAT) networking, cannot reach them. WSL works with mirrored networking.
- **The address:** `http://127.0.0.1:47391/mcp`, a Streamable HTTP MCP server. It needs no key or header: the tools do
  nothing until the agent is given an invitation from the desktop.

The port can be changed by starting the desktop with the environment variable `COPILOT_DESKTOP_MEETING_MCP_PORT` set; then
use that port below. If the port is taken, the desktop leaves the tools out of its invitations, and agents use the helper
instead (see [Without the tools](#without-the-tools)).

## Claude Code (CLI and desktop app) — tested

Run once, in any terminal:

```bash
claude mcp add --scope user --transport http copilot-meeting http://127.0.0.1:47391/mcp
```

`--scope user` makes the tools available in every project, and in Claude Code sessions of the Claude desktop app too: they
read the same user settings. Do not add the address under the Claude app's **Connectors**; those are connected from
Anthropic's servers, which cannot reach `127.0.0.1` on your computer.

Check it while the desktop is running:

```bash
claude mcp get copilot-meeting
```

It should say **Connected**. Then start a **new** Claude Code session (a running session does not pick up new servers).
The first time the agent calls a meeting tool, choose **always allow** for the `copilot-meeting` tools, so it does not
ask on every poll.

For one project only, put this in a `.mcp.json` file in the project folder instead (Claude Code asks you to approve it once):

```json
{ "mcpServers": { "copilot-meeting": { "type": "http", "url": "http://127.0.0.1:47391/mcp" } } }
```

## Codex CLI — not yet tested

```bash
codex mcp add copilot-meeting --url http://127.0.0.1:47391/mcp
```

or, in `~/.codex/config.toml`:

```toml
[mcp_servers.copilot-meeting]
url = "http://127.0.0.1:47391/mcp"
```

The Codex CLI, its IDE extension and its desktop app read the same `config.toml`. Older Codex versions needed
`experimental_use_rmcp_client = true` at the top of `config.toml` for Streamable HTTP servers; add it if Codex does not
list the tools. `meeting_next` waits up to 50 seconds by default, under Codex's default tool timeout of 60 seconds.

## Gemini CLI — not yet tested

In `~/.gemini/settings.json` (all projects) or `.gemini/settings.json` (one project):

```json
{
  "mcpServers": {
    "copilot-meeting": { "httpUrl": "http://127.0.0.1:47391/mcp" }
  }
}
```

Use `httpUrl`, not `url`: `url` is for the older SSE transport, and the handshake would not complete. Restart Gemini CLI
and run `/mcp` to see the server connected.

## A standalone Copilot CLI — not yet tested

A `copilot` started in a terminal, outside the desktop, can take part as an outside agent too. (Copilot sessions running
as tabs in the desktop do not need any of this: they join by typing "join meeting K7QF".)

```bash
copilot mcp add --transport http copilot-meeting http://127.0.0.1:47391/mcp
```

or, in `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "copilot-meeting": { "type": "http", "url": "http://127.0.0.1:47391/mcp", "tools": ["*"] }
  }
}
```

## Any other harness

Any MCP client that supports **Streamable HTTP** works. What it needs to know about the server:

- URL `http://127.0.0.1:47391/mcp`; no authentication headers.
- Answers are plain JSON (`application/json`), never a stream; a `GET` for the optional event stream gets 405, which
  clients are expected to accept.
- An unknown session gets 404 (after the desktop restarts, for example); the client should start a new session, and the
  agent then calls `meeting_join` (or `meeting_start`) again with the invitation it still has.
- Tool calls can take up to 50 seconds (`meeting_next` waits for the next message); allow at least 60.

## Using the tools

Every meeting still starts in the desktop, and only you make invitations:

- **To review:** start the meeting from a Copilot session ("start a meeting to review your local changes"). On its meeting
  bar, press **Invite outside agent…** and then **Copy short invitation** (for an agent set up as above) or **Copy
  invitation** (it also explains the helper). Paste it into the agent.
- **To host:** **File → Host a Meeting from an Outside Agent…**, optionally pick the agent's project folder, tick **Short
  invitation**, and paste the host invitation into the agent with what you want reviewed. Then add reviewers from the
  meeting bar.

An invitation works for one agent in one meeting and expires after 15 minutes if unused. Treat it like a password: do
not post it anywhere public.

## Without the tools

An agent without MCP can still take part: paste the full invitation (**Copy invitation**), which tells it to run the
guest helper from its shell. Each poll is then a shell command that the harness may ask you to approve. On Windows,
Claude Code must run the helper from its Bash tool; its PowerShell tool refuses to start `powershell.exe -File`.

## Troubleshooting

| What you see | Why, and what to do |
| --- | --- |
| "Failed to connect" | Copilot CLI Desktop is not running, is older than 0.1.61, or the port is taken (its log says so). Start or update the desktop. |
| The agent does not list the tools | The server was added after the session started: start a new session. In Codex, see the experimental flag above. |
| "This invitation is not known to the desktop" | The invitation expired (15 minutes unused) or its meeting closed. Make a new one. |
| "Call meeting_join first" | The agent's MCP session started over (the desktop restarted). It joins again with the same invitation. |
| The invitation has no meeting-tools section | The desktop is not serving the tools (port taken). Use the helper, or free the port and restart the desktop. |
