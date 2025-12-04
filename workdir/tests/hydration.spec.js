import { test, expect } from '@playwright/test'

test.describe('SSR Hydration Debug', () => {
  test('compare SSR output vs client render - accurate theme check', async ({ page, request }) => {
    console.log('\n========================================')
    console.log('Detailed SSR vs Client comparison')
    console.log('========================================\n')

    // Get SSR HTML with cache bust
    const cacheBuster = Date.now()
    const url = `/?_cb=${cacheBuster}`

    const ssrResponse = await request.get(url, {
      headers: { 'Cache-Control': 'no-cache' }
    })
    const ssrHtml = await ssrResponse.text()

    console.log('SSR Response status:', ssrResponse.status())
    console.log('SSR HTML length:', ssrHtml.length)

    // Find data-theme as an HTML ATTRIBUTE (not in CSS selectors)
    // Look for it in actual element tags like <div data-theme="...">
    const ssrThemeMatch = ssrHtml.match(/<[^>]+data-theme="([^"]+)"[^>]*>/)
    console.log('SSR data-theme (in element):', ssrThemeMatch ? ssrThemeMatch[1] : 'not found in elements')

    // Also check CSS selectors for comparison (these are styling, not actual elements)
    const cssThemeSelectors = ssrHtml.match(/\[data-theme="[^"]+"\]/g) || []
    console.log('CSS theme selectors found:', cssThemeSelectors.length)

    // Capture hydration issues
    const hydrationIssues = []
    const allLogs = []

    page.on('console', (msg) => {
      const text = msg.text()
      allLogs.push(`[${msg.type()}] ${text}`)
      if (text.toLowerCase().includes('hydration') || text.includes('mismatch')) {
        hydrationIssues.push(text)
      }
    })

    // Clear cookies
    await page.context().clearCookies()

    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)

    // Get client theme from actual DOM elements
    const clientThemeInfo = await page.evaluate(() => {
      const elements = document.querySelectorAll('[data-theme]')
      const themes = [...elements].map(el => ({
        tag: el.tagName,
        theme: el.getAttribute('data-theme'),
        classes: el.className.slice(0, 50)
      }))
      return {
        count: elements.length,
        firstTheme: themes[0]?.theme,
        themes: themes.slice(0, 5)
      }
    })

    console.log('\nClient data-theme elements:', JSON.stringify(clientThemeInfo, null, 2))

    // Check theme detection
    const themeDebug = await page.evaluate(() => {
      return {
        localStorage_theme: localStorage.getItem('theme'),
        prefersDark: window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false,
        firstDataTheme: document.querySelector('[data-theme]')?.getAttribute('data-theme')
      }
    })
    console.log('\nClient theme state:', JSON.stringify(themeDebug, null, 2))

    console.log('\n=== Console logs ===')
    allLogs.forEach(l => console.log(l))

    if (hydrationIssues.length > 0) {
      console.log('\n=== HYDRATION ISSUES ===')
      hydrationIssues.forEach(i => console.log(i))

      console.log('\nAnalysis:')
      console.log(`- SSR theme (in element): ${ssrThemeMatch ? ssrThemeMatch[1] : 'none'}`);
      console.log(`- Client theme: ${clientThemeInfo.firstTheme}`);

      if (ssrThemeMatch && clientThemeInfo.firstTheme && ssrThemeMatch[1] !== clientThemeInfo.firstTheme) {
        console.log('>>> THEME MISMATCH - SSR and client rendered different themes!')
      }
    }

    expect(hydrationIssues, 'Hydration mismatch detected').toHaveLength(0)
  })
})
