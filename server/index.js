/**
 * 商品搜索 HTTP 服务（Node 原生 http，无框架依赖）
 *
 * 提供的接口：
 *   GET /api/products          搜索商品（支持关键词、分类、排序、分页）
 *   GET /api/products/stats    分类统计（用于渲染分类标签）
 *   GET /api/products/slow-queries  慢查询日志
 *   GET /api/health            健康检查
 *
 * 这个文件负责：接收 HTTP 请求 → 解析参数 → 调 db.js 查数据 → 返回 JSON
 * 不负责：具体怎么查数据库（那是 db.js 的事）
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';
import { initDatabase, searchProducts, getStats, getSlowQueries, closeDatabase } from './db.js';

// ============================================================
// 配置
// ============================================================

const PORT = Number(process.env.PORT) || 3001; // 服务端口
const HOST = process.env.HOST || '127.0.0.1'; // 监听地址

// 缓存配置
const CACHE_MAX = 200; // 最多缓存 200 条结果
const CACHE_TTL = 30_000; // 缓存 30 秒后过期（单位毫秒）

// 限流配置
const RATE_LIMIT_WINDOW = 10_000; // 10 秒为一个窗口
const RATE_LIMIT_MAX = 120; // 每个窗口内单 IP 最多 120 次请求

// ============================================================
// LRU 缓存
// ============================================================

/**
 * 简单 LRU 缓存（Least Recently Used，最近最少使用）
 *
 * 原理：用 Map 存数据（Map 保持插入顺序）。
 *   命中缓存时，把这条数据删掉重新放到末尾 → 最近使用的在后面
 *   超过容量时，删掉最前面的 → 最久没用的被淘汰
 *
 * 为什么要缓存？
 *   搜索「蓝牙」这个关键词的人很多，每次都查数据库太浪费。
 *   缓存 30 秒，30 秒内的重复查询直接返回缓存，不查数据库。
 */
class LruCache {
  #map = new Map();
  #max;
  #ttl;

  constructor(max = CACHE_MAX, ttl = CACHE_TTL) {
    this.#max = max;
    this.#ttl = ttl;
  }

  /** 查缓存，没有或过期了返回 undefined */
  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;

    // 检查是否过期
    if (Date.now() - entry.time > this.#ttl) {
      this.#map.delete(key);
      return undefined;
    }

    // 命中缓存：删掉再放回末尾，标记为「最近使用过」
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  /** 写缓存，超过容量时淘汰最旧的 */
  set(key, value) {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, { value, time: Date.now() });

    // 超过容量，删掉最前面的（最久没用的）
    if (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
    }
  }

  get size() {
    return this.#map.size;
  }
}

// ============================================================
// 限流
// ============================================================

/**
 * 滑动窗口限流
 *
 * 原理：记录每个 IP 最近 10 秒内的所有请求时间戳。
 *   如果 10 秒内请求超过 120 次，就拒绝（返回 429）。
 *
 * 为什么要限流？
 *   防止有人用脚本疯狂刷接口，把数据库拖垮。
 */
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  // 取出该 IP 的请求记录，过滤掉 10 秒以前的（窗口外的）
  const recent = (rateLimitMap.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW);

  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(ip, recent);
    return false; // 超过限制，拒绝
  }

  recent.push(now);
  rateLimitMap.set(ip, recent);
  return true; // 没超限制，放行
}

// ============================================================
// HTTP 工具函数
// ============================================================

let requestId = 0;

/** 发送 JSON 响应 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Request-Id': `r${++requestId}`, // 每个响应带个 id，方便排查问题
  });
  res.end(body);
}

/** 发送错误响应 */
function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: { message } });
}

/**
 * 规整查询参数：截断长度、白名单校验、设默认值
 *
 * 为什么要做这步？
 *   用户可能传乱七八糟的参数（超长字符串、非法 sort 值等）。
 *   这里统一清洗，防止非法值进入 SQL 层。
 */
function normalizeParams(params) {
  // 关键词：最多 64 个字符，防止超长查询拖慢数据库
  const keyword = (params.get('keyword') || '').slice(0, 64);
  // 分类：最多 32 个字符
  const category = (params.get('category') || '').slice(0, 32);

  // 排序：只接受 4 个枚举值，其他一律当「综合排序」处理
  const sortRaw = (params.get('sort') || 'default').slice(0, 16);
  const validSorts = ['default', 'sales', 'price_asc', 'price_desc'];
  const sort = validSorts.includes(sortRaw) ? sortRaw : 'default';

  // 页码：1 ~ 500，防止有人翻到第 99999 页（深翻页很慢）
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, 500));
  // 每页条数：1 ~ 100，防止有人一次查 1 万条
  const pageSize = Math.max(1, Math.min(Number(params.get('pageSize')) || 20, 100));

  return { keyword, category, sort, page, pageSize };
}

// ============================================================
// 主服务
// ============================================================

const cache = new LruCache();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 处理跨域预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendError(res, 405, '仅支持 GET 请求');
    return;
  }

  // 限流检查
  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    sendError(res, 429, '请求过于频繁，请稍后再试');
    return;
  }

  try {
    // ---- 健康检查 ----
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), cacheSize: cache.size });
      return;
    }

    // ---- 分类统计 ----
    if (url.pathname === '/api/products/stats') {
      const stats = await getStats();
      sendJson(res, 200, { ok: true, data: stats });
      return;
    }

    // ---- 慢查询日志 ----
    if (url.pathname === '/api/products/slow-queries') {
      const logs = await getSlowQueries(10);
      sendJson(res, 200, { ok: true, data: logs });
      return;
    }

    // ---- 商品搜索（主接口）----
    if (url.pathname === '/api/products') {
      const params = normalizeParams(url.searchParams);
      const cacheKey = JSON.stringify(params);

      // 先查缓存
      const cached = cache.get(cacheKey);
      if (cached) {
        sendJson(res, 200, { ok: true, data: cached, meta: { cached: true, cacheSize: cache.size } });
        return;
      }

      // 缓存没有，查数据库
      const result = await searchProducts(params);

      // 组装完整响应（缓存里存的是这个完整结构，保证命中缓存和没命中时格式一样）
      const payload = {
        items: result.items,
        total: result.total,
        page: params.page,
        pageSize: params.pageSize,
        totalPages: Math.ceil(result.total / params.pageSize),
        costMs: result.costMs,
      };
      cache.set(cacheKey, payload);

      sendJson(res, 200, { ok: true, data: payload, meta: { cached: false, cacheSize: cache.size } });
      return;
    }

    // 没匹配到任何接口
    sendError(res, 404, '接口不存在');
  } catch (error) {
    console.error('[服务器错误]', error);
    sendError(res, 500, '服务器内部错误');
  }
});

// ============================================================
// 启动与关闭
// ============================================================

// 创建数据库连接池
initDatabase();

server.listen(PORT, HOST, async () => {
  const stats = await getStats();
  console.log(`[潮购商城搜索服务] http://${HOST}:${PORT}`);
  console.log(`[数据库] MySQL 已连接，载入 ${stats.total} 条商品，分类 ${stats.byCategory.length} 个`);
});

/** 优雅关闭：收到终止信号时，先关 HTTP 服务再关数据库连接 */
function shutdown() {
  console.log('\n[关闭中] 正在释放资源...');
  server.close(async () => {
    await closeDatabase();
    console.log('[已关闭]');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown); // Ctrl+C
process.on('SIGTERM', shutdown); // kill 命令

export { server, cache };
