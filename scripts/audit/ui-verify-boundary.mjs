/**
 * 异常边界兜底（6 项）
 *
 * 用法（仓库根目录执行，需先起 8101 预览）：
 *   npm run build --workspace @juting/web-app
 *   node scripts/local/start-all.mjs
 *   node scripts/audit/ui-verify-boundary.mjs
 * 真机脚本额外需要：模拟器 + adb forward tcp:9222 localabstract:chrome_devtools_remote
 */
import { createRequire } from 'node:module';

// 浏览器路径可用环境变量覆盖（换机器时改这两行即可）
const PW_DEFAULT = 'C:/Users/Zsc/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Users/Zsc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? PW_DEFAULT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:8101';
const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
});
let pass = 0, fail = 0;
const check = (l, ok, d = '') => { if (ok) { pass++; console.log('  PASS ' + l); } else { fail++; console.log('  FAIL ' + l + (d ? ' — ' + d : '')); } };

// A. 静止页面不产生失败请求（确认 ERR_ABORTED 是导航中断而非真故障）
{
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const failed = [];
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  await page.goto(BASE + '/home', { waitUntil: 'networkidle' });
  await sleep(4000);
  check('首页静止 4s 无失败请求', failed.length === 0, failed.slice(0, 3).join(' | '));
  await page.close();
}

// B. ErrorBoundary 实测：拦掉 StudyPage 懒加载块，点「学习」应落到错误兜底页而非白屏
{
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/assets/StudyPage-*.js', (route) => route.abort());
  await page.goto(BASE + '/home', { waitUntil: 'networkidle' });
  await sleep(1200);
  await page.locator('button:has-text("学习")').first().click().catch(() => {});
  await sleep(3000);
  const boundary = await page.locator('.error-boundary').count();
  const txt = await page.locator('body').innerText().catch(() => '');
  check('懒加载失败被 ErrorBoundary 兜住', boundary > 0, `boundary=${boundary} | ${txt.replace(/\s+/g, ' ').slice(0, 90)}`);
  check('兜底页有「重新加载」按钮', /重新加载/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 90));
  check('兜底页提示进度未丢失', /没有丢失/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 90));
  const detailBtn = page.locator('.error-boundary summary');
  if (await detailBtn.count()) {
    await detailBtn.click().catch(() => {});
    await sleep(500);
    const openTxt = await page.locator('.error-boundary').innerText();
    check('技术详情可展开且含报错', /import|Failed|dynamically|Loading|chunk/i.test(openTxt), openTxt.replace(/\s+/g, ' ').slice(-140));
  }
  await page.close();
}

// C. 回首页按钮真的能换到健康路径（不依赖 history.back）
{
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  await page.route('**/assets/StudyPage-*.js', (route) => route.abort());
  await page.goto(BASE + '/courses', { waitUntil: 'networkidle' });
  await sleep(3000);
  const before = await page.locator('.error-boundary').count();
  if (before > 0) {
    await page.locator('.error-boundary button:has-text("回到首页")').click().catch(() => {});
    await sleep(3000);
    const after = await page.locator('.error-boundary').count();
    const txt = await page.locator('body').innerText().catch(() => '');
    check('「回到首页」恢复可用', after === 0 && /学习概览|今日目标/.test(txt), `after=${after} | ${txt.replace(/\s+/g, ' ').slice(0, 70)}`);
  } else {
    check('「回到首页」恢复可用', false, '深链接 /courses 未触发兜底');
  }
  await page.close();
}

await browser.close();
console.log(`\n══ ${pass} PASS / ${fail} FAIL ══`);
process.exit(fail === 0 ? 0 : 1);
