/**
 * 数据库初始化脚本：建库建表 + 灌入种子数据
 *
 * 用法：npm run db:setup
 *
 * 为什么不用直接用 mysql 命令行？
 *   旧版 db:setup 写死了 `mysql -uroot -p`，
 *   和 .env 里的 DB_USER / DB_PASSWORD 不一致——
 *   用非 root 账号时无法初始化。
 *   这个脚本读 .env 凭据，和运行时用同一套配置。
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT) || 3306;
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';

  console.log(`[数据库初始化] 连接 ${user}@${host}:${port}`);

  // 第 1 步：连到 MySQL 服务器（不指定数据库，因为库还没建）
  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    multipleStatements: true, // schema.sql 含多条语句，需要开启多语句执行
  });

  // 第 2 步：执行 schema.sql（建库 + 建表 + 建索引）
  console.log('[数据库初始化] 执行 schema.sql...');
  const sqlPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(sqlPath, 'utf-8');
  await conn.query(sql);
  console.log('[数据库初始化] 建库建表完成');

  await conn.end();

  // 第 3 步：灌入种子数据
  // seed.js 自己会创建连接并灌数据，这里用动态 import 触发它执行
  console.log('[数据库初始化] 开始灌入种子数据...');
  await import('./seed.js');
}

main().catch((err) => {
  console.error('[数据库初始化失败]', err.message);
  console.error('请检查 .env 里的数据库配置是否正确');
  process.exit(1);
});
