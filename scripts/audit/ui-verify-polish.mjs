/**
 * 收尾批回归（7 项）：锚点条/序号/主题色/顶栏
 *
 * 用法（仓库根目录执行，需先起 8101 预览）：
 *   npm run build --workspace @juting/web-app
 *   node scripts/local/start-all.mjs
 *   node scripts/audit/ui-verify-polish.mjs
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

// ── 锚点收敛 ────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'networkidle' })
  await sleep(1600)
  const info = await p.evaluate(() => {
    const bar = document.querySelector('.dialogue-anchor-bar')
    if (!bar) return null
    const chips = [...bar.querySelectorAll('.dialogue-anchor-chip')]
    return {
      chips: chips.length,
      hasSelect: !!bar.querySelector('select'),
      chipLabels: chips.map((b) => b.textContent.trim()),
      barHeight: Math.round(bar.getBoundingClientRect().height),
      scrollW: bar.scrollWidth,
      clientW: bar.clientWidth,
      overflowX: getComputedStyle(bar).overflowX,
    }
  })
  // 2026-10-21 改版：锚点从「3 + 下拉」改成单行横向滚动，全部常驻。
  // 旧断言（控件 ≤5、必须有下拉）已作废，改成校验新形态的三条特征。
  check('全部锚点常驻（不再折叠）', info && info.chips >= 16, `chips=${info?.chips}`)
  check('下拉已移除', info && !info.hasSelect)
  check('单行高度 ≤60px', info && info.barHeight <= 60, `h=${info?.barHeight}`)
  check('可横向滚动', info && info.overflowX === 'auto' && info.scrollW > info.clientW,
    `${info?.scrollW}>${info?.clientW}`)
  // 点后段锚点能跳转且自动滚入视野
  const before = await p.locator('.subtitle-topline, .line-index').first().innerText().catch(() => '')
  const chips = p.locator('.dialogue-anchor-chip')
  if (await chips.count() > 14) {
    await chips.nth(14).click().catch(() => {})
    await sleep(900)
  }
  const after = await p.locator('.subtitle-topline, .line-index').first().innerText().catch(() => '')
  check('点后段锚点可跳转', before !== after, `${before.slice(0, 12)} → ${after.slice(0, 12)}`)
  const follow = await p.evaluate(() => {
    const bar = document.querySelector('.dialogue-anchor-bar')
    const a = document.querySelector('.dialogue-anchor-chip.active')
    if (!bar || !a) return null
    const br = bar.getBoundingClientRect(), ar = a.getBoundingClientRect()
    return { scrollLeft: bar.scrollLeft, visible: ar.left >= br.left - 2 && ar.right <= br.right + 2 }
  })
  check('当前锚点自动滚入视野', follow?.visible === true, JSON.stringify(follow))
  await p.screenshot({ path: 'temp/review/rest-anchors.png' })
  await ctx.close()
}

// ── minimal 序号 ────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'networkidle' })
  await p.evaluate(() => { localStorage.setItem('juting.web.theme.v1', '"minimal"'); document.documentElement.dataset.theme = 'minimal' })
  await sleep(900)
  const nums = await p.evaluate(() => {
    const els = [...document.querySelectorAll('.stage-number')]
    return els.map((el) => ({ text: el.textContent.trim(), display: getComputedStyle(el).display, w: Math.round(el.getBoundingClientRect().width) }))
  })
  check('minimal 保留阶段序号', nums.length >= 3 && nums.every((n) => n.display !== 'none' && n.w > 0), JSON.stringify(nums.slice(0, 3)))
  await p.screenshot({ path: 'temp/review/rest-minimal-stage.png' })
  await ctx.close()
}

// ── 设置页顶栏高亮 ──────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/settings', { waitUntil: 'networkidle' })
  await sleep(700)
  const active = await p.evaluate(() => {
    const el = document.querySelector('.account-trigger.active')
    return el ? { label: el.getAttribute('aria-label'), current: el.getAttribute('aria-current') } : null
  })
  check('设置页顶栏高亮', active && active.current === 'page', JSON.stringify(active))
  await ctx.close()
}

// ── paper warning 对比度 ────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=exam', { waitUntil: 'networkidle' })
  await sleep(1500)
  const c = await p.evaluate(() => {
    const parse = (s) => { const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/); return m ? [+m[1], +m[2], +m[3]] : [255, 255, 255] }
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const el = [...document.querySelectorAll('.exam-hint, .exam-window, p, span')].find((n) => n.textContent.includes('还没播到'))
    if (!el) return null
    const cs = getComputedStyle(el)
    let bg = 'rgb(255,255,255)'
    let node = el
    while (node) {
      const c2 = getComputedStyle(node).backgroundColor
      if (c2 && !c2.includes('rgba(0, 0, 0, 0)')) { bg = c2; break }
      node = node.parentElement
    }
    const a = lum(parse(cs.color)), b = lum(parse(bg))
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    return { color: cs.color, bg, ratio: Math.round(ratio * 100) / 100 }
  })
  check('考试提示对比度 ≥4.5:1', c && c.ratio >= 4.5, JSON.stringify(c))
  await ctx.close()
}

// ── gazette 中文字体 ────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=extensive', { waitUntil: 'networkidle' })
  await p.evaluate(() => { localStorage.setItem('juting.web.theme.v1', '"gazette"'); document.documentElement.dataset.theme = 'gazette' })
  await sleep(800)
  const fam = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim())
  check('gazette 中文不再回落宋体', fam.includes('Microsoft YaHei'), fam.slice(0, 60))
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  for (const f of failed) console.log(' -', f.name, f.detail)
  process.exitCode = 1
}
