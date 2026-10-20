/**
 * UI 回归（35 项）：布局/触控/首屏/考试页
 *
 * 用法（仓库根目录执行，需先起 8101 预览）：
 *   npm run build --workspace @juting/web-app
 *   node scripts/local/start-all.mjs
 *   node scripts/audit/ui-verify.mjs
 * 真机脚本额外需要：模拟器 + adb forward tcp:9222 localabstract:chrome_devtools_remote
 */
import { createRequire } from 'node:module'

// 浏览器路径可用环境变量覆盖（换机器时改这两行即可）
const PW_DEFAULT = 'C:/Users/Zsc/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Users/Zsc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? PW_DEFAULT)
const fs = require('node:fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BASE = 'http://127.0.0.1:8101'
const OUT = 'temp/ui-verify'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
})

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
}

// ── 1. 桌面 1440 ────────────────────────────────────────
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await desktop.newPage()

// 1a. 零数据首页：主 CTA 必须是「开始第一课」
await page.goto(BASE + '/home', { waitUntil: 'domcontentloaded' })
await page.evaluate(() => localStorage.clear())
await page.goto(BASE + '/home', { waitUntil: 'networkidle' })
await sleep(1200)
const solidBtns = await page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('button, a')) {
    const s = getComputedStyle(el)
    const bg = s.backgroundColor
    const m = bg.match(/rgba?\((\d+), (\d+), (\d+)/)
    if (!m) continue
    const [r, g, b] = [+m[1], +m[2], +m[3]]
    // 主色实心（松绿/黑/红都算「实心主按钮」）：非白底、非透明、面积够大
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    if (lum > 0.75 || lum < 0.02) {
      if (lum > 0.75) continue
    }
    const box = el.getBoundingClientRect()
    if (box.width < 60 || box.height < 24) continue
    if (bg.includes('rgba(0, 0, 0, 0)')) continue
    out.push({ text: el.textContent.trim().slice(0, 20), bg, w: Math.round(box.width), h: Math.round(box.height) })
  }
  return out
})
const startBtn = await page.locator('.dashboard-continue-card .dashboard-primary-button').innerText()
check('零数据首页主 CTA = 开始第一课', startBtn.includes('开始第一课'), startBtn.trim())
check('零数据首页实心按钮 ≤ 1', solidBtns.length <= 1, JSON.stringify(solidBtns))
await shot(page, '1440-home-empty')

await page.locator('.dashboard-continue-card .dashboard-primary-button').click()
await sleep(800)
check('点「开始第一课」进入 /courses', page.url().includes('/courses'), page.url())

// 1b. 零数据 /review 空态
await page.goto(BASE + '/review', { waitUntil: 'networkidle' })
await sleep(1000)
const reviewEmpty = await page.locator('.page-empty').innerText()
check('零数据 /review 提示「还没有标记」', reviewEmpty.includes('还没有标记'), reviewEmpty.replace(/\n/g, ' | '))
check('/review 空态有「去逐句学习」', reviewEmpty.includes('去逐句学习'))
await shot(page, '1440-review-empty')

// 1c. 种入学习数据后回到首页
await page.evaluate(() => {
  localStorage.setItem('juting.web.activity.v1', JSON.stringify({
    '2026-10-11': 3, '2026-10-12': 5, '2026-10-13': 2, '2026-10-14': 8,
    '2026-10-15': 6, '2026-10-16': 9, '2026-10-17': 4,
  }))
  localStorage.setItem('juting.web.listen-time.v1', JSON.stringify({
    totalMs: 5820000, byDay: { '2026-10-16': 2400000, '2026-10-17': 3420000 },
  }))
  const store = JSON.parse(localStorage.getItem('juting.web.study.v1') || '{}')
  store.activeExerciseId = 1001
  store.progressByExercise = {
    ...(store.progressByExercise || {}),
    1001: { lines: { '1001-l1': { repeatCount: 2, mastered: true, unclear: false }, '1001-l2': { repeatCount: 1, mastered: false, unclear: true } } },
  }
  localStorage.setItem('juting.web.study.v1', JSON.stringify(store))
})
await page.goto(BASE + '/home', { waitUntil: 'networkidle' })
await sleep(1500)
await shot(page, '1440-home')

const heroGoal = await page.locator('.dashboard-hero-count').innerText()
const heroSize = await page.locator('.dashboard-hero-count strong').evaluate((el) => getComputedStyle(el).fontSize)
check('首页 hero 显示今日进度', /\d/.test(heroGoal), heroGoal.replace(/\n/g, ' '))
check('首页 hero 主数字 28px', heroSize === '28px', heroSize)

// 1d. 精听：字幕按钮初始非激活 + 占位提示
await page.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'networkidle' })
await sleep(1200)
const transcriptBtnClass = await page.locator('.control-cluster .icon-button').nth(3).getAttribute('class')
const placeholder = await page.locator('.subtitle-placeholder').count()
check('精听「字幕」按钮初始非激活', !transcriptBtnClass.includes('reveal'), transcriptBtnClass)
check('精听未揭晓有占位提示', placeholder === 1, `count=${placeholder}`)
await shot(page, '1440-intensive')

const beforeText = await page.locator('.subtitle-text').innerText()
await page.locator('.control-cluster .icon-button').nth(3).click()
await sleep(500)
const afterClass = await page.locator('.control-cluster .icon-button').nth(3).getAttribute('class')
const afterText = await page.locator('.subtitle-text').innerText()
check('点「字幕」后按钮激活', afterClass.includes('reveal'), afterClass)
check('点「字幕」后原文出现', afterText.length > beforeText.length, `${beforeText.slice(0, 12)} → ${afterText.slice(0, 30)}`)
await shot(page, '1440-intensive-revealed')

const actionsRow = await page.evaluate(() => {
  const pills = [...document.querySelectorAll('.status-actions .pill')]
  const tops = new Set(pills.map((el) => Math.round(el.getBoundingClientRect().top)))
  return { count: pills.length, rows: tops.size }
})
check('1440 底部动作条单行', actionsRow.rows === 1, JSON.stringify(actionsRow))

// 波形 A 点标记
await page.goto(BASE + '/courses/9/chapters/1001?stage=waveform', { waitUntil: 'networkidle' })
await sleep(3000)
await page.getByRole('button', { name: /标 A/ }).first().click()
await sleep(600)
const aMark = await page.evaluate(() => {
  const el = document.querySelector('.waveform-a-marker')
  if (!el) return null
  const b = el.getBoundingClientRect()
  return { w: Math.round(b.width), h: Math.round(b.height) }
})
check('波形 A 点标记可见（贯穿高度）', aMark !== null && aMark.w >= 2 && aMark.h > 40, JSON.stringify(aMark))
await shot(page, '1440-waveform-a')

// 1e. 考试页：播放器在选项之前；0 答时交卷为描边
await page.goto(BASE + '/courses/9/chapters/1001?stage=exam', { waitUntil: 'networkidle' })
await sleep(1500)
const layout = await page.evaluate(() => {
  const audio = document.querySelector('.exam-q-audio')?.getBoundingClientRect()
  const options = document.querySelector('.exam-options')?.getBoundingClientRect()
  const submit = document.querySelector('.exam-submit')
  return {
    audioTop: audio ? Math.round(audio.top) : null,
    optionsTop: options ? Math.round(options.top) : null,
    submitBg: submit ? getComputedStyle(submit).backgroundColor : null,
    submitBorder: submit ? getComputedStyle(submit).borderTopColor : null,
  }
})
check('考试播放器在选项上方', layout.audioTop !== null && layout.audioTop < layout.optionsTop, JSON.stringify(layout))
check('0 答时交卷为透明底', layout.submitBg === 'rgba(0, 0, 0, 0)', layout.submitBg)
await shot(page, '1440-exam')

// 1f. 顶栏高亮
for (const [path, sel, expect] of [
  ['/vocabulary', '.topbar-nav-item.active', '生词本'],
  ['/review', '.topbar-nav-item.active', '难点复习'],
]) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await sleep(700)
  const activeText = await page.locator(sel).first().innerText().catch(() => '')
  check(`顶栏高亮 ${path}`, activeText.includes(expect), `${activeText}`)
}
await page.goto(BASE + '/search', { waitUntil: 'networkidle' })
await sleep(700)
const searchActive = await page.locator('.account-trigger.active').count()
check('搜索页放大镜为激活态', searchActive === 1, `count=${searchActive}`)
await shot(page, '1440-search')

// 1g. 设置页主题卡
await page.goto(BASE + '/settings', { waitUntil: 'networkidle' })
await sleep(800)
const themeCards = await page.locator('.theme-card').count()
const checkedTheme = await page.locator('.theme-card[aria-checked="true"] .theme-card-name').innerText().catch(() => '')
check('设置页有 4 张主题卡', themeCards === 4, `count=${themeCards}`)
check('当前主题卡被选中', checkedTheme.length > 0, checkedTheme)
await shot(page, '1440-settings')

// ── 2. 390 手机 ─────────────────────────────────────────
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const m = await mobile.newPage()
await m.goto(BASE + '/courses/9/chapters/1001?stage=extensive', { waitUntil: 'networkidle' })
await sleep(2000)
const ext = await m.evaluate(() => {
  const visual = document.querySelector('.listen-visual')?.getBoundingClientRect()
  const doc = document.documentElement
  return {
    visualW: visual ? Math.round(visual.width) : null,
    scrollW: doc.scrollWidth,
    clientW: doc.clientWidth,
  }
})
check('390 泛听媒体宽 ≥300', ext.visualW !== null && ext.visualW >= 300, JSON.stringify(ext))
check('390 泛听无横向滚动', ext.scrollW <= ext.clientW + 1, `scrollW=${ext.scrollW}`)
const anchorBar = await m.evaluate(() => {
  const bar = document.querySelector('.dialogue-anchor-bar')
  if (!bar) return { h: null, rows: 0 }
  const chips = [...bar.querySelectorAll('.dialogue-anchor-chip')]
  return {
    h: Math.round(bar.getBoundingClientRect().height),
    rows: new Set(chips.map((el) => Math.round(el.getBoundingClientRect().top))).size,
  }
})
check(
  '390 对话锚点条单行',
  anchorBar.h !== null && anchorBar.rows === 1 && anchorBar.h <= 64,
  JSON.stringify(anchorBar),
)
await m.screenshot({ path: `${OUT}/390-extensive.png` })

await m.goto(BASE + '/courses/9/chapters/1001?stage=waveform', { waitUntil: 'networkidle' })
await sleep(2000)
await m.screenshot({ path: `${OUT}/390-waveform.png` })

await m.goto(BASE + '/courses/9/chapters/1001?stage=exam', { waitUntil: 'networkidle' })
await sleep(1500)
const examM = await m.evaluate(() => {
  const nav = document.querySelector('.exam-navigator')?.getBoundingClientRect()
  const card = document.querySelector('.exam-question-card')?.getBoundingClientRect()
  return { navTop: nav ? Math.round(nav.top) : null, cardTop: card ? Math.round(card.top) : null }
})
check('390 题号导航在题卡之上', examM.navTop !== null && examM.navTop < examM.cardTop, JSON.stringify(examM))
check('390 题号导航首屏可见', examM.navTop !== null && examM.navTop < 844, JSON.stringify(examM))
await m.screenshot({ path: `${OUT}/390-exam.png` })

await m.goto(BASE + '/courses', { waitUntil: 'networkidle' })
await sleep(2000)
const layoutM = await m.evaluate(() => {
  const lib = document.querySelector('.library-pane')?.getBoundingClientRect()
  const pane = document.querySelector('.study-pane')?.getBoundingClientRect()
  const rail = document.querySelector('.stage-rail')?.getBoundingClientRect()
  const topbar = document.querySelector('.topbar')?.getBoundingClientRect()
  const navItem = document.querySelector('.topbar-nav-item')?.getBoundingClientRect()
  const doc = document.documentElement
  return {
    libH: lib ? Math.round(lib.height) : null,
    paneH: pane ? Math.round(pane.height) : null,
    railH: rail ? Math.round(rail.height) : null,
    topbarH: topbar ? Math.round(topbar.height) : null,
    navItemH: navItem ? Math.round(navItem.height) : null,
    navItemW: navItem ? Math.round(navItem.width) : null,
    scrollW: doc.scrollWidth,
    clientW: doc.clientWidth,
  }
})
check('390 正文区 ≥ 视口 55%', layoutM.paneH / 844 >= 0.55, JSON.stringify(layoutM))
check('390 章节栏 ≤ 32vh', layoutM.libH <= 844 * 0.33, `libH=${layoutM.libH}`)
check('390 阶段导航 ≤ 60px', layoutM.railH !== null && layoutM.railH <= 60, `railH=${layoutM.railH}`)
check('390 顶栏无裁切（导航项高度 ≤ 50）', layoutM.navItemH !== null && layoutM.navItemH <= 50, JSON.stringify(layoutM))
check('390 顶栏无横向溢出', layoutM.scrollW <= layoutM.clientW + 1, `scrollW=${layoutM.scrollW}`)
await m.screenshot({ path: `${OUT}/390-courses.png` })

// 触控目标
const touch = await m.evaluate(() => {
  const pick = ['.icon-button', '.subtitle-chip', '.rate-trigger', '.exam-submit', '.exam-play']
  const bad = []
  for (const sel of pick) {
    for (const el of document.querySelectorAll(sel)) {
      const box = el.getBoundingClientRect()
      if (box.width === 0) continue
      if (box.height < 43) bad.push(`${sel}:${Math.round(box.height)}`)
    }
  }
  return bad.slice(0, 8)
})
check('390 触控目标 ≥44（抽查）', touch.length === 0, touch.join(','))

// 320 极窄
const tiny = await browser.newContext({ viewport: { width: 320, height: 640 } })
const tp = await tiny.newPage()
await tp.goto(BASE + '/courses', { waitUntil: 'networkidle' })
await sleep(1500)
const tinyM = await tp.evaluate(() => {
  const doc = document.documentElement
  const topbar = document.querySelector('.topbar')
  return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, topbarH: topbar ? Math.round(topbar.getBoundingClientRect().height) : null, scrollH: topbar?.scrollHeight, clientH: topbar?.clientHeight }
})
check('320 无横向滚动', tinyM.scrollW <= tinyM.clientW + 1, JSON.stringify(tinyM))
check('320 顶栏无裁切', tinyM.scrollH <= tinyM.clientH + 1, JSON.stringify(tinyM))
await tp.screenshot({ path: `${OUT}/320-courses.png` })

// ── 3. 1024 / 768 考试与课程 ─────────────────────────────
for (const [w, h] of [[1024, 768], [768, 1024]]) {
  const c = await browser.newContext({ viewport: { width: w, height: h } })
  const p = await c.newPage()
  await p.goto(BASE + '/courses/9/chapters/1001?stage=exam', { waitUntil: 'networkidle' })
  await sleep(1800)
  const pos = await p.evaluate(() => {
    const nav = document.querySelector('.exam-navigator')?.getBoundingClientRect()
    const card = document.querySelector('.exam-question-card')?.getBoundingClientRect()
    return { navTop: nav ? Math.round(nav.top) : null, cardTop: card ? Math.round(card.top) : null }
  })
  check(`${w} 考试首屏有导航+题卡`, pos.navTop !== null && pos.navTop < pos.cardTop && pos.cardTop < h, JSON.stringify(pos))
  await p.screenshot({ path: `${OUT}/${w}-exam.png` })
  await p.goto(BASE + '/courses', { waitUntil: 'networkidle' })
  await sleep(1500)
  await p.screenshot({ path: `${OUT}/${w}-courses.png` })
  await c.close()
}

// ── 4. 四主题首页 / 精听 截图 ───────────────────────────
for (const theme of ['paper', 'gazette', 'minimal', 'exam']) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await c.newPage()
  await p.goto(BASE + '/home', { waitUntil: 'domcontentloaded' })
  await p.evaluate((t) => {
    localStorage.setItem('juting.web.theme.v1', JSON.stringify(t))
    localStorage.setItem('juting.web.activity.v1', JSON.stringify({ '2026-10-16': 6, '2026-10-17': 4 }))
    const store = JSON.parse(localStorage.getItem('juting.web.study.v1') || '{}')
    store.activeExerciseId = 1001
    store.progressByExercise = { ...(store.progressByExercise || {}), 1001: { lines: { '1001-l1': { repeatCount: 2, mastered: true, unclear: false } } } }
    localStorage.setItem('juting.web.study.v1', JSON.stringify(store))
  }, theme)
  await p.goto(BASE + '/home', { waitUntil: 'networkidle' })
  await p.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
  await sleep(1500)
  await p.screenshot({ path: `${OUT}/theme-${theme}-home.png` })
  await p.goto(BASE + '/courses/9/chapters/1001?stage=intensive', { waitUntil: 'networkidle' })
  await p.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
  await sleep(1500)
  await p.screenshot({ path: `${OUT}/theme-${theme}-intensive.png` })
  await c.close()
}

await browser.close()

const failed = results.filter((r) => !r.pass)
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2))
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('未通过：')
  for (const f of failed) console.log(' -', f.name, f.detail)
  process.exitCode = 1
}
