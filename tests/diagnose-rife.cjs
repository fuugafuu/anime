const { chromium } = require(process.env.PLAYWRIGHT_CORE_MODULE || 'playwright-core')

;(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) })
  try {
    const page = await browser.newPage()
    page.on('console', message => { if (message.type() !== 'log') console.log('CONSOLE', message.type(), message.text().slice(0, 1200)) })
    page.on('pageerror', error => console.log('PAGEERROR', error.message))
    page.on('requestfailed', req => console.log('REQUEST_FAILED', req.url(), req.failure()?.errorText))
    const url = `http://127.0.0.1:${process.env.FRAME_UI_PORT || '5173'}`
    await page.goto(url)
    await page.locator('button').filter({ hasText: 'PCでスタジオを開く' }).click()
    await page.locator('button').filter({ hasText: 'AIアシスト' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'アニメ制作AIアシスト' })
    await dialog.getByRole('button', { name: 'モデルを読み込む' }).click()
    await Promise.race([
      dialog.locator('.ai-model-title em.loaded').waitFor({ timeout: 90000 }).then(() => console.log('MODEL_LOADED')),
      dialog.locator('.ai-model-feedback.failure').waitFor({ timeout: 90000 }).then(async () => console.log('MODEL_FAILED', await dialog.locator('.ai-model-feedback.failure').innerText())),
    ])
    console.log('PROGRESS', await dialog.locator('.ai-model-primary').innerText())
  } finally { await browser.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
