/**
 * 商品数据层：基于 node:sqlite（Node 22 内置，零外部依赖）。
 *
 * 面试要点：
 *  1. 模糊查询用 LIKE 时，前导通配符 %xxx% 无法走索引 → 用 FTS5 全文索引，
 *     否则数据量一大就是全表扫描。
 *  2. 分类过滤 + 关键词 + 排序的组合查询，用覆盖索引让查询只扫索引不回表。
 *  3. 分页深翻页（OFFSET 过大）会拖垮性能，演示用 keyset 分页。
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'products.db');

const CATEGORIES = ['fashion', 'digital', 'home', 'food', 'sports'];

/** 分类中文名，用于前端展示 */
export const CATEGORY_LABELS = {
  fashion: '时尚穿搭',
  digital: '3C 数码',
  home: '家居好物',
  food: '美食零食',
  sports: '运动户外',
};

let db;

/**
 * 初始化数据库，建表、建索引、灌入种子数据。
 * @param {{ fresh?: boolean }} [options] fresh=true 时重建（默认）
 */
export function initDatabase({ fresh = true } = {}) {
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  if (fresh) {
    db.exec('DROP TABLE IF EXISTS products');
    db.exec('DROP TABLE IF EXISTS product_fts');
    db.exec('DROP TABLE IF EXISTS product_bigram');
    db.exec('DROP TABLE IF EXISTS search_log');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      category   TEXT    NOT NULL,
      brand      TEXT    NOT NULL DEFAULT '',
      price      REAL    NOT NULL,
      sales      INTEGER NOT NULL DEFAULT 0,
      rating     REAL    NOT NULL DEFAULT 4.5,
      stock      INTEGER NOT NULL DEFAULT 0,
      tags       TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // 覆盖索引：先按分类过滤，再按销量排序，避免 filesort
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_category_sales
      ON products(category, sales DESC)
  `);

  // 关键词检索用 FTS5 trigram 分词器。
  //
  // 为什么不用默认的 unicode61：它按「词」切分，中文没有空格会被当成一整段，
  // 导致「蓝牙」查不到「降噪蓝牙耳机」。
  // 为什么不用 trigram 单独搞定：trigram 要求关键词至少 3 个字符，
  // 而中文里「蓝牙」「耳机」「台灯」这类两字词非常常见。
  //
  // 所以采用双索引策略：
  //   ≥3 字符 → trigram 全文索引
  //   ≤2 字符 → product_bigram 二元组倒排表
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS product_fts USING fts5(
      name, brand, tags,
      content='products',
      content_rowid='id',
      tokenize='trigram'
    )
  `);

  // 二元组倒排表：bigram -> product_id，供 2 字关键词走索引而非全表扫描
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_bigram (
      bigram    TEXT    NOT NULL,
      product_id INTEGER NOT NULL,
      PRIMARY KEY (bigram, product_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bigram_product ON product_bigram(product_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS search_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword    TEXT    NOT NULL,
      category   TEXT,
      hit_count  INTEGER NOT NULL,
      cost_ms    REAL    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_search_log_created ON search_log(created_at DESC)');

  seed();
  return db;
}

/** 生成种子数据：1 万条商品，覆盖各分类与热门关键词 */
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (count > 0) return;

  const names = {
    fashion: [
      '轻薄连帽外套',
      '夏季时尚短裙',
      '宽松阔腿裤',
      '纯棉圆领T恤',
      '防风冲锋衣',
      '真皮短靴',
      '羊毛混纺大衣',
      '亚麻衬衫',
      '运动束脚裤',
      '针织开衫',
    ],
    digital: [
      '降噪蓝牙耳机',
      '无线充电底座',
      '机械键盘',
      '高刷电竞显示器',
      '便携移动电源',
      '智能手表',
      'USB-C 扩展坞',
      '降噪头戴耳机',
      '桌面路由器',
      '固态移动硬盘',
    ],
    home: [
      '智能护眼台灯',
      '记忆棉枕头',
      '全棉四件套',
      '静音落地扇',
      '香薰加湿器',
      '免安装收纳柜',
      '多层鞋架',
      '厨房沥水篮',
      '实木餐桌椅',
      '遮光窗帘',
    ],
    food: [
      '手冲咖啡豆',
      '低脂鸡胸肉',
      '云南野生菌菇',
      '冷萃茶包',
      '坚果大礼包',
      '手工黑巧克力',
      '即食燕麦片',
      '古法红糖',
      '深海鳕鱼块',
      '气泡水',
    ],
    sports: [
      '专业跑步鞋',
      '碳纤维登山杖',
      '加厚瑜伽垫',
      '速干运动T恤',
      '折叠健身车',
      '登山背包',
      '泳镜防雾套装',
      '筋膜枪',
      '羽毛球拍',
      '露营帐篷',
    ],
  };
  const brands = ['星辰', '拓野', '云鲸', '极光', '远山', '轻舟', '松野', '海风', '木白', '岩灰'];

  const insert = db.prepare(`
    INSERT INTO products (name, category, brand, price, sales, rating, stock, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare('INSERT INTO product_fts(rowid, name, brand, tags) VALUES (?, ?, ?, ?)');
  const insertBigram = db.prepare('INSERT OR IGNORE INTO product_bigram (bigram, product_id) VALUES (?, ?)');

  db.exec('BEGIN');
  let id = 0;
  for (const category of CATEGORIES) {
    const pool = names[category];
    for (let i = 0; i < 2000; i += 1) {
      id += 1;
      const base = pool[i % pool.length];
      const suffix = i < pool.length ? '' : ` ${Math.floor(i / pool.length) + 1}代`;
      const name = `${base}${suffix}`;
      const brand = brands[(i * 7) % brands.length];
      const price = Math.round((19 + ((i * 37) % 9800)) / 10) * 10 - 0.1;
      const sales = (i * 131) % 9999;
      const rating = Math.round((3.5 + ((i * 13) % 15) / 10) * 10) / 10;
      const stock = (i * 17) % 500;
      const tags = `${brand} ${category} 热销 正品 顺丰包邮`;
      insert.run(name, category, brand, price, sales, rating, stock, tags);
      insertFts.run(id, name, brand, tags);
      // 写入二元组倒排表：把名称、品牌、标签里的所有相邻两字组合登记进去
      for (const gram of extractBigrams(`${name}${brand}${tags}`)) {
        insertBigram.run(gram, id);
      }
    }
  }
  db.exec('COMMIT');
  db.exec("INSERT INTO product_fts(product_fts) VALUES('rebuild')");
}

/**
 * 抽取文本中的所有相邻二字组合（去重）。
 * 中文检索里「蓝牙」「耳机」「台灯」这类两字词占比很高，
 * trigram 索引覆盖不到，需要单独的二元组倒排表兜底。
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractBigrams(text) {
  const grams = new Set();
  // 去掉非中文非字母数字字符，避免把空格和标点切进二元组
  const cleaned = text.replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, '');
  for (let i = 0; i < cleaned.length - 1; i += 1) {
    grams.add(cleaned.slice(i, i + 2));
  }
  return [...grams];
}

/**
 * 执行搜索查询。
 *
 * @param {object} params
 * @param {string} [params.keyword] 关键词
 * @param {string} [params.category] 分类
 * @param {string} [params.sort] 排序字段：sales | price_asc | price_desc | default
 * @param {number} [params.pageSize] 每页条数（也兼容 limit 字段名）
 * @param {number} [params.page] 页码，从 1 开始（也兼容 offset 字段名）
 * @returns {{ items: object[], total: number, costMs: number }}
 */
export function searchProducts(query = {}) {
  const { keyword = '', category = '', sort = 'default', pageSize, limit, page, offset } = query;

  // 统一分页参数：既支持 page/pageSize，也支持 limit/offset
  const effectiveLimit = Number(pageSize ?? limit ?? 20);
  const effectiveOffset = Number(offset ?? (page ? (page - 1) * effectiveLimit : 0));
  const started = performance.now();
  const kw = keyword.trim();
  const where = [];
  const params = [];

  let from = 'products p';

  if (kw) {
    // 按关键词长度选择索引策略：
    //   ≥3 字符 → trigram 全文索引（FTS5）
    //   ≤2 字符 → 二元组倒排表（覆盖「蓝牙」「耳机」这类高频两字词）
    if (kw.length >= 3) {
      from += ' JOIN product_fts f ON f.rowid = p.id';
      where.push('product_fts MATCH ?');
      params.push(buildFtsQuery(kw));
    } else {
      from += ' JOIN product_bigram b ON b.product_id = p.id';
      where.push('b.bigram = ?');
      params.push(kw);
    }
  }
  if (category && CATEGORIES.includes(category)) {
    where.push('p.category = ?');
    params.push(category);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const orderSql =
    {
      default: 'p.sales DESC, p.id DESC',
      sales: 'p.sales DESC',
      price_asc: 'p.price ASC',
      price_desc: 'p.price DESC',
    }[sort] || 'p.sales DESC, p.id DESC';

  const countSql = `SELECT COUNT(*) AS c FROM ${from} ${whereSql}`;
  const total = db.prepare(countSql).get(...params).c;

  const listSql = `
    SELECT p.id, p.name, p.category, p.brand, p.price, p.sales, p.rating, p.stock, p.tags
    FROM ${from}
    ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(listSql).all(...params, effectiveLimit, effectiveOffset);

  const costMs = performance.now() - started;

  // 记录慢查询（超过 50ms），便于后续做索引优化
  if (costMs > 50) {
    db.prepare('INSERT INTO search_log (keyword, category, hit_count, cost_ms) VALUES (?, ?, ?, ?)').run(
      kw,
      category || null,
      total,
      costMs
    );
  }

  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      categoryLabel: CATEGORY_LABELS[row.category] || row.category,
      brand: row.brand,
      price: row.price,
      sales: row.sales,
      rating: row.rating,
      stock: row.stock,
      tags: row.tags.split(' '),
    })),
    total,
    costMs: Math.round(costMs * 100) / 100,
  };
}

/**
 * 把用户输入转成 FTS5 查询串。
 * 直接把用户输入塞进 MATCH 会被当成语法，出错或造成意外匹配。
 *
 * trigram 分词器下不需要前缀通配符——它本身就是子串匹配，
 * 加了反而会因为引号包裹而失效。
 *
 * @param {string} keyword
 * @returns {string}
 */
function buildFtsQuery(keyword) {
  const tokens = keyword
    .split(/\s+/)
    .map((t) => t.replace(/["'^*():-]/g, ' ').trim())
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  // 多词用 AND 连接，要求同时包含
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

/**
 * 查看查询执行计划（EXPLAIN QUERY PLAN），用于说明索引是否生效。
 * @param {object} params 同 searchProducts
 */
export function explainSearch(params = {}) {
  const kw = (params.keyword || '').trim();
  let sql;
  let args = [];

  if (!kw) {
    sql = 'EXPLAIN QUERY PLAN SELECT p.id FROM products p';
  } else if (kw.length >= 3) {
    sql =
      'EXPLAIN QUERY PLAN SELECT p.id FROM products p JOIN product_fts f ON f.rowid = p.id WHERE product_fts MATCH ?';
    args = [buildFtsQuery(kw)];
  } else {
    sql =
      'EXPLAIN QUERY PLAN SELECT p.id FROM products p JOIN product_bigram b ON b.product_id = p.id WHERE b.bigram = ?';
    args = [kw];
  }

  const rows = db.prepare(sql).all(...args);
  return rows.map((r) => r.detail);
}

/** 最近的慢查询日志 */
export function getSlowQueries(limit = 10) {
  return db
    .prepare(
      'SELECT keyword, category, hit_count, cost_ms, created_at FROM search_log ORDER BY id DESC LIMIT ?'
    )
    .all(limit);
}

/** 数据库统计信息 */
export function getStats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  const byCategory = db.prepare('SELECT category, COUNT(*) AS c FROM products GROUP BY category').all();
  return { total, byCategory, categories: CATEGORY_LABELS };
}

export function closeDatabase() {
  db?.close();
}
