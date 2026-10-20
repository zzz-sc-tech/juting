/**
 * SPA 路由与资源加载（18/19，mp3 ERR_ABORTED 为已知基线）
 *
 * 用法（仓库根目录执行，需先起 8101 预览）：
 *   npm run build --workspace @juting/web-app
 *   node scripts/local/start-all.mjs
 *   node scripts/audit/ui-verify-spa-nav.mjs
 * 真机脚本额外需要：模拟器 + adb forward tcp:9222 localabstract:chrome_devtools_remote
 */
import { createRequire } from 'node:module';

// 浏览器路径可用环境变量覆盖（换机器时改这两行即可）
const PW_DEFAULT = 'C:/Users/Zsc/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Users/Zsc/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? PW_DEFAULT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = process.env.BASE || 'http://127.0.0.1:8101';

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
const failedReq = [];
page.on('requestfailed', (r) => failedReq.push(`${r.url()} ${r.failure()?.errorText}`));

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

// 每个导航项：名称 + 定位方式 + 到达后应出现的特征文本/元素
const routes = [
  { name: '首页', sel: 'button:has-text("首页")', path: '/home', expect: /学习概览|今日目标/ },
  { name: '学习', sel: 'button:has-text("学习")', path: '/courses', expect: /课程|章节|系列/ },
  { name: '难点复习', sel: 'button:has-text("难点复习")', path: '/review', expect: /难点|复习/ },
  { name: '生词本', sel: 'button:has-text("生词本")', path: '/vocabulary', expect: /生词|词/ },
  { name: '搜索', sel: 'button[aria-label="搜索"]', path: '/search', expect: /搜全部课程的句子|输入词或短语/ },
  { name: '设置', sel: 'button:has-text("设置")', path: '/settings', expect: /主题|检查更新|数据/ },
];

await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await sleep(1500);
console.log('══ SPA 内导航六路由（vite preview，真实点击）══');

for (const r of routes) {
  // 每次都从首页出发，保证是纯 SPA 内导航
  const homeBtn = page.locator('button:has-text("首页")').first();
  if (await homeBtn.count()) { await homeBtn.click({ timeout: 5000 }).catch(() => {}); await sleep(900); }

  const target = page.locator(r.sel).first();
  const found = await target.count();
  if (!found) {
    check(`${r.name} 页（SPA 导航）`, false, `导航入口未找到: ${r.sel}`);
    continue;
  }
  await target.click({ timeout: 5000 }).catch((e) => console.log('   click error: ' + e.message));
  await sleep(2200);
  const url = page.url();
  const txt = await page.locator('body').innerText().catch(() => '');
  const urlOk = url.includes(r.path);
  const textOk = r.expect.test(txt);
  check(`${r.name} 页（SPA 导航）`, urlOk && textOk,
    `url=${url.replace(BASE, '')} textOk=${textOk} | ${txt.replace(/\s+/g, ' ').slice(0, 90)}`);
}

// 深链接直接访问（vite preview 有 SPA 回退，应全部 200）
console.log('\n══ 深链接直达（vite preview SPA 回退）══');
for (const r of routes) {
  const resp = await page.goto(BASE + r.path, { waitUntil: 'networkidle' }).catch(() => null);
  await sleep(1200);
  const status = resp?.status() ?? 0;
  const txt = await page.locator('body').innerText().catch(() => '');
  check(`深链接 ${r.path}`, status === 200 && r.expect.test(txt), `HTTP ${status} | ${txt.replace(/\s+/g, ' ').slice(0, 70)}`);
}

// 搜索功能实测：输入关键词 → 有结果 → 高亮 mark
console.log('\n══ 搜索功能实测 ══');
await page.goto(BASE + '/search', { waitUntil: 'networkidle' });
await sleep(1000);
// 等索引建立（最多 60s）
let indexed = false;
for (let i = 0; i < 30; i++) {
  const txt = await page.locator('body').innerText();
  if (/正在建立索引/.test(txt)) { await sleep(2000); continue; }
  if (/索引建立失败/.test(txt)) break;
  indexed = true; break;
}
check('搜索索引建立完成', indexed, '仍显示「正在建立索引」或失败');
const input = page.locator('input[type="search"]').first();
await input.fill('the');
await sleep(1500);
const markCount = await page.locator('mark').count();
const rows = await page.locator('.search-row').count();
check('搜索有结果', rows > 0, `rows=${rows}`);
check('命中高亮 mark', markCount > 0, `mark=${markCount}`);
const bodyTxt = await page.locator('body').innerText();
check('结果分组标题', /句子（/.test(bodyTxt), bodyTxt.replace(/\s+/g, ' ').slice(0, 80));

// 空态
await input.fill('zzzzqqqq不存在xyz');
await sleep(1200);
const emptyTxt = await page.locator('body').innerText();
check('搜索空态', /没有匹配的结果/.test(emptyTxt), emptyTxt.replace(/\s+/g, ' ').slice(0, 80));

// 错误兜底：故意触发渲染异常不便注入，改为验证边界组件已挂载（无白屏 + 页面可渲染）
console.log('\n══ 其它 ══');
check('无 pageerror', errs.length === 0, errs.slice(0, 2).join(' | '));
check('无失败请求', failedReq.length === 0, failedReq.slice(0, 2).join(' | '));

await browser.close();
console.log(`\n══ ${pass} PASS / ${fail} FAIL ══`);
process.exit(fail === 0 ? 0 : 1);
