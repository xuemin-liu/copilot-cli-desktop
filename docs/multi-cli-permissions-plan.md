# Per-CLI permission & model settings for workspaces

## Goal

Today a workspace profile lets the user set a **startup permission preset** and
an **initial model** (plus other launch options) — but only for **Copilot CLI**.
Sessions started with another CLI (Claude Code, Codex, Antigravity) ignore these
and launch with nothing but their resume/session-id args; each CLI keeps its own
sign-in, settings and approvals.

We want the user to configure **permission** and **model** for the other CLIs too,
in the same workspace settings surface, so a workspace can say e.g. "Claude Code
here starts in Plan mode on `claude-sonnet-5`".

## Where it stands in the code

- `WorkspaceProfile` (`src/main/types.ts:50`): `permissionPreset: PermissionPreset`
  and `launch: SessionLaunchConfig` — one each, Copilot-shaped.
- `PermissionPreset` + `buildPermissionArgs` (`src/main/permission-presets.ts`):
  maps a preset to **Copilot** flags (`--allow-all`, `--allow-all-tools`,
  `--deny-tool`, `--available-tools`, `--add-dir`).
- `SessionLaunchConfig` + `buildSessionLaunchArgs` (`src/main/session-launch.ts`):
  `--model`, `--effort`, `--context`, `--agent`, `--mode`, … all Copilot flags.
- Other CLIs: `OTHER_CLIS = ['claude','codex','antigravity']` (`src/main/session-cli.ts`);
  launched by `createOtherCliSession` (`src/main/main.ts:2055`) with only
  `buildAgentCliArgs` (resume/session id). No permission, no model today.
- Settings UI: `WorkspaceProfileEditor` (`src/renderer/components/SettingsApp.tsx:77`)
  — permission dropdown + model text field + launch fields, all Copilot-wired.

## Proposed shape

### 1. Per-CLI capability descriptors (new, main side)

A small registry describing, for each CLI, what it supports and how an abstract
choice becomes real flags. Each descriptor provides:

- **Permission levels** it offers (an ordered enum) + how each maps to that CLI's
  launch flags.
- **Model**: whether it takes a `--model`-style flag, the flag name, and a
  placeholder/help string.
- A `buildArgs(permission, model, cwd)` function, mirroring Copilot's
  `buildPermissionArgs` / `buildSessionLaunchArgs`.

Mapping, revised after round 1 (use each CLI's **native** controls; a workspace
that was never touched must emit **no** permission flags for that CLI):

| CLI | v1 permission control(s) | Model flag | Notes |
|-----|--------------------------|-----------|-------|
| **Claude Code** | **Approval mode**: Inherit (default), **Plan** (`--permission-mode plan`), **Accept edits** (`--permission-mode acceptEdits`) | `--model` | Plan is a **startup mode the user can exit**, label it "Plan", don't promise read-only enforcement. Leave `--add-dir`, tool allow/deny lists, and bypass **out** of v1 — they change access/tool policy separately. |
| **Codex** | Two **independent** opt-in selectors, both default "Use CLI settings": **Approval** (`--ask-for-approval` → "Ask on request" `on-request` / "Never" `never`) and **Sandbox** (`--sandbox` → `read-only` / `workspace-write`) | `--model` / `-m` | Approval and sandbox are **distinct**: "Never" denies escalation requests but can leave the existing write scope intact — only an explicit sandbox tightens filesystem access. Selecting a sandbox explicitly **replaces** native `default_permissions`. Keep `untrusted`/`on-failure`/`--full-auto`/full-bypass out of v1. Each default (unset) emits nothing. |
| **Antigravity (`agy`)** | **Model only** in v1; permission labeled **"Managed by Antigravity"** | **`--model` (supported)** | Tool approval is documented separately and `auto` availability varies by platform/sandbox/account, so permission stays CLI-managed for v1. Execution mode (`--mode`) is a **later** setting of its own. `--conversation` is a separate resume feature — keep existing AGY session identity unchanged. |

Bypass (`--dangerously-skip-permissions` / Codex full-bypass) is **out of v1** — not
in the flag table, UI, or acceptance criteria. Any later bypass design must account
for automatic restore starting a tab without a click (`main.ts:3754,3889`).

Flag names/levels to be pinned against a tested version floor per CLI (see §Verification),
not assumed constant across versions.

### 2. Data model

`WorkspaceProfile` gains per-CLI config without disturbing Copilot's fields.
Option A (preferred): add a **per-CLI-shaped** map — not a single cross-product
`permission` enum, because Codex carries two independent controls:

```ts
otherCli?: {
  claude?: { approval?: 'plan' | 'acceptEdits'; model?: string }
  codex?:  { approval?: 'on-request' | 'never'; sandbox?: 'read-only' | 'workspace-write'; model?: string }
  antigravity?: { model?: string }
}
```

- Every field is **optional**; absent/empty = **inherit** (emit no flag, use the
  CLI's own default). Each descriptor owns which fields it reads.
- `model` is a bounded, injection-safe string (reuse `boundedText`: trim, strip NUL,
  reject leading `-`).
- Keeps Copilot's existing `permissionPreset` / `launch` untouched → absent map =
  today's behavior.

**Per-tab snapshot (round-1 correctness fix).** A tab must snapshot its effective
permission + model **independently at creation**, the same way Copilot tabs carry
`sessionPermissionPreset`. Otherwise, because `startDormantTab` delegates to
restart and restore calls it for the visible tab, a workspace override enabled
*after* a tab launched would silently apply on the next restore — no Resume click.
So: snapshot permission and model per tab, serialize through `persistProfileTabs` /
`readRestoredTabs`, restore in `addDormantSessionTab`. Pre-feature saved tabs (no
snapshot) are defined as **CLI-managed**: no desktop override on relaunch (the CLI
may still read its own updated defaults). Evidence from round 1: `main.ts:1089, 2104,
3479, 3689, 3754, 3889`, `desktop-config.ts:234`.

Option B: a unified `Record<SessionCli, …>` replacing the top-level fields — cleaner
long-term but a bigger migration and more churn. Lean A for now.

### 3. Launch wiring

`createOtherCliSession` (`main.ts:2055`) today bypasses the whole Copilot launch
plan (`buildSessionSpawnPlan` / `finalizeSessionArgs`) — it builds args only from
`buildAgentCliArgs` (resume identity). One **canonical** path replaces that:

- **New tab** → snapshot the workspace profile's current `otherCli[cli]` config onto
  the tab (see per-tab snapshot below), then launch from that snapshot.
- **Restart / restore** → launch from the tab's **persisted snapshot**, never by
  re-reading the profile's current settings (that is the bug the snapshot prevents).
- Either way the CLI **descriptor composes the complete argv** from the snapshot;
  an **unset** field emits nothing (intentional inherit).
- A snapshotted field the installed CLI **cannot apply** (e.g. a restrictive value
  after a downgrade) is **not** silently treated as inherit — it raises an explicit
  error surfaced to the user, who must choose CLI defaults before launch (see
  Unsupported-value handling below).

Note a scope limit: the desktop's **runtime** approval mode (`SessionPermissionMode`,
`permission-modes.ts`) is read from Copilot's own event stream, which the other
CLIs don't emit. So for other CLIs "permission" means **launch flags only** — we
won't observe or live-switch their approval mode in the UI. Mirror Copilot's
session-owned copy pattern (`sessionPermissionPreset` on the tab) so profile edits
only affect **new** sessions, not running ones.

Each descriptor **assembles its own complete argv** (verified executable/shim
`prefixArgs` first, each option a separate token, new-vs-resume composition defined
together), rather than blindly prepending to the existing resume args — current
upstream Codex merges root and resume-scoped overrides, so prepend order is not a
demonstrated bug and must be *tested* on the supported binary, not assumed.

**Unsupported-value handling (round-1 fix).** "Emit nothing" is correct for
intentional *inherit*, but a saved **restrictive** value that becomes unsupported
after a CLI downgrade would then start under the CLI's (more permissive) defaults.
So surface the incompatible value before starting and let the user explicitly
choose CLI defaults; never silently relax. On **restart**, build and validate the
complete launch plan **before** `managed.session.stop()` (the other-CLI branch
stops at `main.ts:3490` and constructs the replacement at `3498`) — validating
after the stop would kill a usable session on an unsupported setting.

### 4. Settings UI

`WorkspaceProfileEditor` grows a **single CLI selector / tabs** ("Copilot | Claude |
Codex | Antigravity") that swaps the permission + model controls to the active CLI's
supported set — so the controls and their explanations stay visible without
expanding every profile row (preferred over stacked rows, per round 1).

Each CLI shows only the permission levels it supports plus a model field with its
own placeholder, and each setting is **independently clearable** back to inherit.
Preserve saved values when a CLI becomes unavailable, and indicate which values are
currently usable.

When a saved tab can't apply an override, the offered **"Use CLI settings"**
recovery action must clear or replace **that specific field on the affected tab's
snapshot** — not the workspace profile (editing it can't unblock the tab under the
canonical path above), and not the whole snapshot (which would discard a still-valid
model or sandbox choice).

The save bridge `updateWorkspaceProfile(id, name, permissionPreset, defaultResumeMode, launch)`
(`settings-preload.cjs:30`) and the config create/normalize paths
(`desktop-config.ts`) extend to carry the new `otherCli` map. Older config files
(no map) keep today's behavior with no migration step. The normalizer must
distinguish two cases, not collapse them:

- **Malformed input** (wrong type, unknown key shape, injection-y string) → rejected,
  including at the IPC boundary for a **new** selection the user just made.
- **Syntactically valid persisted value the installed CLI can't currently apply**
  (e.g. a level dropped by a CLI downgrade) → **kept, not silently cleared**; it
  stays visible in the editor and raises an explicit launch error until the user
  changes it. This is what makes "unset = inherit" distinguishable from "set but
  unsupported".

## Safety (bypass deferred)

The dangerous bypass level (`--dangerously-skip-permissions`, and any Codex
full-bypass) is **not in v1** — absent from the flag table, UI, and acceptance
criteria. A future bypass design must account for automatic restore starting a tab
without a click (`startDormantTab` → restart on restore, `main.ts:3754,3889`): it
would need a per-CLI confirmation that names which checks it disables and an
interactive opt-in before any automatic restore uses it — a save-time warning alone
would be bypassed by those automatic starts.

## Verification

Use the **documented version floor as the tested support boundary**, combined with a
**capability check on the resolved executable** — a version number alone can't verify
a given command/OS capability, and a `--help` hit alone can't establish support on an
untested older build. On an **unmanaged/unverified install, default to no desktop
override**. For an existing snapshot whose explicit override is outside verified
support, show the retained setting and require a user choice before launching with
CLI defaults. Distinguish flag *detection* from OS sandbox availability and org
policy (a recognized `--sandbox` is not a guaranteed sandbox). **Validate model and
permission separately** so a partial match never silently clears the other.

Acceptance matrix: model-only, permission-only, Windows model strings with spaces,
fresh vs stored-session argv, saved tabs relaunched after a profile edit, and an
incompatible permission on restart that **leaves the old process running**. (Note:
`codex`, `claude`, `agy` were all absent from PATH in the reviewer's environment, so
version parsing / precedence / enforcement remain untested until run on a machine
with the binaries.)

## Open questions for the meeting

**Settled (rounds 1–2):**
- **Option A** per-CLI-shaped data model; **permission + model** scope;
  **launch-flags-only** behavior; **CLI-native** control names (no forced shared ladder).
- **Single CLI selector/tabs** UI, independently clearable, saved values preserved
  when a CLI goes unavailable, usable ones indicated.
- **Per-tab snapshot** with explicit inherit; one canonical launch path (workspace
  defaults for new tabs, persisted snapshot for restart/restore); **validate the
  full plan before stopping** the old process; descriptor owns the complete argv.
- **Claude**: approval mode (Plan / Accept edits), `--model`.
- **Codex**: two independent opt-in selectors — approval (`on-request`/`never`) **and**
  sandbox (`read-only`/`workspace-write`), both default "Use CLI settings"; `--model`.
- **Antigravity**: **model only** in v1; permission "Managed by Antigravity";
  execution mode (`--mode`) is a later, separate setting.
- **Bypass deferred** from v1 entirely (not in table/UI/acceptance).
- **Verification**: documented floor + capability check on the resolved executable;
  no override on unmanaged installs; keep incompatible saved values visible and force
  a user choice; validate model and permission separately.
- Normalizer distinguishes malformed input (reject, incl. at IPC for new selections)
  from valid-but-unsupported persisted values (keep, surface, don't clear).

No open design questions remain — ready to implement v1 on this spec.
