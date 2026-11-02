# Desktop control: plan

Status: proposal; nothing is built yet. This plan covers letting a Copilot session see the screen and use the mouse and
keyboard in other apps on the user's computer, as Codex's and Claude's computer use do. Windows comes first; macOS
and Linux follow later (see [Platforms](#platforms)).

## Where the app stands

A session can control only its own **Debug browser** pane (`browser-debug.ts`). It reads pages, takes screenshots and
runs test steps there, through a per-session helper script that calls the app over a loopback server protected by a
token (`browser-session.ts`). Nothing in the app captures the desktop or sends input to other apps. A user can already
add a third-party desktop-control MCP server to Copilot CLI (`~/.copilot/mcp-config.json`), but the app can't see what
that server does and has no say over it.

Building it in gives the app control the MCP route can't:

- which apps a session may touch
- a visible indicator and a stop key
- a rule that the app's own approval prompts can never be clicked by the agent
- a log of every action

## Goals and non-goals

Goals:

- A session can take a screenshot, list windows, and click, type, scroll and press keys in apps the user allowed.
- The user stays in charge. Desktop control is off until the user turns it on for a session. Every new app needs the
  user's approval. Control is always visible and can be stopped with one key.
- The agent can't use desktop control to get past the app's or Copilot CLI's own approvals through the surfaces the
  app knows about: its own windows, terminals, and the Windows surfaces that start programs (rule 3). An app the user
  approves that can itself start programs widens this, and the approval prompt says so (rule 2).

Non-goals (for now):

- Unattended control, such as while the screen is locked, in a remote session from another computer, or in a
  scheduled run.
- Controlling elevated (administrator) windows, the secure desktop (UAC, sign-in), or other user accounts.
- Clipboard read or write, file drag and drop between apps, and recording video.
- Replacing the Debug browser for web apps. It stays the better tool there: it reads the DOM, masks password fields and
  is scoped to one page.

## How it fits the existing design

It reuses the browser helper's shape, so the security review covers one familiar pattern:

| Piece | Browser today | Desktop control |
|---|---|---|
| Helper script | `browser.ps1` / `browser.sh` in the session folder | `desktop.ps1` (Windows first), written only while desktop control is on for the session |
| Instructions | `.github/instructions/browser.instructions.md` via `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | `desktop.instructions.md`, added only while it is on |
| State | `control.json` (port, token) via `COPILOT_DESKTOP_BROWSER_STATE` | `desktop-control.json` via `COPILOT_DESKTOP_CONTROL_STATE`, deleted when it is turned off |
| Endpoint | Loopback HTTP; rejects `Origin` and wrong `Host`; constant-time bearer token | Same checks; a new token each time it is turned on |
| Token handling | Never on a command line or in a URL | Same |

The main process owns all of it: capture, input, rules and approvals. The helper only forwards requests. The rules
are enforced in the app, never in the instructions, because instructions can be ignored or overridden by text on the
screen.

### Commands

| Command | Does |
|---|---|
| `status` | Whether control is on, the stop key, allowed apps, the displays and their scale |
| `windows` | Visible top-level windows: id, title, app name, bounds, whether the app is allowed |
| `screenshot [window-id] [-OutputPath file.png]` | A window of an allowed app, or the whole screen once the user allowed full-screen capture. Returns a `frameId` |
| `click <frameId> <x> <y> [left\|right\|middle] [double]` | Click at a point in that frame's pixels |
| `move`, `drag`, `scroll` | As for click, with a frame and points |
| `type <frameId> -File text.txt` | Types the file's text (UTF-8, at most 4 KiB) into the focused control. The text goes in a file so it is never on a command line |
| `key <frameId> <chord>` | One key or chord, such as `enter` or `ctrl+s`, from a fixed list. The list has no Win-key chords (`win+r`, `win+x`, `win+e`, …) and none of this app's own global shortcuts (`Ctrl+Alt+H`, the stop key), because `SendInput` reaches global shortcuts whatever window is in front |
| `focus <window-id>` | Bring an allowed app's window to the front |

Every input command names the screenshot it was planned from. Before acting, the app checks:

- the frame is less than 30 seconds old
- the window under the point is still the same app and window as in the frame
- the pixels around the point still match the frame: the app re-captures a small patch (about 64×64 px, at the frame's
  scale) and compares it with the same patch in the frame, within a small tolerance
- the screen hasn't been locked or switched since

If any check fails, the app refuses with "The screen changed; take a new screenshot". The window check catches a new
top-level dialog; the patch check catches content that changed inside the same window, such as a web page's modal, a
browser's permission bubble or an app's own confirm sheet. A change outside the patch can still go unnoticed (see
[Risks](#risks)).

Coordinates are in the screenshot's pixels. The app maps them to physical screen pixels using each display's scale
factor, so mixed-DPI multi-monitor setups work. Screenshots are scaled down to at most 1568 px on the long side.

## Safety rules

These are enforced in the main process, and each one gets unit tests.

1. **Off by default, on per session.** A global setting (Settings → Desktop control, off) makes the per-session switch
   available. Only the user can turn it on for a session, from the session's toolbar; Copilot can't. It turns itself
   off when the session ends, after 30 minutes without an action, and when the user presses the stop key.
2. **Apps need approval.** The first screenshot of a window or input to an app opens a prompt in the app:
   "Allow Copilot to control *Notepad* (`notepad.exe`) in this session?", with the choices **Once**, **For this
   session** and **Deny**. Apps are matched by identity, never by window title:
   - a desktop app by the full path of its program
   - a packaged (UWP/MSIX) app by its AppUserModelID. Its top-level window belongs to `ApplicationFrameHost.exe`, so
     the app reads the ID from the hosted `CoreWindow` child's process (`GetApplicationUserModelId`) or from the
     window's `System.AppUserModel.ID` property, and the prompt shows the app's display name. A frame host window whose
     app it can't identify is refused.

   For an app on a built-in list of apps that can start programs or open files (browsers, Office, editors with a
   command box or "Open with"), the prompt adds a warning: approving it lets Copilot start programs from it, outside
   Copilot CLI's shell approvals. Capturing the whole screen is a separate, explicit grant.
3. **Always blocked**, whatever the user approves:
   - This app's own windows, so it can never approve its own prompts or the Copilot CLI's tool approvals.
   - Terminals and shells (`cmd`, `powershell`, `pwsh`, Windows Terminal, `conhost`, Git Bash). Typing commands there
     would get past Copilot CLI's shell-tool approvals.
   - Windows surfaces that start programs: File Explorer (`explorer.exe`, which also owns the **Run** dialog, the
     taskbar, the desktop and the **Win+X** menu), Start (`StartMenuExperienceHost.exe`) and Search (`SearchHost.exe`).
     Typing a program name or `cmd` into any of them starts it.
   - Credential and security UI: `CredentialUIBroker`, Windows Security, sign-in and password managers on a built-in
     list.
   - Task Manager and Registry Editor.
   - Any elevated window. Windows blocks input to these anyway (UIPI), but the app refuses up front with a clear
     message.

   Input aimed at a blocked window is refused, and screenshots blank out blocked windows.
4. **No typing into password fields.** Before `type`, the app asks UI Automation whether the focused control is a
   password field and refuses if it is (or if it can't tell).
5. **Always visible, easy to stop.** While control is on, a click-through, always-on-top border and banner show
   "Copilot is controlling your computer — Ctrl+Alt+Shift+X to stop". The stop key (a global shortcut) turns control off at
   once and cancels any action in progress.
6. **The user's input comes first.** If the user moves the mouse or types while an action runs (real input, not the
   app's own), control pauses until the user clicks **Resume** in the banner.
7. **Limits.** At most 10 input actions per second and 4 KiB per `type`. Only one action runs at a time per session,
   and only one session can control the desktop at a time.
8. **Session permissions apply.** A session in read-only mode, or with its shell tool disabled, can't use the helper.
   A remote session from another computer can't reach the loopback endpoint.
9. **Log.** Every request is recorded in the session: time, command, app and result, plus refusals. The log is shown
   in a Desktop control pane. Screenshots are saved in the session folder and deleted when the session ends.
10. **Screen content is untrusted.** The instructions tell Copilot that text on screen is data, not instructions.
    Rules 2–4 are what actually protect the user when that fails.

## Platforms

- **Windows 10/11:** first and fully covered. Capture uses Electron's `desktopCapturer`. Input, window listing,
  foreground checks and password-field checks go through `SendInput`, `EnumWindows`, `GetWindowThreadProcessId`,
  `QueryFullProcessImageName`, `GetApplicationUserModelId` (packaged apps) and UI Automation. Low-level mouse and
  keyboard hooks (`WH_MOUSE_LL`, `WH_KEYBOARD_LL`) tell the user's input from the app's own.
- **macOS:** later. It needs the Accessibility and Screen Recording permissions, which macOS ties to the app's
  signature, so it waits for signed macOS builds (see `cross-platform-plan.md`).
- **Linux:** X11 only, through XTest, and later. Wayland blocks synthetic input. The RemoteDesktop portal would need
  the user to approve every session, so Wayland is out of scope for now.

## Decisions needed first

1. **Native layer for Windows input.** Options:
   - **(a)** a small in-repo N-API addon. The app already ships node-pty as a native module.
   - **(b)** an FFI library with prebuilt binaries, such as `koffi`, calling `user32` directly.
   - **(c)** an existing automation package.

   Suggested: (a) or (b). They keep the code small and auditable. Spawning PowerShell with `Add-Type` for each action is
   too slow, and antivirus tools often flag it.
2. **Default capture scope.** Suggested: windows of allowed apps only, with full-screen capture as an extra grant.
3. **Blocked-app list.** Whether users can unblock entries (suggested: no for this app's own windows and credential
   UI; terminals, File Explorer, Start and Search stay blocked in the first release).
4. **Stop key.** `Ctrl+Alt+Shift+X` is suggested, because few apps use it. It must not clash with the existing show/hide
   shortcut (`Ctrl+Alt+H`), or with Remote Desktop's `Ctrl+Alt+End` (its Ctrl+Alt+Del).

## Plan

Each step is one PR. None of them changes what sessions can do until step 4 connects the helper.

### 1. Spike (Windows)

- Try the native-layer options:
  - `SendInput` click and type into Notepad and a UWP app, and identifying the UWP app by its AppUserModelID behind
    `ApplicationFrameHost.exe`
  - coordinate mapping on a 150% display next to a 100% one
  - `desktopCapturer` window and screen capture
  - UIPI refusal for an elevated window
  - UI Automation's password-field check
  - telling real input from injected input: the `LLMHF_INJECTED` flag in a `WH_MOUSE_LL` hook for the mouse, and
    the `LLKHF_INJECTED` flag in a `WH_KEYBOARD_LL` hook for the keyboard
- Check that a packaged build, with the `RunAsNode` fuse off, loads the chosen layer, and see whether Defender
  flags it.
- Write `docs/desktop-control-spikes.md` with the results and the chosen layer.
- Done when: decision 1 is made with evidence.

### 2. Core service in the main process

- `desktop-capture.ts`: window list, window and screen capture, scaling, frames with ids and blanking of blocked
  windows.
- `desktop-input.ts`: click, move, drag, scroll, type and key, through the chosen layer.
- `desktop-rules.ts`: block list, app identity (program path or AppUserModelID), the `key` chord list, frame checks,
  password-field check, rate limits.
- Unit tests for coordinate mapping, frame checks (including the patch comparison), block-list matching, refused key
  chords and request validation, using a fake native layer.
- Not reachable by any session yet.
- Done when: the tests pass and a dev-only check script clicks and types in Notepad.

### 3. Consent and safety UI

- Settings → Desktop control (global switch, off by default), a per-session toolbar switch, and the per-app approval
  prompt.
- The on-screen border and banner, the stop key, pausing when the user takes over, and the 30-minute idle timeout.
- The Desktop control pane with the action log.
- Done when: the Electron check script shows the switch, prompt, banner and stop key working, with input still only
  from the dev script.

### 4. Copilot access

- Add `/desktop/*` routes to a loopback endpoint (the browser's server design, with its own token and state file).
  Write `desktop.ps1` and `desktop.instructions.md` into the session folder only while control is on, and remove them
  when it turns off.
- Refuse sessions in read-only mode or without the shell tool.
- `scripts/desktop-control-check.mjs`: a session opens Notepad, types text and saves it. The script also checks the
  refusals: a terminal, the app's own window, a File Explorer address bar, the `win+r` and `Ctrl+Alt+H` chords, a
  password field, a stale frame, a frame whose patch changed, and input after the stop key.
- Done when: the check passes on a local Windows desktop. GitHub's Windows runners may not have an interactive
  desktop, so CI runs the unit tests and skips this check, with the reason.

### 5. macOS and Linux (X11)

- After signed macOS builds exist. Same commands; `desktop.sh` helper; permission onboarding for Accessibility and
  Screen Recording.

### 6. Docs

- README feature entry, a `docs/desktop-control.md` user guide (what it can and can't do, the safety rules, the stop
  key), and the feature parity table.

## Risks

- **Antivirus and security software** may flag synthetic input. The spike checks Defender. Other products are a known
  unknown.
- **Prompt injection from the screen**, such as a web page or document telling Copilot to do something. Approval of
  each app, the block list, the frame checks and the visible banner limit what it can do. The plan doesn't claim to
  remove the risk.
- **Approved apps that start programs.** The guarantee against getting past Copilot CLI's approvals is only as strong
  as the apps the user approves. A browser's downloads, Office, or any app with an "Open with" or command box can
  start programs once approved, and so can the Open and Save dialogs inside any approved app (they run in its process,
  not in `explorer.exe`). The block list covers Windows' own launch surfaces; the prompt warns about the rest.
- **Changes outside the checked patch.** The frame checks compare the window and a small patch around the point. A
  change elsewhere in the same window, such as a moved button the click still lands next to, isn't caught.
- **Apps that ignore or detect injected input** (games, anti-cheat, some remote-desktop clients) won't work, and the
  log shows the action was sent but nothing changed.
- **Remote desktop and locked screens.** Capture returns black or nothing. The app refuses, with "The desktop isn't
  available", instead of acting blind.
