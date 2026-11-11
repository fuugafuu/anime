// Optional real-network integration test. Requires public PeerJS signaling/WebRTC.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_CORE_MODULE || 'playwright-core')
const origin = `http://127.0.0.1:${process.env.FRAME_UI_PORT || '5173'}`

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
  })
  try {
    const pcContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const pc = await pcContext.newPage()
    const phone = await phoneContext.newPage()
    await Promise.all([pc.goto(origin), phone.goto(origin)])
    await pc.getByRole('button', { name: /PCでスタジオを開く/ }).click()
    await pc.waitForFunction(() => [...document.querySelectorAll('.session-code span')].map(s => s.textContent).join('').match(/^\d{5}$/), null, { timeout: 15000 })
    const code = await pc.locator('.session-code span').allTextContents().then(items => items.join(''))
    assert.match(code, /^\d{5}$/)
    await phone.getByRole('button', { name: /スマホで描く/ }).click()
    await phone.locator('#code-input').fill(code)
    await phone.locator('.connect-submit').click()
    await pc.locator('.approval .primary').waitFor({ timeout: 25000 })
    await pc.locator('.approval .primary').click()
    await Promise.all([
      pc.locator('.connection-pill.is-connected').waitFor({ timeout: 25000 }),
      phone.locator('.connection-pill.is-connected').waitFor({ timeout: 25000 }),
    ])
    const drawing = phone.locator('.draw-canvas')
    const box = await drawing.boundingBox()
    assert.ok(box && box.width > 100 && box.height > 50)
    const sx = box.x + box.width * .35
    const sy = box.y + box.height * .45
    await phone.mouse.move(sx, sy)
    await phone.mouse.down()
    await phone.mouse.move(sx + 16, sy + 19, { steps: 8 })
    await phone.mouse.up()
    await pc.waitForFunction(() => {
      const raw = localStorage.getItem('frame-studio-autosave-v1')
      if (!raw) return false
      const doc = JSON.parse(raw)
      return doc.frames.some(f => Object.values(f.tracks).some(tracks => tracks.length > 0))
    }, null, { timeout: 15000 })
    const snapshot = JSON.parse(await pc.evaluate(() => localStorage.getItem('frame-studio-autosave-v1')))
    assert.ok(snapshot.frames.some(frame => Object.values(frame.tracks).some(strokes => strokes.length > 0)))
    console.log(`PASS: paired PC+phone with code ${code.slice(0, 1)}**** and synchronized a committed stroke`)
    await phoneContext.close()
    await pcContext.close()
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
