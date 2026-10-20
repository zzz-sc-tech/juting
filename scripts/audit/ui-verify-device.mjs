/**
 * 真机（Android Chrome）验收：词典侧栏 + 吸顶导航
 *
 * 用法（仓库根目录执行，需先起 8101 预览）：
 *   npm run build --workspace @juting/web-app
 *   node scripts/local/start-all.mjs
 *   node scripts/audit/ui-verify-device.mjs
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
const BASE = process.env.PREVIEW_BASE ?? 'http://10.0.2.2:8105'

const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('8105')) ?? ctx.pages()[0]

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ── 生词侧栏 ────────────────────────────────────────────
await page.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'networkidle' })
await sleep(1800)
await page.locator('.control-cluster .icon-button').nth(3).click().catch(() => {})
await sleep(700)
await page.locator('.clickable-word').nth(3).click()
await sleep(900)
const sb = await page.evaluate(() => {
  const el = document.querySelector('.vocab-sidebar')
  const b = el.getBoundingClientRect()
  const foot = document.querySelector('.vocab-sidebar-foot').getBoundingClientRect()
  const close = document.querySelector('.vocab-sidebar-close').getBoundingClientRect()
  const vv = window.visualViewport
  return {
    top: Math.round(b.top),
    bottom: Math.round(b.bottom),
    h: Math.round(b.height),
    footTop: Math.round(foot.top),
    footBottom: Math.round(foot.bottom),
    closeW: Math.round(close.width),
    closeH: Math.round(close.height),
    vvH: vv ? Math.round(vv.height) : null,
    innerH: innerHeight,
  }
})
check('侧栏贴住视口顶部', sb.top === 0, JSON.stringify(sb))
check('侧栏不超出可见视口', sb.bottom <= sb.vvH + 1, `bottom=${sb.bottom} vvH=${sb.vvH}`)
check('底部动作按钮在可见区内', sb.footBottom <= sb.vvH + 1, `footBottom=${sb.footBottom}`)
check('关闭按钮 ≥44px', sb.closeW >= 44 && sb.closeH >= 44, `${sb.closeW}×${sb.closeH}`)
await page.screenshot({ path: 'temp/review/dev2-sidebar.png' })
await page.locator('.vocab-sidebar-close').click().catch(() => {})
await sleep(400)

// ── 考试页：切题后不被吸顶导航盖住 ─────────────────────
await page.goto(BASE + '/courses/9/chapters/1001?stage=exam', { waitUntil: 'networkidle' })
await sleep(1800)
await page.evaluate(() => { document.querySelector('.study-pane').scrollTop = 340 })
await sleep(500)
const before = await page.evaluate(() => {
  const nav = document.querySelector('.exam-navigator').getBoundingClientRect()
  const card = document.querySelector('.exam-question-card').getBoundingClientRect()
  return { navBottom: Math.round(nav.bottom), cardTop: Math.round(card.top) }
})
await page.locator('.exam-nav-cell').nth(2).click()
await sleep(900)
const after = await page.evaluate(() => {
  const nav = document.querySelector('.exam-navigator').getBoundingClientRect()
  const card = document.querySelector('.exam-question-card').getBoundingClientRect()
  return { navBottom: Math.round(nav.bottom), cardTop: Math.round(card.top), gap: Math.round(card.top - nav.bottom) }
})
check('切题后题干不被导航遮挡', after.gap >= 0, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
await page.screenshot({ path: 'temp/review/dev2-exam-jump.png' })

// ── 横屏 ────────────────────────────────────────────────
await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exitCode = 1
