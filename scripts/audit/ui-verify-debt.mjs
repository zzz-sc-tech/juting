/**
 * 欠账清零回归（10 项）：卡片/筛选/字号档位/警示色
 *
 * 用法（仓库根目录执行，需先起 8101 预览）：
 *   npm run build --workspace @juting/web-app
 *   node scripts/local/start-all.mjs
 *   node scripts/audit/ui-verify-debt.mjs
 * 真机脚本额外需要：模拟器 + adb forward tcp:9222 localabstract:chrome_devtools_remote
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'

// 浏览器路径可用环境变量覆盖（换机器时改这两行即可）
const PW_DEFAULT = 'C:/Users/Zsc/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Users/Zsc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
fs.mkdirSync('temp/review', { recursive: true })
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? PW_DEFAULT)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BASE = 'http://127.0.0.1:8101'
const EXEC = CHROME_PATH
const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ['--mute-audio'] })

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// 造 3 门在学课程，用来验证「课程完成度」卡在 ≥2 门时出现
const seed = async (page) => {
  await page.goto(BASE + '/home', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.setItem('juting.web.theme.v1', '"paper"')
    const store = JSON.parse(localStorage.getItem('juting.web.progress.v1') || '{}')
    store.progressByExercise = {
      ...(store.progressByExercise || {}),
      1001: { lines: { l1: { repeatCount: 1, mastered: true, unclear: false } }, vocabulary: { research: 'research on it' } },
      1002: { lines: { l2: { repeatCount: 2, mastered: true, unclear: false } }, vocabulary: { campus: 'on campus' } },
      1003: { lines: { l3: { repeatCount: 0, mastered: false, unclear: true } } },
    }
    localStorage.setItem('juting.web.progress.v1', JSON.stringify(store))
  })
}

// ── 首页卡片：0 门 → 3 张；3 门 → 4 张 ─────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/home', { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => localStorage.clear())
  await p.goto(BASE + '/home', { waitUntil: 'networkidle' })
  await sleep(1000)
  const zero = await p.locator('.dashboard-side > section').count()
  check('零数据右栏 3 张卡', zero === 3, `count=${zero}`)

  await seed(p)
  await p.goto(BASE + '/home', { waitUntil: 'networkidle' })
  await sleep(1200)
  const three = await p.locator('.dashboard-side > section').count()
  const hasCourses = await p.locator('.dashboard-courses-card').count()
  check('3 门在学出现「课程完成度」', three === 4 && hasCourses === 1, `count=${three}`)
  await p.screenshot({ path: 'temp/review/final-home-cards.png' })
  await ctx.close()
}

// ── 生词本本地筛选 ──────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await seed(p)
  await p.goto(BASE + '/vocabulary', { waitUntil: 'networkidle' })
  await sleep(1200)
  const before = await p.locator('.vocab-row').count()
  await p.locator('.vocab-search input').fill('camp')
  await sleep(400)
  const after = await p.locator('.vocab-row').count()
  check('生词本筛选生效', before >= 2 && after === 1, `${before} → ${after}`)
  await p.locator('.vocab-search input').fill('zzzz')
  await sleep(300)
  const noMatch = await p.locator('.vocab-no-match').count()
  check('无匹配给提示', noMatch === 1)
  await p.screenshot({ path: 'temp/review/final-vocab-search.png' })
  await ctx.close()
}

// ── 搜索页 → 生词本带 ?q= ───────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await seed(p)
  await p.goto(BASE + '/vocabulary?q=campus', { waitUntil: 'networkidle' })
  await sleep(1200)
  const value = await p.locator('.vocab-search input').inputValue()
  const rows = await p.locator('.vocab-row').count()
  check('?q= 初始化筛选', value === 'campus' && rows === 1, `q=${value} rows=${rows}`)
  await ctx.close()
}

// ── 字号档位（计算样式）─────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await seed(p)
  const sizes = new Set()
  const weights = new Set()
  for (const path of ['/home', '/courses/9/chapters/1001?stage=intensive', '/vocabulary', '/settings', '/search']) {
    await p.goto(BASE + path, { waitUntil: 'networkidle' })
    await sleep(900)
    const found = await p.evaluate(() => {
      const s = new Set(), w = new Set()
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || !el.textContent?.trim()) continue
        s.add(cs.fontSize)
        w.add(cs.fontWeight)
      }
      return { s: [...s], w: [...w] }
    })
    found.s.forEach((x) => sizes.add(x))
    found.w.forEach((x) => weights.add(x))
  }
  const sorted = [...sizes].sort((a, b) => parseFloat(a) - parseFloat(b))
  check('字号档位 ≤ 9', sorted.length <= 9, sorted.join(' / '))
  check('字重档位 ≤ 5', weights.size <= 5, [...weights].sort().join(' / '))
  await ctx.close()
}

// ── warning / danger 分离 ───────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=exam', { waitUntil: 'networkidle' })
  await sleep(1500)
  const colors = await p.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    return { warning: root.getPropertyValue('--warning').trim(), accent: root.getPropertyValue('--accent').trim(), danger: root.getPropertyValue('--danger').trim() }
  })
  check('paper warning ≠ accent', colors.warning !== colors.accent, JSON.stringify(colors))
  for (const theme of ['gazette', 'exam']) {
    await p.evaluate((t) => { localStorage.setItem('juting.web.theme.v1', JSON.stringify(t)); document.documentElement.dataset.theme = t }, theme)
    await sleep(300)
    const c = await p.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      return { warning: root.getPropertyValue('--warning').trim(), accent: root.getPropertyValue('--accent').trim() }
    })
    check(`${theme} warning ≠ accent`, c.warning !== c.accent, JSON.stringify(c))
  }
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  for (const f of failed) console.log(' -', f.name, f.detail)
  process.exitCode = 1
}
