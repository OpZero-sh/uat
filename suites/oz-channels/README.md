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
- Media: Chromium fake camera and microphone. One side plays a spoken phrase
  ("harness check ...") made with espeak-ng, the other a tone, so audio levels
  and the notetaker transcript can be checked.
- Calls run only when `OZ_CALLS=1` (workflow input, or the repository variable
  `OZ_CALLS_ENABLED`), because real calls count against the call caps.

Contract the app keeps for this suite:

- `/?page=app&e2e=<code>` signs a synthetic person in (codes come from the
  owner only `e2e_web_code` tool, five minutes, one use).
- `data-testid`: `me`, `conv-item`, `lane-person`, `lane-agent`, `composer`,
  `send`, `message`, `call-join`. Override with `OZ_SELECTORS` (JSON) if they
  change.
- `window.ozCall = { state(), join(), leave(), participants(), stats() }` where
  `stats()` gives `{ audioIn: { bytes, level }, audioOut: { bytes }, videoIn: { frames, bytes }, videoOut: { frames } }`.
