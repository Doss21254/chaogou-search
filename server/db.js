/**
 * 商品数据层 —— MySQL 版本
 *
 * 这个文件负责所有跟数据库打交道的操作：
 *   连接数据库、搜索商品、获取统计、记录慢查询。
 *
 * 设计原则：
 *   1. 所有 SQL 用 ? 占位符，绝不拼接字符串（防注入）
 *   2. 用连接池管理连接，不用每次请求都新建连接
 *   3. 每个函数只做一件事，名字说清楚它干什么
 */

import 'dotenv/config'; // 读取 .env 文件里的数据库密码等配置
import mysql from 'mysql2/promise'; // mysql2 的 Promise 版，可以用 async/await

// ============================================================
// 常量定义
// ============================================================

/** 分类代号 → 中文名，用于前端展示 */
const CATEGORY_LABELS = {
  fashion: '时尚穿搭',
  digital: '3C 数码',
  home: '家居好物',
  food: '美食零食',
  sports: '运动户外',
};

/** 合法的分类代号列表，用来校验用户传入的 category 参数 */
const VALID_CATEGORIES = Object.keys(CATEGORY_LABELS);

/** 排序方式映射表：用户传 'sales'，转成 SQL 的 'p.sales DESC' */
const SORT_MAP = {
  default: 'p.sales DESC, p.id DESC', // 综合：先按销量，再按 id 兜底
  sales: 'p.sales DESC', // 销量优先
  price_asc: 'p.price ASC', // 价格从低到高
  price_desc: 'p.price DESC', // 价格从高到低
};

// ============================================================
// 连接池
// ============================================================

/**
 * 连接池：预先创建一组数据库连接，重复使用。
 *
 * 为什么不用单个连接？
 *   每次请求都新建连接很慢（要握手、认证），用完就关更浪费。
 *   连接池预先建好几个连接放着，请求来了直接拿一个用，用完还回来。
 *
 * 为什么是 10 个？
 *   开发阶段 10 个够用了。生产环境根据并发量调整，
 *   一般等于 CPU 核数 × 2 + 磁盘数。
 */
let pool = null;

/** 创建并返回连接池（只创建一次，后面重复用） */
export function initDatabase() {
  if (pool) return pool; // 已经创建过了，直接返回

  pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chaogou_mall',
    waitForConnections: true, // 连接不够时排队等待，而不是报错
    connectionLimit: 10, // 最多同时保持 10 个连接
    queueLimit: 0, // 等待队列不设上限
    charset: 'utf8mb4', // 支持中文和 emoji
  });

  return pool;
}

/** 关闭连接池（服务停止时调用） */
export function closeDatabase() {
  return pool?.end();
}

/**
 * 验证数据库连接是否正常（发一条 SELECT 1）。
 *
 * 用在两个地方：
 *   1. 服务启动时 —— 连不上就报错退出，不假装正常
 *   2. /api/health —— 健康检查必须包含数据库，否则「HTTP 活着但 DB 挂了」无法发现
 *
 * @returns {Promise<boolean>} 连接正常返回 true，失败返回 false
 */
export async function pingDatabase() {
  if (!pool) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 搜索
// ============================================================

/**
 * 搜索商品 —— 这是整个项目的核心函数。
 *
 * 做了什么：
 *   1. 根据「有没有关键词」「有没有分类」拼出 WHERE 条件
 *   2. 根据 sort 参数拼出 ORDER BY
 *   3. 先查总数（用于分页），再查当前页的数据
 *   4. 如果耗时超过 50ms，记一条慢查询日志
 *
 * @param {object} query - 搜索参数
 * @param {string} [query.keyword] - 关键词，如「蓝牙耳机」
 * @param {string} [query.category] - 分类，如「digital」
 * @param {string} [query.sort] - 排序：default / sales / price_asc / price_desc
 * @param {number} [query.page] - 页码，从 1 开始
 * @param {number} [query.pageSize] - 每页条数
 * @returns {Promise<{items: object[], total: number, costMs: number}>}
 */
export async function searchProducts(query = {}) {
  const { keyword = '', category = '', sort = 'default', page = 1, pageSize = 20 } = query;

  // 记录开始时间，结束时算总耗时
  const startTime = performance.now();

  // 规整参数：去掉首尾空格，保证类型正确
  const kw = keyword.trim();
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(Number(pageSize) || 20, 100));
  const offset = (safePage - 1) * safePageSize; // 分页偏移量

  // ---- 第 1 步：拼 WHERE 条件和参数 ----
  // whereParts 存条件片段，params 存对应的参数值
  // 两者按顺序对应，最后拼成 SQL 时用 ? 占位
  const whereParts = [];
  const params = [];

  // 关键词搜索：用 MySQL 的全文索引（FULLTEXT INDEX + ngram 分词器）
  // MATCH ... AGAINST 是全文搜索语法，比 LIKE '%关键词%' 快得多
  if (kw) {
    whereParts.push('MATCH(p.name, p.brand, p.tags) AGAINST(? IN NATURAL LANGUAGE MODE)');
    params.push(kw);
  }

  // 分类过滤：只查白名单里的分类，防止注入
  if (category && VALID_CATEGORIES.includes(category)) {
    whereParts.push('p.category = ?');
    params.push(category);
  }

  // 把条件片段用 AND 连起来，前面加 WHERE
  // 如果没有条件，whereSql 就是空字符串（查全部）
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  // ---- 第 2 步：拼排序 ----
  // 从映射表里取，取不到就用默认值（防注入）
  const orderSql = SORT_MAP[sort] || SORT_MAP.default;

  // ---- 第 3 步：查总数 ----
  // 总数用来算总页数，前端需要展示「共 N 条结果 · 第 X / Y 页」
  const countSql = `SELECT COUNT(*) AS total FROM products p ${whereSql}`;
  const [countRows] = await pool.query(countSql, params);
  const total = countRows[0].total;

  // ---- 第 4 步：查当前页数据 ----
  // LIMIT ? OFFSET ? 分页：LIMIT 是每页条数，OFFSET 是跳过多少条
  const listSql = `
    SELECT p.id, p.name, p.category, p.brand, p.price, p.sales, p.rating, p.stock, p.tags
    FROM products p
    ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `;
  // 注意参数顺序：先 WHERE 的参数，再 LIMIT 和 OFFSET 的参数
  const [rows] = await pool.query(listSql, [...params, safePageSize, offset]);

  // ---- 第 5 步：算耗时，记慢查询 ----
  const costMs = performance.now() - startTime;

  // 超过 50ms 算慢查询，记进日志表，方便后续观察哪些查询需要优化
  if (costMs > 50) {
    await pool.execute('INSERT INTO search_log (keyword, category, hit_count, cost_ms) VALUES (?, ?, ?, ?)', [
      kw,
      category || null,
      total,
      Math.round(costMs * 100) / 100,
    ]);
  }

  // ---- 第 6 步：整理返回格式 ----
  return {
    items: rows.map(formatProductRow),
    total,
    costMs: Math.round(costMs * 100) / 100,
  };
}

// ============================================================
// 统计与日志
// ============================================================

/** 获取数据库统计信息（商品总数、各分类数量），用于渲染分类标签 */
export async function getStats() {
  const [totalRow] = await pool.query('SELECT COUNT(*) AS total FROM products');
  const [categoryRows] = await pool.query(
    'SELECT category, COUNT(*) AS count FROM products GROUP BY category'
  );

  return {
    total: totalRow[0].total,
    byCategory: categoryRows,
    categories: CATEGORY_LABELS,
  };
}

/** 获取最近的慢查询日志，用于演示索引优化的实际效果 */
export async function getSlowQueries(limit = 10) {
  const [rows] = await pool.query(
    'SELECT keyword, category, hit_count, cost_ms, created_at FROM search_log ORDER BY id DESC LIMIT ?',
    [limit]
  );
  return rows;
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 把数据库查出来的一行，整理成前端需要的格式。
 *
 * 数据库返回的 row 是扁平对象（tags 是空格分隔的字符串），
 * 前端需要的是数组。这个函数做格式转换。
 *
 * 单独抽出来是因为：搜索结果、推荐列表、详情页都要做同样的转换，
 * 抽成一个函数避免到处重复写。
 */
function formatProductRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category] || row.category,
    brand: row.brand,
    price: Number(row.price),
    sales: row.sales,
    rating: Number(row.rating),
    stock: row.stock,
    // tags 在数据库里是「星辰 digital 热销 正品 顺丰包邮」这样的字符串
    // 用空格切成数组，前端好遍历渲染标签
    tags: row.tags ? row.tags.split(' ').filter(Boolean) : [],
  };
}
