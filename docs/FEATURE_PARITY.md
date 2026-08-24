# DeepSeek Harness Desktop feature parity

This document audits Copilot CLI Desktop against the sibling DeepSeek Harness Desktop application and its embedded official Harness Web UI. “Equivalent” means the user-facing capability is present using the integration surface GitHub Copilot CLI actually exposes. It does not mean terminal output is reimplemented as an unrelated HTML chat client.

## Desktop shell and navigation

| DeepSeek Harness capability | Copilot CLI Desktop equivalent | Status |
| --- | --- | --- |
| Persistent AI-tool sidebar | Copilot-branded sidebar with workspace groups and sessions | Equivalent |
| Collapsible sidebar rail | Sidebar collapse/expand control with a compact action rail | Equivalent |
| New Session primary action | Starts a new PTY-backed Copilot CLI session | Equivalent |
| Workspace list | Recent path-keyed workspace profiles | Equivalent |
| Workspace/session search | Sidebar search filters names, paths, and live session titles | Equivalent |
| Group/order view options | Workspace vs one-list grouping and manual vs last-activity ordering | Equivalent |
| Add workspace | Native directory picker | Equivalent |
| Session list and native tabs | Sidebar session rows plus top tabs, lifecycle indicators, close/activate shortcuts | Equivalent |
| Generated session titles | Session titles can be renamed by double-clicking a tab or sidebar row | Equivalent within CLI limits; Copilot exposes no structured title event |
| Settings anchored in sidebar | Persistent Settings action | Equivalent |
| Multiple Harness windows sharing one web server | Not enabled for PTY sessions | Not safely applicable: a ConPTY has one authoritative viewport; independently resized terminal renderers would corrupt layout and input ownership |

## Agent interaction

| DeepSeek Harness capability | Copilot CLI Desktop equivalent | Status |
| --- | --- | --- |
| Rich Chat view | Real Copilot terminal/TUI rendered by xterm.js | Equivalent upstream UI |
| Trajectory/tool-call view | Copilot CLI renders its own tool execution and approval UI in the terminal | Structurally different; no supported structured event stream is available |
| Message composer | Copilot CLI interactive prompt | Equivalent upstream UI |
| File attachments | “New Session with Attachments…” passes official `--attachment` arguments | Equivalent |
| Model selector | GitHub-hosted selection remains in Copilot; Desktop Settings configures official OpenAI-compatible, Azure, and Anthropic BYOK providers | Equivalent |
| Plan/execute modes | Copilot CLI’s native Shift+Tab mode switching | Equivalent upstream UI |
| Session history/resume | New, auto-resume, continue, and interactive picker modes | Equivalent |
| Token/tool metrics | Copilot CLI’s own status and usage rendering | Upstream-owned; no structured desktop API |

## Workspaces, permissions, and process access

| DeepSeek Harness capability | Copilot CLI Desktop equivalent | Status |
| --- | --- | --- |
| Named recent workspace profiles | Named profiles keyed by normalized folder path | Equivalent |
| Read-only permission | Restricted preset denies Copilot’s current built-in `write` and `shell` tools | Best available mapping; Copilot exposes no deny-by-default allowlist, so the UI explicitly avoids claiming a categorical read-only guarantee |
| Workspace/default permission | Default prompt mode and trusted-directory mode | Equivalent |
| Full computer access | Official Copilot `--allow-all` mode | Equivalent |
| Permission shown in Settings/tray | Settings access card, sidebar badge, and tray label | Equivalent |
| Windows elevation warning | Detects integrity level and warns when sessions inherit administrator rights | Equivalent |
| Native browse support | Electron’s native directory picker | Equivalent; no embedded Web UI patch is required |

## Credentials and providers

| DeepSeek Harness capability | Copilot CLI Desktop equivalent | Status |
| --- | --- | --- |
| Windows DPAPI protected vault | Electron `safeStorage` vault with no plaintext fallback | Equivalent |
| Multiple provider credentials | Official `COPILOT_PROVIDER_API_KEY`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` variables | Equivalent to Copilot’s supported credential surface |
| Provider endpoint/model/type | Global BYOK provider settings for OpenAI-compatible, Azure, and Anthropic endpoints | Equivalent |
| Offline provider mode | Official `COPILOT_OFFLINE=true` setting | Equivalent |
| Inherited environment precedence | Inherited values override protected/configured values and are shown read-only | Equivalent |
| Prevent secrets reaching tools | Every configured credential is passed through Copilot’s `--secret-env-vars` protection | Copilot-specific additional protection |
| Migrate Harness plaintext credential YAML | No equivalent plaintext desktop store exists | Not applicable |

## Lifecycle, recovery, and operating-system integration

| DeepSeek Harness capability | Copilot CLI Desktop equivalent | Status |
| --- | --- | --- |
| Runtime supervision | One supervised PTY process per session with restart/crash handling | Equivalent |
| Startup checkpoints for local HTTP server | CLI resolution diagnostics plus per-tab starting/running/crashed states | Equivalent to CLI lifecycle; HTTP URL/readiness stages are not applicable |
| Recent output and diagnostics | Bounded session backlog, per-session logs, app log, and copyable redacted diagnostics | Equivalent |
| Restart runtime | Restart active/crashed Copilot session from UI, menu, or tray | Equivalent per-session model |
| Tray/background behavior | Configurable tray, close-to-tray, status, actions, and explicit quit | Equivalent |
| Native notifications | Approval, completion, and crash notifications route to the relevant tab | Equivalent; approval/session recognition uses documented terminal heuristics |
| Launch at login | Installed-build login registration | Equivalent |
| Global show/hide shortcut | Optional Ctrl+Alt+H registration | Equivalent |

## Updates, releases, packaging, and automation

| DeepSeek Harness capability | Copilot CLI Desktop equivalent | Status |
| --- | --- | --- |
| Electron update center | Check, download progress, install/restart, releases link | Equivalent |
| Previous release rollback link | Opens the previously recorded version’s release | Equivalent |
| Signed public releases | Release workflow refuses unsigned publication and verifies Authenticode | Equivalent |
| Packaged dependency audit | Verifies ASAR, executable, and unpacked native node-pty addon | Equivalent to Copilot’s runtime shape |
| Runtime compatibility schedule | Weekly job installs latest official `@github/copilot` and runs tests/smokes | Equivalent |
| Dependency update automation | Dependabot for npm and GitHub Actions | Equivalent |
| Background control CLI | Token-protected loopback start/status/restart/logs/stop controller | Equivalent |

## Architectural boundary

DeepSeek Harness publishes a complete Web UI and a local HTTP server, so its desktop wrapper embeds structured routes, sessions, messages, and trajectories. GitHub Copilot CLI publishes a terminal UI plus command-line and Agent Client Protocol modes. This project deliberately uses the supported interactive terminal surface. Recreating the terminal as an independently parsed HTML chat frontend would be a forked, fragile UI rather than feature parity.
