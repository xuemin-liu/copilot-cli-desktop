# Plan: say why a terminal is empty when its session is not running

Reviewed in meeting DNFP (2026-11-11, one reviewer: Codex). Its corrections are folded in below.

## The problem

Selecting a session that is **Not running** shows an empty dark terminal. The only hint in the terminal area is a
small **Resume this session** button in the bottom-right corner (`.restart-button`, `styles.css:724`), which is easy
to miss. What each place shows today:

| Status | Main window (`SessionWorkspace.tsx:118-123`) | Session window (`SessionWindow.tsx:35`) |
| --- | --- | --- |
| `dormant` | corner **Resume this session** | corner **Resume this session** |
| `crashed` | corner **Restart this session** (shown even when the tab is popped out) | nothing in the terminal area |
| `completed` | nothing in the terminal area | nothing in the terminal area |

Local tabs also have the ↻ button in the pane header in every status.

Why the terminal is empty: a not-running tab has no process, so `desktop:get-tab-snapshot` (`main.ts:5326`) answers
with no text. Restored tabs start as `dormant`; at launch only the visible main tab, its linked side chat
(`main.ts:3887-3891`) and the sessions of a restored meeting (`main.ts:3948`) are started.

## Design

Show a notice in the terminal area whenever the session has no process, in place of the corner button. Resuming
stays an explicit action: selecting a tab never starts a process, because Unload (`unloadSessionTab`) exists to free
the process and browser while keeping the tab.

| Status | Heading | Text | Buttons |
| --- | --- | --- | --- |
| `dormant` | This session is not running | Resume to start it again. | **Resume session** |
| `crashed` | This session stopped unexpectedly | Restart to start it again. | **Restart session**, **Show log** |
| `completed` | This session has ended | Restart to start it again. | **Restart session** |
| `starting` (local or remote) | Starting… | | none |
| `crashed` or `completed`, remote tab | The connection to this remote session ended | Close this tab and connect again to continue. | none |

`running` and `approval-needed` show no notice, for local and remote tabs alike. A remote tab that is connecting
has not ended, so it gets the Starting row.

- **No promise about the conversation.** Restart resumes the saved conversation only when the CLI still has it
  stored; otherwise it starts a new session (`main.ts:3583-3601`, and the other-CLI path at `:3484-3503`).
  `lastSessionId` alone does not prove it. The text therefore stays neutral. Saying "continues your conversation"
  would need a real check of the stored session, which is out of scope.
- **Remote tabs** cannot be restarted (`main.ts:3461`, `:3479`), so they get their own text and no button. The text
  speaks of the connection, not of the remote agent, which may still be running.
- **Two layouts, chosen by whether the terminal has text:**
  - empty terminal: a centered card;
  - terminal with text (a session unloaded, crashed or completed in this run): a compact bar along the bottom, so
    the last output stays fully visible, scrollable and selectable.
  "Has text" is read from the mounted xterm buffer (`TerminalPane` reports it), never inferred from the status or
  process id: an unloaded tab has no snapshot in the main process, and a freshly opened session window cannot
  rebuild the old screen.
- **The stopped terminal keeps its size.** xterm drops the rows that no longer fit when it shrinks, and a stopped
  CLI cannot redraw them. So while the bar shows, the terminal is not refitted: the rows the bar displaces scroll,
  with the end of the output in view. It is fitted again, and the new process told its size, once the session runs.
- **Focus moves to the button only from the session's own terminal** when a session stops, never from another field
  of the pane such as the browser's address bar.
- **An HTML layer, not text written into xterm**, so it never mixes with the session's output. The same keyed
  `TerminalPane` stays mounted underneath.
- **One component**, `SessionStoppedNotice`, used by `SessionWorkspace.tsx` and `SessionWindow.tsx`. It takes
  `onRestart` and `onShowLog` (the existing `showSessionLog` API, `main.ts:5335`, with the usual error display).
- **Focus is part of the change.** `TerminalPane.tsx:387-391` focuses xterm whenever a pane becomes active or
  focused, stopped or not, and two panes can be visible with only one focused. So:
  - the notice gets the pane's `visible` and `focused` state, and its button takes focus only in the focused pane;
  - `TerminalPane` does not take focus while its session is stopped;
  - focus returns to xterm when the session reaches `running`.
- **Popped-out tabs:** the main window keeps its "open in another window" message for every stopped status (this
  also fixes the crashed corner button showing there today); the notice shows in the session window.
- **No behaviour change in the main process.**

## Not in this plan

- Starting a not-running session automatically on selection, or a setting for it.
- Showing the saved conversation of a not-running session in the terminal.
- Checking whether the conversation is still stored, to promise that Restart continues it.

## Steps

1. `TerminalPane`: report whether its buffer has text, and skip its focus effect while the session is stopped.
2. Add `SessionStoppedNotice` (card and bar layouts, the five rows above) and its styles; remove `.restart-button`.
3. Use it in `SessionWorkspace.tsx` and `SessionWindow.tsx`, with popped-out suppression for every stopped status.
4. Update `scripts/terminal-links-check.mjs`, which clicks `.restart-button`.
5. Render test next to `sidebar-render.test.tsx`: each status and the remote case show the right heading and
   buttons; a remote starting tab shows Starting…; a running or approval-needed tab, local or remote, has no notice;
   a popped-out tab has none in the main window.
6. Checks in the real app, since a render test cannot show focus:
   - restart the app with several tabs, select a not-running one, resume by mouse and by Enter;
   - split view: a stopped side chat next to a running main tab, and the reverse; only the focused pane's button
     takes focus;
   - stopped to running without switching tabs: focus lands in the terminal;
   - starting to crashed (a start that fails): the notice changes to the crashed row;
   - unload a running tab: the bar shows, and the old output still scrolls and Shift-selects;
   - the same in a session window, including Show log on a crashed tab.

Implemented as planned. `npm run stopped-notice:check` runs both checks of step 6: the notice with a stand-in
desktop API (focus, Enter, split view, a failed start, remote, popped-out), and the real app with a live CLI (unload,
resume from the notice, the session window).

## Decisions from the meeting

1. A notice with an explicit button; no automatic start and no setting.
2. Compact bar when the terminal has text, centered card when it is empty.
3. A completed tab gets a notice too.
4. "Resume" for not running, "Restart" for crashed and completed, as today.
