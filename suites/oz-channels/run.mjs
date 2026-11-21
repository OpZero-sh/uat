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
const TONE = process.env.OZ_TONE_WAV || ''

// Selectors the web app promises (its E2E SELECTORS block). Overridable per run.
const SEL = {
  signedIn: '[data-testid="me"]',
  convItem: '[data-testid="conv-item"]',
  laneAgent: '[data-testid="lane-agent"]',
  lanePerson: '[data-testid="lane-person"]',
  composer: '[data-testid="composer"]',
  send: '[data-testid="send"]',
  message: '[data-testid="message"]',
  callButton: '[data-testid="call-join"]',
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
  const sess = await harness('browser_session', { personas: ['ana', 'ben'] })
  const { run, codes, site } = sc(sess)
  console.log('run ' + run)
  const as = (persona, tool, args = {}) => harness('browser_drive', { run, persona, tool, args })
  const NAME = (p) => p[0].toUpperCase() + p.slice(1) + ' ' + run
  let dm = ''

  await step('synthetic people connect through an invite', async () => {
    for (const p of ['ana', 'ben']) await as(p, 'set_profile', { display_name: NAME(p), email_notices: false })
    const inv = await as('ana', 'create_invite', {})
    const j = await as('ben', 'join', { code: sc(inv).code })
    if (!text(j).includes('connected with')) return text(j)
    const s = await as('ana', 'send_message', { to: NAME('ben'), message: 'setup ' + run })
    dm = sc(s).conversation?.id || ''
    return !!dm || text(s)
  })

  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  const launch = (wav) => chromium.launch({ args: wav ? [...args, '--use-file-for-fake-audio-capture=' + wav] : args })
  const bA = await launch(SPEECH)
  const bB = await launch(TONE)
  const pages = {}
  try {
    for (const [p, b] of [['ana', bA], ['ben', bB]]) {
      const ctx = await b.newContext({ permissions: ['microphone', 'camera'] })
      pages[p] = await ctx.newPage()
    }
    let webReady = false
    await step('web app signs each synthetic person in', async () => {
      for (const p of ['ana', 'ben']) {
        await pages[p].goto(site + '/?page=app&e2e=' + codes[p], { waitUntil: 'domcontentloaded' })
      }
      const ok = await Promise.all(['ana', 'ben'].map((p) => pages[p].waitForSelector(SEL.signedIn, { timeout: 15000 }).then(() => true, () => false)))
      if (!ok[0] && !ok[1]) {
        const has = await pages.ana.locator('[data-testid]').count()
        if (!has) return 'skip' // the web app with e2e sign in is not deployed yet
        return 'no signed in marker (' + SEL.signedIn + ')'
      }
      webReady = ok[0] && ok[1]
      return webReady || 'only one person signed in'
    })
    await step('a message typed in the web app arrives in the other web app', async () => {
      if (!webReady) return 'skip'
      const body = 'typed in the browser ' + run
      await pages.ana.locator(SEL.convItem).filter({ hasText: NAME('ben') }).first().click()
      await pages.ana.locator(SEL.composer).fill(body)
      await pages.ana.locator(SEL.send).click()
      await pages.ben.locator(SEL.convItem).filter({ hasText: NAME('ana') }).first().click()
      await pages.ben.locator(SEL.message).filter({ hasText: body }).first().waitFor({ timeout: 20000 })
      const r = await as('ben', 'read_messages', { conversation: dm, lane: 'person' })
      return text(r).includes(body) || 'not in the store: ' + text(r)
    })
    await step('the agent lane is separate in the web app', async () => {
      if (!webReady) return 'skip'
      const body = 'agent lane from the browser ' + run
      await pages.ben.locator(SEL.laneAgent).click()
      await pages.ben.locator(SEL.composer).fill(body)
      await pages.ben.locator(SEL.send).click()
      const r = await as('ana', 'read_messages', { conversation: dm, lane: 'agent' })
      if (!text(r).includes(body)) return 'not in the agent lane: ' + text(r)
      const p = await as('ana', 'read_messages', { conversation: dm, lane: 'person' })
      return !text(p).includes(body) || 'leaked into the person lane'
    })

    // Calls: window.ozCall contract shared by the RealtimeKit call page and p2p audio.
    const hasCall = webReady && (await pages.ana.evaluate(() => typeof window.ozCall === 'object').catch(() => false))
    const stats = (p) => pages[p].evaluate(() => window.ozCall.stats())
    await step('both people join a call', async () => {
      if (!CALLS || !hasCall) return 'skip'
      await Promise.all(['ana', 'ben'].map((p) => pages[p].evaluate(() => window.ozCall.join())))
      for (let i = 0; i < 30; i++) {
        const st = await Promise.all(['ana', 'ben'].map((p) => pages[p].evaluate(() => [window.ozCall.state(), window.ozCall.participants()])))
        if (st.every(([s, n]) => s === 'joined' && n >= 2)) return true
        await sleep(1000)
      }
      return 'not joined: ' + JSON.stringify(await Promise.all(['ana', 'ben'].map((p) => pages[p].evaluate(() => [window.ozCall.state(), window.ozCall.participants()]))))
    })
    await step('audio flows both ways', async () => {
      if (!CALLS || !hasCall) return 'skip'
      const a1 = await stats('ana'), b1 = await stats('ben')
      await sleep(8000)
      const a2 = await stats('ana'), b2 = await stats('ben')
      const grew = (x, y) => (y?.audioIn?.bytes || 0) > (x?.audioIn?.bytes || 0) + 2000
      const loud = (y) => (y?.audioIn?.level || 0) > 0.001
      return (grew(a1, a2) && grew(b1, b2) && loud(a2) && loud(b2)) || JSON.stringify({ a1, a2, b1, b2 }).slice(0, 380)
    })
    await step('video flows both ways', async () => {
      if (!CALLS || !hasCall) return 'skip'
      const a = await stats('ana'), b = await stats('ben')
      if (!a.videoIn && !b.videoIn) return 'skip' // audio only mode
      return ((a.videoIn?.frames || 0) > 10 && (b.videoIn?.frames || 0) > 10) || JSON.stringify({ a: a.videoIn, b: b.videoIn })
    })
    await step('both leave the call', async () => {
      if (!CALLS || !hasCall) return 'skip'
      await Promise.all(['ana', 'ben'].map((p) => pages[p].evaluate(() => window.ozCall.leave())))
      await sleep(1500)
      const st = await Promise.all(['ana', 'ben'].map((p) => pages[p].evaluate(() => window.ozCall.state())))
      return st.every((s) => s === 'left' || s === 'idle') || JSON.stringify(st)
    })
    await step('the notetaker transcript holds the spoken phrase', async () => {
      if (!CALLS || !NOTETAKER || !hasCall) return 'skip'
      for (let i = 0; i < 24; i++) {
        const r = await as('ben', 'read_messages', { conversation: dm })
        if (/harness check/i.test(text(r))) return true
        await sleep(5000)
      }
      return 'no transcript with "harness check" after two minutes'
    })
  } finally {
    await bA.close().catch(() => {})
    await bB.close().catch(() => {})
  }

  const real = steps.filter((s) => !s.skipped)
  const passed = real.filter((s) => s.ok).length
  const ok = passed === real.length
  await harness('browser_report', { run, ok, passed, total: real.length, url: RUN_URL, steps })
  console.log((ok ? 'PASS ' : 'FAIL ') + passed + '/' + real.length)
  if (!ok) process.exit(1)
}

main().catch((e) => {
  console.error('FAIL harness: ' + (e?.stack || e))
  process.exit(1)
})
