/**
 * 停止本机句听实例：按端口找到进程并结束（MySQL 优先走优雅关停）。
 * 用法：node scripts/local/stop-all.mjs
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mysqladmin = path.join(repositoryRoot, 'temp', 'runtime', 'mysql', 'bin', 'mysqladmin.exe');
const ports = [3307, 9000, 8100, 8101, 8102];

// MySQL 优雅关停（数据页落盘），失败再由端口强杀兜底。
try {
    execSync(`"${mysqladmin}" --port=3307 --user=root shutdown`, { stdio: 'ignore', timeout: 15000 });
    console.log('[stop] MySQL 已优雅关停。');
} catch {
    // 不在运行或已停止
}

const netstat = (() => {
    try {
        return execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    } catch {
        return '';
    }
})();

const pids = new Set();
for (const line of netstat.split('\n')) {
    for (const port of ports) {
        if (line.includes(`:${port} `) && line.includes('LISTENING')) {
            const pid = Number(line.trim().split(/\s+/).at(-1));
            if (Number.isInteger(pid) && pid > 0) {
                pids.add(pid);
            }
        }
    }
}

for (const pid of pids) {
    try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
        console.log(`[stop] 已结束进程 ${pid}`);
    } catch {
        // 端口轮询间隙进程已退出
    }
}

// 注意：不做按镜像名的全杀（taskkill /IM mysqld.exe）——机器上可能另有同名实例。

console.log('[stop] 句听已全部停止。');
