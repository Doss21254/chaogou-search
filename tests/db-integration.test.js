/**
 * 数据库集成测试：连真实 MySQL，验证查询语句、全文索引、分页。
 *
 * 和单元测试的区别：
 *   单元测试 mock 了 API，只测前端逻辑（防抖、竞态等）
 *   集成测试连真实数据库，测 SQL 是否真的能跑通
 *
 * MySQL 不可用时自动跳过，不阻塞 CI 的单元测试流程。
 * CI 里专门配了 MySQL service 来跑这套测试（见 .github/workflows/ci.yml）。
 */

import { describe, it, expect, afterAll } from 'vitest';
import 'dotenv/config';
import mysql from 'mysql2/promise';

// ---- 启动时尝试连接 MySQL ----
// 用 top-level await：模块加载时就完成连接检查，
// 连不上就把 canConnect 设为 false，后面的 describe.skipIf 会跳过全部测试
let pool = null;
let canConnect = false;

try {
  pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chaogou_mall',
    connectionLimit: 5,
    charset: 'utf8mb4',
  });
  const [rows] = await pool.query('SELECT COUNT(*) AS total FROM products');
  canConnect = rows[0].total > 0;
} catch {
  canConnect = false;
}

afterAll(async () => {
  await pool?.end();
});

// canConnect 为 false 时跳过所有测试（而不是报错失败）
describe.skipIf(!canConnect)('MySQL 集成测试', () => {
  it('products 表存在且有数据', async () => {
    const [rows] = await pool.query('SELECT COUNT(*) AS total FROM products');
    expect(rows[0].total).toBeGreaterThan(0);
  });

  it('search_log 表存在', async () => {
    const [rows] = await pool.query('SELECT COUNT(*) AS total FROM search_log');
    expect(rows[0].total).toBeGreaterThanOrEqual(0);
  });

  it('FULLTEXT 索引存在（ft_products_search）', async () => {
    const [rows] = await pool.query(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products' AND INDEX_NAME = 'ft_products_search'
       LIMIT 1`,
      [process.env.DB_NAME || 'chaogou_mall']
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('组合索引存在（idx_products_category_sales）', async () => {
    const [rows] = await pool.query(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products' AND INDEX_NAME = 'idx_products_category_sales'
       LIMIT 1`,
      [process.env.DB_NAME || 'chaogou_mall']
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('全文索引能搜到 2 字关键词（蓝牙）', async () => {
    const [rows] = await pool.query(
      `SELECT id, name FROM products
       WHERE MATCH(name, brand, tags) AGAINST(? IN NATURAL LANGUAGE MODE)
       LIMIT 3`,
      ['蓝牙']
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].name).toContain('蓝牙');
  });

  it('全文索引能搜到长关键词（蓝牙耳机）', async () => {
    const [rows] = await pool.query(
      `SELECT id, name FROM products
       WHERE MATCH(name, brand, tags) AGAINST(? IN NATURAL LANGUAGE MODE)
       LIMIT 3`,
      ['蓝牙耳机']
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('全文索引能搜到分类标签里的词（热销）', async () => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total FROM products
       WHERE MATCH(name, brand, tags) AGAINST(? IN NATURAL LANGUAGE MODE)`,
      ['热销']
    );
    expect(rows[0].total).toBeGreaterThan(0);
  });

  it('LIKE 全表扫描能搜到结果（对照）', async () => {
    const [rows] = await pool.query(`SELECT id FROM products WHERE name LIKE '%蓝牙%' LIMIT 3`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('分类过滤 + 销量排序返回正确结果', async () => {
    const [rows] = await pool.query(
      `SELECT id, name, category, sales FROM products
       WHERE category = ?
       ORDER BY sales DESC
       LIMIT 5`,
      ['digital']
    );
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.category === 'digital')).toBe(true);
    // 验证按销量降序
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].sales).toBeLessThanOrEqual(rows[i - 1].sales);
    }
  });

  it('分页 LIMIT OFFSET 返回不同页的数据', async () => {
    const [page1] = await pool.query(`SELECT id FROM products ORDER BY id ASC LIMIT 3 OFFSET 0`);
    const [page2] = await pool.query(`SELECT id FROM products ORDER BY id ASC LIMIT 3 OFFSET 3`);
    // 两页的 id 不应重叠
    const ids1 = new Set(page1.map((r) => r.id));
    const ids2 = page2.map((r) => r.id);
    expect(ids2.every((id) => !ids1.has(id))).toBe(true);
  });

  it('关键词 + 分类组合查询返回正确结果', async () => {
    const [rows] = await pool.query(
      `SELECT id, name, category FROM products
       WHERE MATCH(name, brand, tags) AGAINST(? IN NATURAL LANGUAGE MODE)
       AND category = ?
       LIMIT 5`,
      ['台灯', 'home']
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.category === 'home')).toBe(true);
    expect(rows[0].name).toContain('台灯');
  });

  it('价格排序方向正确', async () => {
    const [asc] = await pool.query(`SELECT price FROM products ORDER BY price ASC LIMIT 1`);
    const [desc] = await pool.query(`SELECT price FROM products ORDER BY price DESC LIMIT 1`);
    expect(Number(asc[0].price)).toBeLessThanOrEqual(Number(desc[0].price));
  });

  it('EXPLAIN 确认全文索引走 Full-text index search 而非 Table scan', async () => {
    const [rows] = await pool.query(
      `EXPLAIN SELECT id FROM products
       WHERE MATCH(name, brand, tags) AGAINST('蓝牙' IN NATURAL LANGUAGE MODE)`
    );
    // MySQL 8+ 的 EXPLAIN 输出：每行是一个步骤
    // 查找包含 "full-text" 的步骤
    const explainText = rows.map((r) => JSON.stringify(r)).join(' ').toLowerCase();
    expect(explainText).toContain('full-text');
  });
});
