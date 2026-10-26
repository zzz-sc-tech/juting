/**
 * 发版一条龙（2026-10-26 立）：停服务 → 三 flavor 打包 → GitHub Release 资产上传 → 恢复服务。
 *
 * 背景：v0.7.7 首跑只出了 both+lite，差点漏独立 flavor（老启动器按资产名子串选包，
 * 六级包必须含 `full`）——本脚本把「三 flavor 全套 + 上传 + 说明」钉死成一条命令。
 *
 * 用法：
 *   node scripts/local/release.mjs --version 0.7.8 --notes temp/RELEASE-NOTES-v0.7.8.md
 *   node scripts/local/release.mjs --skip-upload      # 只打包不上传
 *   node scripts/local/release.mjs --skip-package     # 只上传已有产物（--version 仍必填）
 *   可选 --create-release（默认：Release 已存在则只补资产/改说明；不存在则创建）
 *
 * 前置：gh 已登录；package.json 版本号已升（或传 --version 由本脚本代升并提交）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.resolve(root, '..', 'juting-release');
const repo = 'zzz-sc-tech/juting';
const argOf = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const has = (k) => process.argv.includes(k);

const VERSION = argOf('--version');
const NOTES = argOf('--notes');
if (!VERSION) { console.error('用法：--version x.y.z 必填（连同 --notes）'); process.exit(1); }
const run = (cmd, args, opts = {}) => {
    console.log(`[release] ${cmd} ${args.join(' ')}`);
    return execFileSync(cmd, args, { stdio: opts.quiet ? 'ignore' : ['ignore', opts.pipe ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8', ...opts.extra });
};

// ── 0. 版本号对齐（package.json 与 --version 不一致时代升并提交） ──
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version !== VERSION) {
    run('npm', ['version', VERSION, '--no-git-tag-version'], { quiet: true });
    run('git', ['add', 'package.json', 'package-lock.json']);
    run('git', ['commit', '-m', `chore: 版本 ${pkg.version} → ${VERSION}（发版）`]);
}

// ── 1. 停服务（打包要求 MySQL 不被锁） ──
run('node', ['scripts/local/stop-all.mjs']);
const stopped = true;

try {
    // ── 2. 三 flavor 打包（both 顺带产出 lite；cet4/cet6 独立） ──
    if (!has('--skip-package')) {
        run('node', ['scripts/local/package-release.mjs', '--skip-build', '--version', VERSION]);
        run('node', ['scripts/local/package-release.mjs', '--skip-build', '--skip-launcher', '--version', VERSION, '--flavor', 'cet4']);
        run('node', ['scripts/local/package-release.mjs', '--skip-build', '--skip-launcher', '--version', VERSION, '--flavor', 'cet6']);
    }

    // ── 3. 产物清点（缺一报错，防漏 flavor） ──
    const expect = ['lite', 'cet4', 'full-cet6', 'full-cet6cet4'].flatMap((label) =>
        label === 'lite'
            ? [`juting-v${VERSION}-win-lite.7z`, `juting-v${VERSION}-win-lite-update.zip`, `juting-v${VERSION}-win-lite-deps.zip`]
            : [`juting-v${VERSION}-win-${label}.7z`, `juting-v${VERSION}-win-${label}-update.zip`, `juting-v${VERSION}-win-${label}-deps.zip`, `juting-v${VERSION}-win-${label}-media.zip`]);
    expect.push('SHA256SUMS.txt');
    const assets = expect.map((f) => path.join(outDir, f));
    const missing = assets.filter((f) => !fs.existsSync(f));
    if (missing.length) {
        console.error(`[release] ✗ 产物不全（${missing.length} 个缺失）：\n  ${missing.join('\n  ')}`);
        process.exit(1);
    }
    console.log(`[release] 产物齐全：${assets.length} 个文件`);

    // ── 4. Release 与上传 ──
    if (!has('--skip-upload')) {
        const tag = `v${VERSION}`;
        let exists = true;
        try { run('gh', ['release', 'view', tag, '-R', repo], { quiet: true }); } catch { exists = false; }
        if (!exists) {
            if (!NOTES || !fs.existsSync(path.resolve(NOTES))) { console.error(`[release] ✗ 新建 Release 需 --notes <文件>`); process.exit(1); }
            run('gh', ['release', 'create', tag, '-R', repo, '--title', `v${VERSION}`, '--notes-file', path.resolve(NOTES)]);
        } else if (NOTES && fs.existsSync(path.resolve(NOTES))) {
            run('gh', ['release', 'edit', tag, '-R', repo, '--notes-file', path.resolve(NOTES)]);
        }
        // 分批上传：先程序层（老用户一键更新就吃它），再 deps/7z，最后 media（最大）
        const batches = [
            assets.filter((f) => f.includes('-update.zip')),
            assets.filter((f) => f.includes('-deps.zip') || f.endsWith('SHA256SUMS.txt')),
            assets.filter((f) => f.endsWith('.7z')),
            assets.filter((f) => f.includes('-media.zip')),
        ];
        for (const batch of batches) {
            if (batch.length) run('gh', ['release', 'upload', tag, '-R', repo, ...batch]);
        }
        console.log(`[release] ✓ 资产已上传 https://github.com/${repo}/releases/tag/${tag}`);
    }
} finally {
    // ── 5. 恢复本机服务（打包前停了） ──
    if (stopped && !has('--no-restart')) {
        run('node', ['scripts/local/start-all.mjs']);
    }
}
console.log(`[release] 完成 v${VERSION}`);
