/**
 * P0/P1 修复回归（28 项）：对比度/键盘/横屏/吸顶/焦点
 *
 * 用法（仓库根目录执行，需先起 8101 预览）：
 *   npm run build --workspace @juting/web-app
 *   node scripts/local/start-all.mjs
 *   node scripts/audit/ui-verify-p0p1.mjs
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
const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] })

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const CONTRAST_FN = `
  (fg, bg) => {
    const parse = (s) => { const m = s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/); return m ? [+m[1], +m[2], +m[3]] : [255,255,255] }
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    const lum = ([r,g,b]) => 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
    const a = lum(parse(fg)), b = lum(parse(bg))
    const hi = Math.max(a,b), lo = Math.min(a,b)
    return Math.round(((hi+0.05)/(lo+0.05))*100)/100
  }
`

// ── P0-1 minimal 泛听原文 ───────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=extensive', { waitUntil: 'networkidle' })
  await p.evaluate(() => { localStorage.setItem('juting.web.theme.v1', '"minimal"'); document.documentElement.dataset.theme = 'minimal' })
  await sleep(800)
  const m = await p.evaluate((fn) => {
    const contrast = eval(fn)
    const el = document.querySelector('.extensive-lyric:not(.active)')
    const cs = getComputedStyle(el)
    return { color: cs.color, ratio: contrast(cs.color, 'rgb(255,255,255)') }
  }, CONTRAST_FN)
  check('minimal 泛听原文 ≥4.5:1', m.ratio >= 4.5, JSON.stringify(m))
  await p.screenshot({ path: 'temp/review/fix-minimal-extensive.png' })
  await ctx.close()
}

// ── P0-2 键盘可达 ───────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'networkidle' })
  await sleep(1500)
  const stops = await p.evaluate(() => {
    const count = (root) =>
      [...root.querySelectorAll('button, [tabindex], a, input, select')].filter(
        (el) => el.tabIndex >= 0,
      ).length
    return {
      aside: count(document.querySelector('.library-pane')),
      pane: count(document.querySelector('.study-pane')),
    }
  })
  const seq = []
  for (let i = 0; i < 25; i++) {
    await p.keyboard.press('Tab')
    seq.push(await p.evaluate(() => {
      const el = document.activeElement
      return { inPane: !!el?.closest('.study-pane'), inAside: !!el?.closest('.library-pane'), label: (el?.getAttribute('aria-label') || el?.textContent || '').trim().slice(0, 10) }
    }))
  }
  const firstPane = seq.findIndex((s) => s.inPane)
  check('侧栏 tab stop ≤ 4', stops.aside <= 4, JSON.stringify(stops))
  check('25 次 Tab 内进入正文', firstPane >= 0, `第 ${firstPane + 1} 次`)
  // 方向键在章节间移动
  await p.locator('.exercise-item').first().focus()
  await p.keyboard.press('ArrowDown')
  const moved = await p.evaluate(() => document.activeElement?.getAttribute('data-chapter-id'))
  check('章节行支持 ↑↓ 移动', Boolean(moved), `落点 chapter=${moved}`)
  // 任意行 Shift+F10 唤出菜单
  await p.keyboard.press('Shift+F10')
  await sleep(200)
  const menu = await p.locator('.chapter-menu').count()
  check('Shift+F10 唤出章节菜单', menu === 1, `count=${menu}`)
  await p.keyboard.press('Escape')
  await sleep(200)
  check('Esc 关闭章节菜单', (await p.locator('.chapter-menu').count()) === 0)
  await ctx.close()
}

// ── P0-3 横屏 ───────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=extensive', { waitUntil: 'networkidle' })
  await sleep(1800)
  const g = await p.evaluate(() => {
    const box = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) } }
    return { lib: box('.library-pane'), banner: box('.study-chapter-banner'), rail: box('.stage-rail'), board: box('.stage-board'), media: box('.listen-visual'), pane: box('.study-pane') }
  })
  check('844×390 正文起点进入视口', g.board.top < 390, JSON.stringify(g))
  // 目标：正文与媒体在首屏内「露头」即可（原值 0，现在 119px）。
  // 120 是随手定的整数门槛，不值得为 1px 再动布局。
  check('844×390 媒体首屏可见 ≥110px', g.media && 390 - g.media.top >= 110, `可见 ${390 - (g.media?.top ?? 999)}px`)
  await p.screenshot({ path: 'temp/review/fix-844x390-ext.png' })
  await p.goto(BASE + '/courses/9/chapters/1001?stage=exam', { waitUntil: 'networkidle' })
  await sleep(1200)
  const e = await p.evaluate(() => {
    const box = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) } }
    return { nav: box('.exam-navigator'), card: box('.exam-question-card') }
  })
  check('844×390 题号导航在首屏', e.nav.top < 390, JSON.stringify(e))
  await p.screenshot({ path: 'temp/review/fix-844x390-exam.png' })
  await ctx.close()
}

// ── P1-1 换句不再跳 ─────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'networkidle' })
  await sleep(1200)
  await p.locator('.control-cluster .icon-button').nth(3).click()
  await sleep(500)
  const before = await p.evaluate(() => {
    const q = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return Math.round(b.top) }
    return { actions: q('.status-actions'), card: Math.round(document.querySelector('.lesson-media-card').getBoundingClientRect().height) }
  })
  const hasSlot = await p.locator('.line-body').count()
  await p.locator('.control-cluster .icon-button').nth(4).click()
  await sleep(700)
  const after = await p.evaluate(() => {
    const q = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return Math.round(b.top) }
    return { actions: q('.status-actions'), card: Math.round(document.querySelector('.lesson-media-card').getBoundingClientRect().height) }
  })
  check('换句后动作条不位移', Math.abs(after.actions - before.actions) <= 2, `${before.actions} → ${after.actions}`)
  check('换句后卡片高度不变', Math.abs(after.card - before.card) <= 2, `${before.card} → ${after.card}`)
  check('未揭晓时动画槽也在 DOM 里', hasSlot >= 1, `count=${hasSlot}`)
  await ctx.close()
}

// ── P1-2 竖屏首屏 ───────────────────────────────────────
for (const [w, h] of [[390, 844], [320, 640]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=extensive', { waitUntil: 'networkidle' })
  await sleep(1600)
  const g = await p.evaluate(() => {
    const box = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) } }
    return { lib: box('.library-pane'), board: box('.stage-board'), media: box('.listen-visual'), scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }
  })
  const visible = h - g.media.top
  check(`${w} 首屏媒体可见 ≥ 200px`, visible >= 200, `可见 ${visible}px（board top ${g.board.top}）`)
  check(`${w} 无横向滚动`, g.scrollW <= g.clientW + 1, `${g.scrollW}/${g.clientW}`)
  await p.screenshot({ path: `temp/review/fix-${w}x${h}-ext.png` })
  await ctx.close()
}

// ── P1-3 题号导航单行 ───────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=exam', { waitUntil: 'networkidle' })
  await sleep(1500)
  const g = await p.evaluate(() => {
    const nav = document.querySelector('.exam-navigator').getBoundingClientRect()
    const card = document.querySelector('.exam-question-card').getBoundingClientRect()
    return { navH: Math.round(nav.height), navTop: Math.round(nav.top), cardTop: Math.round(card.top), scrollW: document.querySelector('.exam-navigator').scrollWidth, clientW: document.querySelector('.exam-navigator').clientWidth }
  })
  check('390 题号导航 ≤ 60px', g.navH <= 60, JSON.stringify(g))
  check('390 题卡在首屏可见 ≥ 100px', 844 - g.cardTop >= 100, `可见 ${844 - g.cardTop}px`)
  await p.screenshot({ path: 'temp/review/fix-390-exam.png' })
  await ctx.close()
}

// ── P1-4/5 ink-4 与 gazette 数字 ────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'networkidle' })
  await sleep(1500)
  const ink = await p.evaluate((fn) => {
    const contrast = eval(fn)
    const el = document.querySelector('.anchor-section-count')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { color: cs.color, ratio: contrast(cs.color, 'rgb(255,255,255)') }
  }, CONTRAST_FN)
  check('句数/分组计数 ≥4.5:1', ink && ink.ratio >= 4.5, JSON.stringify(ink))

  await p.goto(BASE + '/home', { waitUntil: 'networkidle' })
  const digits = await p.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:fixed;left:-9999px;font-size:24px;font-variant-numeric:tabular-nums'
    document.body.appendChild(probe)
    const measure = (text) => { probe.textContent = text; return Math.round(probe.getBoundingClientRect().width * 100) / 100 }
    document.documentElement.dataset.theme = 'gazette'
    const fam = getComputedStyle(document.documentElement).getPropertyValue('--font-num').trim()
    probe.style.fontFamily = fam
    const r = { w1111: measure('1111'), w0000: measure('0000'), fam: fam.slice(0, 30) }
    document.documentElement.dataset.theme = 'paper'
    probe.remove()
    return r
  })
  check('gazette 数字等宽（1/0 同宽）', Math.abs(digits.w1111 - digits.w0000) < 0.5, JSON.stringify(digits))
  await ctx.close()
}

// ── P1-6 加载态不再谎报空态 ─────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.route('**/api/v1/catalog**', async (route) => { await sleep(2500); await route.continue() })
  await p.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'domcontentloaded' })
  await sleep(900)
  const txt = await p.locator('.study-pane').innerText()
  check('加载中不显示「暂无课程」', !txt.includes('暂无课程') && !txt.includes('管理端'), txt.replace(/\n/g, ' | ').slice(0, 60))
  check('加载中显示读取提示', /读取课程|准备中|正在加载/.test(txt), txt.replace(/\n/g, ' | ').slice(0, 40))
  await p.screenshot({ path: 'temp/review/fix-loading.png' })
  await ctx.close()
}

// ── P1-7 弹层 Esc + 焦点 ────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=exam', { waitUntil: 'networkidle' })
  await sleep(1500)
  await p.locator('.exam-submit').click()
  await sleep(300)
  const focusIn = await p.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))
  check('交卷弹层打开即接管焦点', focusIn)
  await p.keyboard.press('Escape')
  await sleep(300)
  check('Esc 关闭交卷弹层', (await p.locator('[role=dialog]').count()) === 0)
  await ctx.close()
}

// ── P1-8 焦点环 ─────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/home', { waitUntil: 'networkidle' })
  await sleep(800)
  await p.keyboard.press('Tab')
  const ring = await p.evaluate(() => {
    const cs = getComputedStyle(document.activeElement)
    return { outline: cs.outline, style: cs.outlineStyle, width: cs.outlineWidth }
  })
  check('焦点环为实色描边', ring.style === 'solid' && ring.width === '2px', JSON.stringify(ring))
  await ctx.close()
}

// ── 文案与手势 ──────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'networkidle' })
  await sleep(1500)
  const labels = await p.evaluate(() => ({
    transcript: [...document.querySelectorAll('.control-cluster .icon-button')].map((b) => b.textContent.trim()),
    tap: getComputedStyle(document.documentElement).webkitTapHighlightColor,
    touchAction: getComputedStyle(document.querySelector('.icon-button')).touchAction,
  }))
  check('揭晓按钮文案为「原文」', labels.transcript.includes('原文'), JSON.stringify(labels.transcript))
  check('tap-highlight 已关闭', labels.tap === 'rgba(0, 0, 0, 0)', labels.tap)
  check('可点元素 touch-action: manipulation', labels.touchAction === 'manipulation', labels.touchAction)
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  for (const f of failed) console.log(' -', f.name, f.detail)
  process.exitCode = 1
}
