/**
 * 本地实例的首个超级管理员引导。全新数据库没有任何后台账号，管理后台无法登录；
 * 本脚本在没有任何可用超管时创建一个（幂等，已有超管则跳过）。
 *
 * 用法：node scripts/local/bootstrap-admin.mjs [--env-file backend/.env] [--password <密码>]
 * 默认账号 admin@juting.local / juting2026，登录后可在「我的账号」里改密。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFileArgIndex = process.argv.indexOf('--env-file');
const envFile = envFileArgIndex >= 0
    ? path.resolve(repositoryRoot, process.argv[envFileArgIndex + 1])
    : [path.join(repositoryRoot, 'backend', '.env'), path.join(repositoryRoot, '.env')].find(existsSync);

if (!envFile) {
    throw new Error('找不到 backend/.env 或根目录 .env。');
}
const fileEnvironment = {};
dotenv.config({ path: envFile, processEnv: fileEnvironment, quiet: true });
const environment = { ...fileEnvironment, ...process.env };

const passwordIndex = process.argv.indexOf('--password');
const initialPassword = passwordIndex >= 0 ? process.argv[passwordIndex + 1] : 'juting2026';
if (!initialPassword || initialPassword.length < 8) {
    throw new Error('初始密码至少 8 位。');
}

const connection = await mysql.createConnection({
    host: (environment.MYSQL_HOST || '127.0.0.1').trim(),
    port: Number(environment.MYSQL_PORT || '3306'),
    user: (environment.MYSQL_USER || environment.MYSQL_USERNAME || 'root').trim(),
    password: environment.MYSQL_PASSWORD || '',
    database: (environment.MYSQL_DATABASE || 'duolinting_app_dev').trim(),
});

const rows = (await connection.query(
    "select count(*) as total from admin_users where role = 'super_admin' and is_active = true",
))[0];
if (rows[0].total > 0) {
    console.log('[bootstrap] 已存在可用超级管理员，跳过创建。');
    await connection.end();
    process.exit(0);
}

const passwordHash = bcrypt.hashSync(initialPassword, 10);
await connection.query(
    'insert into admin_users (username, email, display_name, password_hash, role, must_change_password, is_active) ' +
    "values (?, ?, ?, ?, 'super_admin', false, true) " +
    'on duplicate key update password_hash = values(password_hash), is_active = true',
    ['admin', 'admin@juting.local', '本地管理员', passwordHash],
);

console.log('[bootstrap] 已创建本地超级管理员：');
console.log('  登录邮箱: admin@juting.local');
console.log(`  初始密码: ${initialPassword}`);
console.log('  （请登录管理后台后在「我的账号」修改密码）');
await connection.end();
