# Security policy

## Supported versions

Security fixes are applied to the default branch and included in the newest release. Users should update both Copilot CLI Desktop and GitHub Copilot CLI before reporting a problem that may already have been fixed.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** flow for this repository. Do not include credentials, tokens, private transcripts, or working exploit details in a public issue. Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation.

## Security boundaries

- Workspace contents, terminal output, model output, plugins, skills, MCP metadata, and URLs are untrusted input.
- The renderer is sandboxed. Privileged operations cross validated IPC handlers, and Electron permissions are denied by default.
- Sessions run with the current operating-system user's authority. Restricted tool presets reduce Copilot's available tool surface but are not an operating-system sandbox.
- Vault credentials are decrypted only for authenticated interactive Copilot sessions. They are withheld from renderers, resource installers, and unrelated helpers; child Copilot helpers receive secret-environment masking flags.
- File-opening IPC accepts local filesystem paths only; network and device paths are rejected.
- Automated tagged releases require Windows code signing. Local or explicitly manual historical artifacts may be unsigned and should be verified before use.
