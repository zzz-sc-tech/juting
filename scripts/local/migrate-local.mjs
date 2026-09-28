/**
 * 免 Docker 的本地迁移器：把 infra/mysql/migrations 下的 Flyway 迁移
 * 直接用 mysql2 应用到本机 MySQL（便携版/自装均可）。
 *
 * - V* 文件按文件名升序只应用一次，记录在 local_schema_history；
 * - R* 文件（可重复）每次运行都重新执行，官方写法自带幂等性；
 * - 支持 DELIMITER 切换（存储过程），按语句逐条执行；
 * - 重复应用时，「列/表已存在」类错误按已应用跳过（本地实例的宽容语义），
 *   其余错误立即失败。
 *
 * 注意：历史表独立于 Flyway 的 flyway_schema_history，两者不要混用同一数据库。
 * 用法：node scripts/local/migrate-local.mjs [--env-file backend/.env]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFileArgIndex = process.argv.indexOf('--env-file');
const envFile = envFileArgIndex >= 0
    ? path.resolve(repositoryRoot, process.argv[envFileArgIndex + 1])
    : [path.join(repositoryRoot, 'backend', '.env'), path.join(repositoryRoot, '.env')]
        .find((candidate) => existsSync(candidate));

if (!envFile) {
    throw new Error('找不到 backend/.env 或根目录 .env，无法确定数据库配置。');
}
const fileEnvironment = {};
dotenv.config({ path: envFile, processEnv: fileEnvironment, quiet: true });
const environment = { ...fileEnvironment, ...process.env };

const host = (environment.MYSQL_HOST || '127.0.0.1').trim();
const port = Number(environment.MYSQL_PORT || '3306');
const database = (environment.MYSQL_DATABASE || 'duolinting_app_dev').trim();
const user = (environment.MYSQL_USER || environment.MYSQL_USERNAME || 'root').trim();
const password = environment.MYSQL_PASSWORD || '';

if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`拒绝迁移非本机数据库主机 ${host}`);
}

/**
 * 按当前 delimiter 切分 SQL 文件为语句数组。
 * 处理三种行：注释行、delimiter 切换行、普通语句行。
 */
const splitSqlStatements = (content) => {
    const statements = [];
    let buffer = '';
    let delimiter = ';';
    for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
        const line = rawLine.trim();
        const delimiterMatch = line.match(/^delimiter\s+(\S+)\s*$/i);
        if (delimiterMatch) {
            // 切换 delimiter 前先提交攒下的语句（不带 delimiter 行本身）。
            if (buffer.trim()) {
                statements.push(buffer.trim());
                buffer = '';
            }
            delimiter = delimiterMatch[1];
            continue;
        }
        buffer += `${rawLine}\n`;
        if (line.startsWith('--') || line.startsWith('#')) {
            continue;
        }
        if (buffer.trimEnd().endsWith(delimiter)) {
            const statement = buffer.trim().slice(0, -delimiter.length).trim();
            buffer = '';
            if (statement) {
                statements.push(statement);
            }
        }
    }
    if (buffer.trim()) {
        statements.push(buffer.trim());
    }
    return statements.filter((statement) =>
        // 纯注释语句不发给服务端
        statement.split('\n').some((line) => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith('--') && !trimmed.startsWith('#');
        }));
};

/** 「已存在」类错误码：重复应用迁移时视为成功跳过。 */
const IDEMPOTENT_ERROR_CODES = new Set([
    'ER_TABLE_EXISTS_ERROR', // 1050
    'ER_DUP_FIELDNAME', // 1060
    'ER_DUP_KEYNAME', // 1061
    'ER_CANT_DROP_FIELD_OR_KEY', // 1091（drop if not exists 场景）
]);

const connection = await mysql.createConnection({ host, port, user, password, multipleStatements: false });
await connection.query('create database if not exists ??', [database]);
await connection.query('use ??', [database]);
await connection.query(
    'create table if not exists local_schema_history (' +
    ' filename varchar(255) primary key,' +
    ' kind varchar(1) not null,' +
    ' applied_at timestamp not null default current_timestamp' +
    ')',
);

const migrationDirectory = path.join(repositoryRoot, 'infra', 'mysql', 'migrations');
const files = readdirSync(migrationDirectory)
    .filter((name) => /\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));

const versioned = files.filter((name) => /^V\d{12}__[^\\/%]+\.sql$/i.test(name));
const repeatable = files.filter((name) => /^R__[^\\/%]+\.sql$/i.test(name));
const unknown = files.filter((name) => !versioned.includes(name) && !repeatable.includes(name));
if (unknown.length > 0) {
    throw new Error(`迁移目录中存在不符合 Flyway 命名约定的文件：${unknown.join(', ')}`);
}

const appliedRows = (await connection.query('select filename from local_schema_history'))[0];
const applied = new Set(appliedRows.map((row) => row.filename));

const applyFile = async (name) => {
    const sql = readFileSync(path.join(migrationDirectory, name), 'utf8');
    const statements = splitSqlStatements(sql);
    const startedAt = Date.now();
    for (const [index, statement] of statements.entries()) {
        try {
            await connection.query(statement);
        } catch (error) {
            if (IDEMPOTENT_ERROR_CODES.has(error.code)) {
                console.log(`  [skip] ${name} #${index + 1} 已存在（${error.code}）`);
                continue;
            }
            console.error(`[migrate] FAILED ${name} #${index + 1}: ${error.message}`);
            throw error;
        }
    }
    console.log(`[migrate] applied ${name}（${statements.length} 条语句，${Date.now() - startedAt}ms）`);
};

let appliedCount = 0;
for (const name of versioned) {
    if (applied.has(name)) {
        continue;
    }
    await applyFile(name);
    await connection.query('insert into local_schema_history (filename, kind) values (?, ?)', [name, 'V']);
    appliedCount += 1;
}

for (const name of repeatable) {
    await applyFile(name);
    await connection.query(
        'insert into local_schema_history (filename, kind) values (?, ?) on duplicate key update applied_at = current_timestamp',
        [name, 'R'],
    );
}

console.log(`[migrate] done. database=${database} newly applied=${appliedCount}`);
await connection.end();
