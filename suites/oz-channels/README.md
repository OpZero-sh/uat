# Oz Channels browser and call suite

Runs the Oz Channels web app and calls in headless Chromium with two synthetic
people, against the live app. The MCP level suites (messaging, the reviewer
through the real front door, the isolation suite) run on OpZero itself, in the
`oz-channels-e2e` server, every 15 minutes when there is a new deploy and hourly
otherwise. This suite reports into the same results page:
https://oz-channels-e2e.mcp.opzero.sh/

- Workflow: `.github/workflows/oz-channels-e2e.yml` (daily, on demand, and on a
  `repository_dispatch` of type `oz-channels-deploy`).
- Auth: no stored secret. The job asks GitHub for an OIDC token with audience
  `oz-channels-e2e`; the harness accepts only tokens for this repository's
  `main` branch and this workflow.
- Identity: the web app is signed in as the server's reviewer account with a
  15 minute token the harness gets from OpZero (masked in logs, no refresh).
  The other person is synthetic, driven on the server through `e2e_drive`.
- Media: Chromium fake camera and microphone; the microphone plays an
  espeak-ng phrase ("harness check ..."). Two browser call checks need a second
  real browser identity and stay skipped until there is one.
- Calls run only when `OZ_CALLS=1` (workflow input, or the repository variable
  `OZ_CALLS_ENABLED`), because real calls count against the call caps.

Contract the app keeps for this suite:

- Session: `sessionStorage['ozch.hub.auth']` set before load skips the sign
  in gate.
- `data-testid` from the app's `web/E2E-SELECTORS.md`: `me`, `conversation`,
  `lane-person`, `lane-agent`, `composer-input`, `send`, `message`. Override
  with `OZ_SELECTORS` (JSON) if they change.
- `window.ozCall(name, args)` calls a tool as the signed in person;
  `window.ozApp.state()` and `window.ozApp.refresh()`.
