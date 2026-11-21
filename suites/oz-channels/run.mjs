// Oz Channels browser and call suite. Runs in GitHub Actions (oz-channels-e2e.yml)
// against the live app with two synthetic people. Sign in, setup and checks go
// through the harness server (oz-channels-e2e on OpZero), which accepts this run
// only with a GitHub OIDC token minted for this repository's main branch.
// Chromium runs with fake camera and microphone; the microphone plays a WAV with
// a known spoken phrase so audio levels and the notetaker transcript can be checked.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const HARNESS = process.env.OZ_HARNESS || 'https://oz-channels-e2e.mcp.opzero.sh/mcp/ingest'
const GATE = 'oz-channels-e2e-gate' // not a secret: the OIDC token is the credential
const CALLS = process.env.OZ_CALLS === '1'
const NOTETAKER = process.env.OZ_NOTETAKER === '1'
const RUN_URL = process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined
const SPEECH = process.env.OZ_SPEECH_WAV || ''

// Selectors from the web app's web/E2E-SELECTORS.md. Overridable per run.
const SEL = {
  me: '[data-testid="me"]',
  conversation: '[data-testid="conversation"]',
  laneAgent: '[data-testid="lane-agent"]',
  lanePerson: '[data-testid="lane-person"]',
  composer: '[data-testid="composer-input"]',
  send: '[data-testid="send"]',
  message: '[data-testid="message"]',
  ...(process.env.OZ_SELECTORS ? JSON.parse(process.env.OZ_SELECTORS) : {}),
}

const steps = []
let oidc = ''

async function token() {
  const u = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const t = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!u || !t) throw new Error('no GitHub OIDC token: the job needs permissions id-token: write')
  const r = await fetch(u + '&audience=oz-channels-e2e', { headers: { authorization: 'Bearer ' + t } })
  return (await r.json()).value
}

async function harness(tool, body) {
  if (!oidc) oidc = await token()
  const r = await fetch(`${HARNESS}/${tool}?key=${GATE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, oidc }) })
  const j = await r.json().catch(() => ({}))
  const res = j.result || j
  if (!r.ok || res.isError) throw new Error(tool + ': http ' + r.status + ' ' + JSON.stringify(res).slice(0, 300))
  return res
}
const text = (r) => (r?.content || []).map((c) => c.text || '').join('\n')
const sc = (r) => r?.structuredContent || {}

async function step(name, fn) {
  const t = Date.now()
  try {
    const r = await fn()
    if (r === 'skip') steps.push({ name, ok: true, skipped: true, detail: 'skipped' })
    else if (r === true) steps.push({ name, ok: true })
    else steps.push({ name, ok: false, detail: String(r).slice(0, 400) })
  } catch (e) {
    steps.push({ name, ok: false, detail: 'threw ' + String(e?.message || e).slice(0, 380) })
  }
  const s = steps[steps.length - 1]
  console.log((s.skipped ? 'SKIP ' : s.ok ? 'ok   ' : 'FAIL ') + name + (s.detail && !s.skipped ? ' -- ' + s.detail : '') + ' (' + (Date.now() - t) + 'ms)')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // The web app's person is the reviewer account (a real sign in, 15 minute
  // token, never printed); the other person is synthetic, driven on the server.
  const sess = await harness('browser_session', {})
  const { run, site, reviewer } = sc(sess)
  console.log('::add-mask::' + reviewer.access_token)
  console.log('run ' + run)
  const as = (persona, tool, args = {}) => harness('browser_drive', { run, persona, tool, args })
  const BEN = 'Ben ' + run
  let dm = ''
  let reviewerId

  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  const browser = await chromium.launch({ args: SPEECH ? [...args, '--use-file-for-fake-audio-capture=' + SPEECH] : args })
  try {
    const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] })
    const auth = { access_token: reviewer.access_token, refresh_token: '', expires_at: reviewer.expires_at, token_endpoint: '', client_id: '', resource: reviewer.resource }
    await ctx.addInitScript((v) => sessionStorage.setItem('ozch.hub.auth', v), JSON.stringify(auth))
    const page = await ctx.newPage()
    page.on('dialog', (d) => d.accept())
    const call = (name, a = {}) => page.evaluate(([n, x]) => window.ozCall(n, x), [name, a])

    let ready = false
    await step('web app opens signed in as the reviewer', async () => {
      await page.goto(site + '/?page=app', { waitUntil: 'domcontentloaded' })
      ready = await page.waitForSelector(SEL.me, { timeout: 20000 }).then(() => true, () => false)
      if (!ready) return (await page.locator('[data-testid="signin-gate"]').count()) ? 'sign in gate shown: the page did not take the token' : 'no signed in marker'
      reviewerId = await page.evaluate(() => window.ozApp?.state?.()?.me?.id).catch(() => undefined)
      return true
    })
    await step('reviewer joins a synthetic person through an invite, from the page', async () => {
      if (!ready) return 'skip'
      await as('ben', 'set_profile', { display_name: BEN, email_notices: false })
      const inv = await as('ben', 'create_invite', {})
      const j = await call('join', { code: sc(inv).code })
      const t = JSON.stringify(j)
      if (!/connected with/i.test(t)) return t
      await page.evaluate(() => window.ozApp?.refresh?.())
      await page.locator(SEL.conversation).filter({ hasText: BEN }).first().waitFor({ timeout: 15000 })
      return true
    })
    await step('a message typed in the page reaches the other person', async () => {
      if (!ready) return 'skip'
      const body = 'typed in the browser ' + run
      await page.locator(SEL.conversation).filter({ hasText: BEN }).first().click()
      await page.locator(SEL.composer).fill(body)
      await page.locator(SEL.send).click()
      await page.locator(SEL.message).filter({ hasText: body }).first().waitFor({ timeout: 15000 })
      const convs = sc(await as('ben', 'list_conversations', {})).conversations || []
      dm = convs.find((c) => c.kind === 'dm')?.id || ''
      if (!dm) return 'ben has no DM'
      const r = await as('ben', 'read_messages', { conversation: dm, lane: 'person' })
      return text(r).includes(body) || 'not delivered: ' + text(r).slice(0, 200)
    })
    await step('a reply from the other person shows up in the page', async () => {
      if (!ready) return 'skip'
      const body = 'reply from ben ' + run
      if (!dm) return 'ben has no DM'
      const p = await as('ben', 'post_message', { conversation: dm, message: body })
      if (!/^Sent/.test(text(p))) return text(p)
      await page.locator(SEL.message).filter({ hasText: body }).first().waitFor({ timeout: 25000 })
      return true
    })
    await step('the agent lane in the page is separate from the person lane', async () => {
      if (!ready) return 'skip'
      const body = 'agent lane from the browser ' + run
      await page.locator(SEL.laneAgent).click()
      await page.locator(SEL.composer).fill(body)
      await page.locator(SEL.send).click()
      await page.locator(SEL.message).filter({ hasText: body }).first().waitFor({ timeout: 15000 })
      const ag = await as('ben', 'read_messages', { conversation: dm, lane: 'agent' })
      const pe = await as('ben', 'read_messages', { conversation: dm, lane: 'person' })
      return (text(ag).includes(body) && !text(pe).includes(body)) || 'agent lane: ' + text(ag).slice(0, 150)
    })

    // Calls need two real browser identities; with one (the reviewer) these
    // steps run only when a second identity or a media test page is wired in.
    const hasCall = ready && (await page.evaluate(() => typeof window.ozCallUI === 'object').catch(() => false))
    await step('call with fake audio and video, both ways', async () => (CALLS && hasCall ? 'needs a second browser identity' : 'skip'))
    await step('notetaker transcript holds the injected phrase', async () => (CALLS && NOTETAKER && hasCall ? 'needs a second browser identity' : 'skip'))
  } finally {
    await browser.close().catch(() => {})
  }

  const real = steps.filter((s) => !s.skipped)
  const passed = real.filter((s) => s.ok).length
  const ok = passed === real.length
  await harness('browser_report', { run, ok, passed, total: real.length, url: RUN_URL, steps, reviewer_id: /^p_[A-Za-z0-9]+$/.test(reviewerId || '') ? reviewerId : undefined })
  console.log((ok ? 'PASS ' : 'FAIL ') + passed + '/' + real.length)
  if (!ok) process.exit(1)
}

main().catch((e) => {
  console.error('FAIL harness: ' + (e?.stack || e))
  process.exit(1)
})
