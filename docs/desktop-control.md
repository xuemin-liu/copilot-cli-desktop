# Desktop control

Desktop control lets a Copilot session see your screen and use the mouse and keyboard in other apps on your Windows
computer, for tasks that files, shell commands and the session's Debug browser can't do. It is off by default, it is
turned on per session, and every app Copilot touches needs your approval first.

Windows 10 and 11 only. On macOS and Linux the setting is shown but can't be turned on.

## Turning it on

1. **Settings → Desktop control:** check *Let sessions use the mouse and keyboard in other apps when I turn it on for
   them*. Sessions that start from then on get the desktop control helper. A session that was already running needs a
   restart (↻ in its header). Read-only sessions, side chats and remote sessions never get it.
2. **In the session:** click the monitor button in the session's header, then **Turn on**. Only you can do this; Copilot
   can't turn it on for itself.

While it is on, a red border and a banner show on every display:
*Copilot is controlling your computer — press Ctrl+Alt+Shift+X to stop*. Both ignore the mouse and are left out of
every screenshot.

It turns off when you click **Turn off**, press **Ctrl+Alt+Shift+X** anywhere, turn the setting off, restart or close
the session, after 30 minutes without an action, or when the computer sleeps. Turning it on in one session turns it off
in any other: only one session controls the desktop at a time.

## What Copilot can do

Copilot uses a helper script in the session (`desktop.ps1`, through its shell tool, so your shell approvals still
apply to running it):

| Command | Does |
|---|---|
| `status` | Whether control is on, the stop key, approved apps and the displays |
| `windows` | Visible windows: id, app, title and whether each is approved, needs approval or is blocked |
| `screenshot [window-id\|screen\|screen:N]` | A window (the one in front by default) or a whole display, saved as a PNG; answers with a `frameId` |
| `focus <window-id>` | Bring an approved app's window to the front |
| `click`, `move`, `drag`, `scroll` | At a point in a screenshot's pixels |
| `type <frameId> -File text.txt` | Type a file's text (UTF-8, at most 4 KiB) into the focused control |
| `key <frameId> <chord>` | One key or chord, such as `enter` or `ctrl+s`, from a fixed list |

Every input names the screenshot it was planned from. Before acting, the app checks that the screenshot is less than
30 seconds old and that the screen hasn't locked or changed since. For a point, it also checks that the window under
the point is still the same app and window, and that the pixels around the point (about 64×64 px) still match the
screenshot. If anything changed, Copilot is told to take a new screenshot. So a dialog that appears after the
screenshot, or a sheet drawn inside the window, isn't clicked by mistake.

## Approvals

The first screenshot of an app, or the first input to it, asks you: **Deny**, **Allow once** or **Allow for this
session**. Desktop programs are matched by their program's full path; packaged (Store) apps by their app ID, never by
window title. Apps that can start programs or open files (browsers, Office, editors) show a warning: approving them lets
Copilot start programs from them, outside Copilot CLI's shell approvals. A full-screen screenshot is a separate grant,
which you can also give in the panel.

The session's **Desktop control** panel lists the approved apps (with × to stop allowing one) and the recent actions,
including every refusal.

## What is always blocked

Whatever you approve, Copilot can never capture or control:

- **Copilot CLI Desktop itself**, so it can't approve its own prompts or Copilot CLI's tool approvals.
- **Terminals and shells** (Command Prompt, PowerShell, Windows Terminal, Git Bash and others, and any console window):
  typing commands there would get past Copilot CLI's shell approvals.
- **File Explorer, Start, Search and the Run dialog** (and the taskbar and desktop, which belong to File Explorer):
  typing a program name there starts it. Use `focus` to switch apps instead of the taskbar.
- **Sign-in, credential and password windows**, including Windows Security and common password managers.
- **System and security tools**: Settings, Control Panel, Task Manager, Registry Editor, management consoles and
  installers.
- **Administrator windows**, and any window whose app or elevation can't be identified.

Blocked windows are painted over in full-screen screenshots, and their titles are not listed. `key` refuses Win-key
chords (`win+r`, `win+x`, …), chords that switch or lock the desktop (`alt+tab`, `ctrl+esc`, `ctrl+shift+esc`), and
this app's own global shortcuts (`Ctrl+Alt+H` and the stop key).

## Other safeguards

- **No typing into password fields.** Before `type`, the app asks Windows UI Automation whether the focused control is
  a password field, and refuses if it is or if it can't tell.
- **Your input comes first.** If you use the mouse or keyboard during an action, the action stops and control pauses
  until you click **Resume** in the panel. An action right after your own input is deferred.
- **Limits.** At most 10 actions a second, one at a time, and 4 KiB per `type`.
- **The desktop must be yours.** Nothing happens while the screen is locked or a sign-in or administrator prompt shows.
- **Screen content is untrusted.** Copilot's instructions tell it that text on screen is data, not instructions, but the
  rules above are what actually protect you.

## Limits

- An app you approve that can start programs (a browser's downloads, Office, an editor's terminal, an Open dialog)
  can be used to start programs. The block list covers Windows' own launch surfaces; the approval prompt warns about
  the rest. Approve only what the task needs.
- The screen check compares the window and the pixels around the point. A change elsewhere in the window isn't caught.
- Apps that ignore or detect synthetic input (some games, anti-cheat, remote desktop clients) won't respond.
- Some security software may flag synthetic mouse and keyboard input.

## Checking it

`npm run desktop-control:check` runs a real check on your desktop. It opens its own small test window, clicks and types
in it, and checks the refusals and the stop key. Leave the mouse and keyboard alone for the 30 seconds it takes.
