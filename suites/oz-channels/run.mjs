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
// Two person live calls spend call minutes, so they run only when asked.
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
  const res = unwrap(j.result || j)
  if (!r.ok || res?.isError) throw new Error(tool + ': http ' + r.status + ' ' + JSON.stringify(res).slice(0, 300))
  return res
}
// The ingest route may wrap a tool result once more ({ result: {...} }).
const unwrap = (r) => (r && !r.content && !r.structuredContent && r.result ? unwrap(r.result) : r)
// It answers with the tool's structuredContent as a bare object when there is
// one, so a bare object is read as the structured result and as text.
const text = (r) => {
  const u = unwrap(r)
  return u?.content ? u.content.map((c) => c.text || '').join('\n') : JSON.stringify(u ?? '')
}
const sc = (r) => {
  const u = unwrap(r)
  return u?.structuredContent || (u && !u.content && typeof u === 'object' ? u : {})
}

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

const rid = () => Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
const CALL = {
  root: '[data-testid="call-root"]',
  status: '[data-testid="call-status"]',
  meeting: '[data-testid="call-meeting"]',
  leave: '[data-testid="call-leave"]',
  error: '[data-testid="call-error"]',
  note: '[data-testid="call-note"]',
}
// Collects every RTCPeerConnection a page makes, so media can be measured from
// WebRTC stats without knowing the call SDK's internals.
const PC_SPY = () => {
  const O = window.RTCPeerConnection
  if (!O) return
  window.__pcs = []
  window.RTCPeerConnection = function (...a) {
    const pc = new O(...a)
    window.__pcs.push(pc)
    return pc
  }
  window.RTCPeerConnection.prototype = O.prototype
}
async function inbound(page) {
  return page.evaluate(async () => {
    const out = { audio: 0, video: 0 }
    for (const pc of window.__pcs || []) {
      const st = await pc.getStats().catch(() => null)
      st?.forEach((r) => {
        if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) out[r.kind] += r.bytesReceived || 0
      })
    }
    return out
  })
}

async function main() {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  const browser = await chromium.launch({ args: SPEECH ? [...args, '--use-file-for-fake-audio-capture=' + SPEECH] : args })
  let run = rid()
  let reviewerId
  try {
    // ------------------------------------------------ web app (reviewer)
    // The web app's person is the reviewer account (a real sign in, 15 minute
    // token, never printed); the other person is synthetic, on the server.
    let sess = null
    await step('reviewer gets a sign in for the web app', async () => {
      sess = sc(await harness('browser_session', { run }))
      if (sess.run) run = sess.run
      console.log('::add-mask::' + sess.reviewer.access_token)
      return true
    })
    console.log('run ' + run)
    const as = (persona, tool, a = {}) => harness('browser_drive', { run, persona, tool, args: a })
    const BEN = 'Ben ' + run
    let dm = ''
    if (sess?.reviewer) {
      const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] })
      const r = sess.reviewer
      const auth = { access_token: r.access_token, refresh_token: '', expires_at: r.expires_at, token_endpoint: '', client_id: '', resource: r.resource }
      await ctx.addInitScript((v) => sessionStorage.setItem('ozch.hub.auth', v), JSON.stringify(auth))
      const page = await ctx.newPage()
      page.on('dialog', (d) => d.accept())
      const call = (name, a = {}) => page.evaluate(([n, x]) => window.ozCall(n, x), [name, a])
      let ready = false
      await step('web app opens signed in as the reviewer', async () => {
        await page.goto(sess.site + '/?page=app', { waitUntil: 'domcontentloaded' })
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
        const rr = await as('ben', 'read_messages', { conversation: dm, lane: 'person' })
        return text(rr).includes(body) || 'not delivered: ' + text(rr).slice(0, 200)
      })
      await step('a reply from the other person shows up in the page', async () => {
        if (!ready || !dm) return 'skip'
        const body = 'reply from ben ' + run
        const p = await as('ben', 'post_message', { conversation: dm, message: body })
        if (!/^Sent/.test(text(p))) return text(p)
        await page.locator(SEL.message).filter({ hasText: body }).first().waitFor({ timeout: 25000 })
        return true
      })
      await step('the agent lane in the page is separate from the person lane', async () => {
        if (!ready || !dm) return 'skip'
        const body = 'agent lane from the browser ' + run
        await page.locator(SEL.laneAgent).click()
        await page.locator(SEL.composer).fill(body)
        await page.locator(SEL.send).click()
        await page.locator(SEL.message).filter({ hasText: body }).first().waitFor({ timeout: 15000 })
        const ag = await as('ben', 'read_messages', { conversation: dm, lane: 'agent' })
        const pe = await as('ben', 'read_messages', { conversation: dm, lane: 'person' })
        return (text(ag).includes(body) && !text(pe).includes(body)) || 'agent lane: ' + text(ag).slice(0, 150)
      })
      await ctx.close().catch(() => {})
    }

    // ------------------------------------------------ call page (Oz Calls)
    // The call page takes a signed ticket, not a platform sign in, so two
    // synthetic people can join from two browsers with fake media.
    const ANA = 'Ana ' + run, CY = 'Cy ' + run
    let conv = ''
    await step('two synthetic people share a channel for a call', async () => {
      for (const [p, n] of [['ana', ANA], ['cy', CY]]) await as(p, 'set_profile', { display_name: n, email_notices: false })
      const inv = await as('ana', 'create_invite', {})
      if (!sc(inv).code) return 'no invite code in ' + JSON.stringify(inv).slice(0, 300)
      const j = await as('cy', 'join', { code: sc(inv).code })
      if (!/connected with/i.test(text(j))) return text(j)
      const c = await as('ana', 'create_channel', { name: 'call-' + run, members: [CY] })
      conv = sc(c).conversation?.id || ''
      return !!conv || text(c)
    })
    const tickets = {}
    let off = false
    await step('each member gets a call page ticket', async () => {
      if (!conv) return 'skip'
      for (const p of ['ana', 'cy']) {
        const t = await harness('browser_drive', { run, persona: p, tool: 'call_ticket', args: { conversation: conv, media: 'audio', start: p === 'ana' } }).catch((e) => e)
        if (t instanceof Error) {
          if (/not switched on/i.test(t.message)) return ((off = true), true)
          return t.message
        }
        tickets[p] = sc(t).url
        if (!String(tickets[p] || '').startsWith('https://oz-calls.mcp.opzero.sh/#t=')) return 'bad url for ' + p
      }
      return true
    })
    const pages = {}
    let live = false
    await step('the call page loads for both and reports its state', async () => {
      if (off || !tickets.ana) return 'skip'
      const states = []
      const who = CALLS ? ['ana', 'cy'] : ['ana']
      for (const p of who) {
        const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] })
        await ctx.addInitScript(PC_SPY)
        const pg = await ctx.newPage()
        await pg.goto(tickets[p].replace('/#t=', '/?autojoin=1#t='), { waitUntil: 'domcontentloaded' })
        await pg.waitForSelector(CALL.root, { timeout: 20000 })
        await pg.waitForFunction((s) => ['live', 'refused', 'ended'].includes(document.querySelector(s)?.dataset?.state), CALL.status, { timeout: 45000 }).catch(() => {})
        states.push(await pg.locator(CALL.status).getAttribute('data-state'))
        pages[p] = pg
      }
      live = CALLS && states.every((s) => s === 'live')
      if (!CALLS && states[0] === 'live') {
        await pages.ana.locator(CALL.leave).click().catch(() => {})
        console.log('calls are on; the two person checks run with OZ_CALLS=1')
        return true
      }
      if (states.every((s) => s === 'refused')) {
        const why = (await pages.ana.locator(CALL.error).innerText().catch(() => '')) + ' ' + (await pages.ana.locator(CALL.note).innerText().catch(() => ''))
        console.log('call page refused: ' + why.trim().slice(0, 200))
        return true
      }
      return live || 'states ' + states.join(', ')
    })
    await step('audio flows both ways in a live call', async () => {
      if (!live) return 'skip'
      await sleep(8000)
      const a = await inbound(pages.ana), c = await inbound(pages.cy)
      return (a.audio > 2000 && c.audio > 2000) || 'inbound audio bytes ana ' + a.audio + ', cy ' + c.audio
    })
    await step('notetaker transcript holds the spoken phrase', async () => (live && NOTETAKER ? 'not wired yet: needs the call page notes bar' : 'skip'))
    await step('leaving ends the call page for that person', async () => {
      if (!live) return 'skip'
      await pages.cy.locator(CALL.leave).click()
      await pages.cy.waitForFunction((s) => document.querySelector(s)?.dataset?.state === 'ended', CALL.status, { timeout: 15000 })
      return true
    })
  } finally {
    await browser.close().catch(() => {})
  }

  const real = steps.filter((s) => !s.skipped)
  const passed = real.filter((s) => s.ok).length
  const ok = passed === real.length
  await harness('browser_report', { run, ok, passed, total: real.length, url: RUN_URL, steps, reviewer_id: /^p_[A-Za-z0-9]+$/.test(reviewerId || '') ? reviewerId : undefined }).catch((e) => console.error('report failed: ' + e.message))
  console.log((ok ? 'PASS ' : 'FAIL ') + passed + '/' + real.length)
  if (!ok) process.exit(1)
}

main().catch((e) => {
  console.error('FAIL harness: ' + (e?.stack || e))
  process.exit(1)
})
