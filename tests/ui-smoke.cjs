// UI regression test: two keyframes -> PC vector inbetween -> preview -> accept.
// Supply PLAYWRIGHT_CORE_MODULE and BROWSER_EXECUTABLE if Playwright is not local.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_CORE_MODULE || 'playwright-core')

const port = process.env.FRAME_UI_PORT || '5173'
const origin = `http://127.0.0.1:${port}`
const layerId = 'test-line-layer'
const makeStroke = (id, x) => ({
  id, tool: 'pen', color: '#222222', size: 5, opacity: 1, pressure: true,
  points: [{ x, y: 170, p: 1 }, { x: x + 50, y: 260, p: 1 }],
})
const project = {
  name: 'AI smoke test', fps: 8,
  frames: [
    { id: 'keyframe-1', tracks: { [layerId]: [makeStroke('a', 180)] } },
    { id: 'keyframe-2', tracks: { [layerId]: [makeStroke('b', 400)] } },
  ],
  layers: [{ id: layerId, name: 'Line art', visible: true, locked: false }],
  activeFrame: 0, activeLayer: layerId,
  onion: true, grid: false, background: '#ffffff',
}

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
  })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(value => {
      localStorage.setItem('frame-studio-autosave-v1', JSON.stringify(value))
    }, project)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /PCでスタジオを開く/ }).click()
    await page.getByRole('button', { name: /AIアシスト/ }).click()
    const dialog = page.getByRole('dialog', { name: /アニメ制作AIアシスト/ })
    await dialog.waitFor()
    await dialog.locator('.ai-feature').nth(1).click()
    await dialog.getByRole('button', { name: /候補を生成する/ }).click()
    await dialog.locator('img.ai-preview').waitFor({ timeout: 30000 })
    assert.match(await dialog.locator('.ai-result').innerText(), /中間|枚/)
    await dialog.getByRole('button', { name: /この候補を採用/ }).click()
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('frame-studio-autosave-v1')
      return raw && JSON.parse(raw).frames.length === 4
    }, null, { timeout: 6000 })
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('frame-studio-autosave-v1')))
    assert.equal(saved.frames.length, 4)
    assert.equal(saved.frames[1].tracks[layerId].length, 1)
    assert.equal(saved.frames[2].tracks[layerId].length, 1)
    assert.equal(saved.frames[1].tracks[layerId][0].points[0].x < saved.frames[2].tracks[layerId][0].points[0].x, true)
    assert.deepEqual(errors, [])
    console.log(`PASS: ${origin} PC AI vector inbetween preview and apply (2 -> 4 frames)`)

    // Simulate an installed but inactive PC model: it must require a click.
    const modelContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    let loaded = false
    let loadCalls = 0
    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
    await modelContext.route('http://127.0.0.1:8766/api/**', async route => {
      const request = route.request()
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders })
      } else if (request.url().endsWith('/api/model/load')) {
        assert.equal(JSON.parse(request.postData()).source, 'detected')
        loadCalls++
        loaded = true
        await route.fulfill({ status: 200, contentType: 'application/json', headers: corsHeaders,
          body: JSON.stringify({ neuralReady: true, neuralModel: 'rife-v4.6', message: 'モデルを読み込みました' }) })
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', headers: corsHeaders,
          body: JSON.stringify({ ready: true, neuralReady: loaded, neuralInstalled: true,
            neuralModel: loaded ? 'rife-v4.6' : null, detectedModel: 'rife-v4.6' }) })
      }
    })
    const modelPage = await modelContext.newPage()
    await modelPage.goto(origin, { waitUntil: 'domcontentloaded' })
    await modelPage.getByRole('button', { name: /PCでスタジオを開く/ }).click()
    await modelPage.getByRole('button', { name: /AIアシスト/ }).click()
    const modelDialog = modelPage.getByRole('dialog', { name: /アニメ制作AIアシスト/ })
    await modelDialog.getByText(/検出済み・読み込み待ち/).waitFor()
    assert.equal(await modelDialog.getByRole('button', { name: /候補を生成する/ }).isDisabled(), true)
    await modelDialog.getByRole('button', { name: /検出したモデルを読み込む/ }).click()
    await modelDialog.locator('.ai-model-title em.loaded').waitFor()
    assert.equal(loadCalls, 1)
    assert.equal(await modelDialog.getByRole('button', { name: /候補を生成する/ }).isEnabled(), true)
    console.log('PASS: PC model requires explicit load; loading enables neural assist')
    await modelContext.close()

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const mobile = await mobileContext.newPage()
    await mobile.goto(origin, { waitUntil: 'domcontentloaded' })
    await mobile.getByRole('button', { name: /スマホで描く/ }).click()
    await mobile.locator('#code-input').fill('12345')
    assert.equal(await mobile.locator('#code-input').inputValue(), '12345')
    console.log('PASS: mobile pairing UI and numeric code entry')
    await mobileContext.close()
    await context.close()
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
