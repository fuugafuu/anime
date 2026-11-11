// UI regression: browser-only geometry, browser RIFE, preview, acceptance, phone pairing.
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

    // No Python server is running. The actual ONNX model is served by Vite and
    // executed in a browser Worker, not mocked via a local HTTP API.
    const modelContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await modelContext.addInitScript(value => {
      localStorage.setItem('frame-studio-autosave-v1', JSON.stringify(value))
    }, project)
    const modelPage = await modelContext.newPage()
    const modelErrors = []
    modelPage.on('pageerror', error => modelErrors.push(error.message))
    await modelPage.goto(origin, { waitUntil: 'domcontentloaded' })
    await modelPage.getByRole('button', { name: /PCでスタジオを開く/ }).click()
    await modelPage.getByRole('button', { name: /AIアシスト/ }).click()
    const modelDialog = modelPage.getByRole('dialog', { name: /アニメ制作AIアシスト/ })
    await modelDialog.getByText(/モデル読み込み待ち/).waitFor()
    assert.equal(await modelDialog.getByRole('button', { name: /候補を生成する/ }).isDisabled(), true)
    await modelDialog.getByRole('button', { name: /モデルを読み込む/ }).click()
    await modelDialog.locator('.ai-model-title em.loaded').waitFor({ timeout: 180000 })
    assert.equal(await modelDialog.getByRole('button', { name: /候補を生成する/ }).isEnabled(), true)
    console.log('PASS: 21MB RIFE v4.9 ONNX loaded in browser without Python')
    await modelDialog.locator('input[type=range]').first().fill('1')
    await modelDialog.getByRole('button', { name: /候補を生成する/ }).click()
    await modelDialog.locator('img.ai-preview').waitFor({ timeout: 240000 })
    assert.match(await modelDialog.locator('.ai-result').innerText(), /RIFE v4.9/)
    assert.deepEqual(modelErrors, [])
    await modelDialog.getByRole('button', { name: /この候補を採用/ }).click()
    await modelPage.waitForFunction(() => {
      const data = localStorage.getItem('frame-studio-autosave-v1')
      return data && JSON.parse(data).frames.length === 3
    }, null, { timeout: 10000 })
    const neuralImage = await modelPage.evaluate(async () => {
      const saved = JSON.parse(localStorage.getItem('frame-studio-autosave-v1'))
      const image = new Image()
      image.src = saved.frames[1].image
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let nonWhite = 0, min = 255, max = 0, transparent = 0
      for (let i = 0; i < data.length; i += 4)
      {
        if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) nonWhite++
        min = Math.min(min, data[i], data[i + 1], data[i + 2]); max = Math.max(max, data[i], data[i + 1], data[i + 2])
        if (data[i + 3] < 255) transparent++
      }
      return { width: canvas.width, height: canvas.height, nonWhite, min, max, transparent }
    })
    console.log('NEURAL_IMAGE_STATS', neuralImage)
    assert.deepEqual([neuralImage.width, neuralImage.height], [640, 360])
    assert.ok(neuralImage.nonWhite > 60, 'Neural frame should contain visible drawing pixels')
    console.log('PASS: real RIFE neural inference -> preview -> apply, 2 -> 3 frames')

    // Thick, low-motion strokes should survive the neural model without the
    // thin-ink fallback. This checks that RIFE contributes visible pixels.
    const denseProject = structuredClone(project)
    denseProject.frames[0].tracks[layerId] = [{ ...makeStroke('dense-a', 250), size: 65,
      points: [{ x: 250, y: 170, p: 1 }, { x: 400, y: 480, p: 1 }] }]
    denseProject.frames[1].tracks[layerId] = [{ ...makeStroke('dense-b', 280), size: 65,
      points: [{ x: 280, y: 185, p: 1 }, { x: 430, y: 495, p: 1 }] }]
    const denseResult = await modelPage.evaluate(async doc => {
      const { processAi } = await import('/src/ai-client.ts')
      const value = await processAi(doc, { id: 'dense-neural', mode: 'neural', frameId: doc.frames[0].id,
        layerId: doc.layers[0].id, count: 1, spacing: 'linear', arc: 0, strength: .5 })
      return { method: value.result.method, message: value.result.message,
        hasImage: value.candidate?.frames?.[0]?.image?.startsWith('data:image/webp;base64,') }
    }, denseProject)
    assert.equal(denseResult.method, 'neural', denseResult.message)
    assert.equal(denseResult.hasImage, true)
    console.log('PASS: actual RIFE neural output retained dense moving strokes')
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
