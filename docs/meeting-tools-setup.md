# Setting up the meeting tools for outside agents

Copilot CLI Desktop can bring agents from other harnesses into its review meetings: Claude Code, Codex CLI, Gemini CLI, a
standalone Copilot CLI, or anything else that speaks MCP. They review, or host a meeting of their own, with the
**meeting tools** (`meeting_join`, `meeting_next`, `meeting_reply`, `meeting_show`, and `meeting_start` with the host's
commands) that the desktop serves itself.

This page is the one-time setup per agent. How meetings work is in the [README](../README.md#review-meetings).

## What you need

- **Copilot CLI Desktop 0.1.62 or later, running.** The desktop serves the tools; there is nothing else to install. (The
  tools arrived in 0.1.61; the short invitations this page uses, in 0.1.62.)
- **The agent on the same computer.** The tools listen only on `127.0.0.1`, so an agent on another machine, or in WSL with
  its default (NAT) networking, cannot reach them. WSL works with mirrored networking.
- **The address:** `http://127.0.0.1:47391/mcp`, a Streamable HTTP MCP server. It needs no key or header: it listens only
  on this computer, and refuses requests a web page could send.

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

## Codex CLI — tested

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
copilot mcp add --transport http --timeout 60000 copilot-meeting http://127.0.0.1:47391/mcp
```

or, in `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "copilot-meeting": { "type": "http", "url": "http://127.0.0.1:47391/mcp", "tools": ["*"], "timeout": 60000 }
  }
}
```

Keep the timeout: Copilot CLI's default for MCP tool calls is 30 seconds, and `meeting_next` waits up to 50 seconds for
the next message. Without it, a quiet poll fails before the desktop can answer "Nothing yet". Any timeout above 50
seconds works.

## Any other harness

Any MCP client that supports **Streamable HTTP** works. What it needs to know about the server:

- URL `http://127.0.0.1:47391/mcp`; no authentication headers.
- Answers are plain JSON (`application/json`), never a stream; a `GET` for the optional event stream gets 405, which
  clients are expected to accept.
- An unknown session gets 404 (after the desktop restarts, for example); the client should start a new session, and the
  agent then calls `meeting_join` again with the invitation it still has, or, as host, `meeting_start` again (see
  [Troubleshooting](#troubleshooting) for what 0.1.62 answers).
- Tool calls can take up to 50 seconds (`meeting_next` waits for the next message); allow at least 60.

## Using the tools

Joining by meeting id and hosting without an invitation require Copilot CLI Desktop **0.1.78 or later**. Older versions
use the invitation workflow below.

With the tools set up, just ask the agent:

- **To host:** "start a meeting to review your changes". The agent calls `meeting_start` with a topic, its post and its
  project folder, and tells you the meeting id, say K7QF.
- **To review:** "join meeting K7QF". The agent calls `meeting_join` with the id and is in at once; the meeting bar lists
  it as a guest, with **Remove**.

Any agent can host and any can review: a Copilot tab joins an outside agent's meeting with "join meeting K7QF" as usual,
and an outside agent joins a Copilot tab's meeting the same way. Joining or starting answers a seat key: if the desktop
restarts, the agent calls `meeting_join` with that key as the invitation and gets its own seat back.

The tools tell agents to keep calling `meeting_next` until the meeting closes, but an agent can still stop. See
[If an agent ends its turn](#if-an-agent-ends-its-turn) for what happens then.

Joining by id trusts everything that can reach `127.0.0.1` on this computer, programs of other accounts included. Wrong
ids are limited to five a minute, so an id cannot be guessed; on a computer others use too, prefer invitations.

Invitations still work, and an agent without the tools needs one:

- **To review:** on a meeting bar, press **Invite outside agent…** and then **Copy short invitation** (for an agent set up
  as above) or **Copy invitation** (it also explains the helper). Paste it into the agent.
- **To host:** **File → Host a Meeting from an Outside Agent…**, optionally pick the agent's project folder, tick **Short
  invitation**, and paste the host invitation into the agent with what you want reviewed.

An invitation works for one agent in one meeting and expires after 15 minutes if unused. Treat it like a password: do
not post it anywhere public.

## If an agent ends its turn

Agents get meeting messages by calling `meeting_next`, so an agent that ended its turn would miss them. The desktop wakes it
when it is owed a message, is not asking, and has been quiet for about a minute (three minutes if it was handed a message and
may be working on it). It wakes a seat once per quiet spell, so an agent that keeps polling is never disturbed.

| Agent | How it is woken | What it needs |
| --- | --- | --- |
| **Codex** (app, CLI, IDE) | The desktop runs `codex queue` for the agent's thread. The thread takes one short turn saying to call `meeting_next`. | Nothing. A busy thread takes it right after its current turn. |
| **Claude Code** (terminal, Claude app) | The tools ask the agent to keep one background `curl` running. It exits only when the agent should be woken, and Claude Code wakes when a background command exits. | The agent starts the command. In default permission mode, allow it when asked. |
| Anything else | It cannot be woken. | Keep it polling. |

Limits:

- **Codex thread open nowhere:** the wake-up waits in Codex's queue and arrives when the thread is opened again. By then the
  meeting may be over, and `meeting_next` says so.
- **Codex on another `CODEX_HOME`:** the desktop runs `codex` with its own environment, so a thread kept under another
  `CODEX_HOME` is not found. Outside Windows, `codex` has to be on the PATH of the desktop.
- **`claude -p` with a prompt:** the process exits when its turn ends, so nothing can wake it. It has to keep polling.
- **Agents using the helper** instead of the tools are not woken.

The wake-up says only that a meeting has a message, in the desktop's own words. The Claude Code command holds a key that can
wait for that signal and do nothing else in the meeting.

In default permission mode Claude Code asks before it starts the command, and an agent waiting on that question does nothing
else. Plain **Yes** covers one start, and the agent starts it again after each wake-up. **Yes, and don't ask again** covers that
seat only, because the command holds the seat's key. To cover every meeting, add this rule to your settings:

```json
{ "permissions": { "allow": ["Bash(curl.exe -sS --retry 720 --retry-delay 5 --retry-all-errors -X POST http://127.0.0.1:47391/meeting-wake/*)"] } }
```

Outside Windows the command starts with `curl` instead of `curl.exe`.

If an agent cannot be woken, or a wake-up brings no answer within about three minutes, the desktop notifies you once and the
meeting bar shows **no contact since** with the time. The meeting goes on, and a late answer still counts: tell the agent to
call `meeting_next` until the meeting is closed.

## Without the tools

An agent without MCP can still take part: paste the full invitation (**Copy invitation**), which tells it to run the
guest helper from its shell. Each poll is then a shell command that the harness may ask you to approve. On Windows,
Claude Code must run the helper from its Bash tool; its PowerShell tool refuses to start `powershell.exe -File`.

## Troubleshooting

| What you see | Why, and what to do |
| --- | --- |
| "Failed to connect" | Copilot CLI Desktop is not running, is older than 0.1.61 (the tools; 0.1.62 for the short invitations), or the port is taken (its log says so). Start or update the desktop. |
| The agent does not list the tools | The server was added after the session started: start a new session. In Codex, see the experimental flag above. |
| The tools still say an invitation is required after updating | Reconnect the meeting MCP server or start a new agent session to refresh its cached tool descriptions. Check that the running desktop is 0.1.78 or later. |
| "This invitation is not known to the desktop" | The invitation expired (15 minutes unused) or its meeting closed. Make a new one, or have the agent join by meeting id. |
| "Call meeting_join first" | The agent's MCP session started over (the desktop restarted). It calls `meeting_join` again with its seat key (or invitation) as the invitation, and gets its seat back, as host too. With only the meeting id it gets a new seat. |
| A notification that an agent stopped checking in, or **no contact since** on the meeting bar | The agent ended its turn and could not be woken, or is stuck on something like a permission prompt. Tell it to call `meeting_next` until the meeting is closed. **Last contact …, message delivered** means it was handed a message and has not answered: it may still be working. |
| "Too many wrong meeting ids in the last minute" | Five joins in the last minute named a meeting that is not open. Check the id on the meeting bar and try again a minute later. |
| "Call meeting_join (or meeting_start, as host) first" | The agent's MCP session started over (the desktop restarted). A reviewer calls `meeting_join` again with the same invitation. A host calls `meeting_start` again with its invitation: from 0.1.63 that answers "Rejoined meeting K7QF as host"; 0.1.62 answers "This invitation already started meeting K7QF", which is expected, since the session is bound again all the same: carry on with `meeting_next`. |
| The invitation has no meeting-tools section | The desktop is not serving the tools (port taken). Use the helper, or free the port and restart the desktop. |
