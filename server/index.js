/**
 * 商品搜索 HTTP 服务（Node 原生 http，无框架依赖）。
 *
 * 接口设计：
 *   GET /api/products?keyword=&category=&sort=&page=&pageSize=
 *   GET /api/products/stats          —— 分类统计
 *   GET /api/products/slow-queries   —— 慢查询日志
 *   GET /api/health                  —— 健康检查
 *
 * 面试要点：
 *   1. 参数校验与规范化（白名单化 sort，防止注入到 SQL 拼接）
 *   2. 简单 LRU 缓存，降低重复查询的数据库压力
 *   3. 基础限流，防止单个客户端刷爆服务端
 *   4. 统一的 JSON 错误结构与请求 id 便于排查
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';
import { initDatabase, searchProducts, getStats, getSlowQueries, closeDatabase } from './db.js';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const CACHE_MAX = 200;
const CACHE_TTL = 30_000;
const RATE_LIMIT_WINDOW = 10_000;
const RATE_LIMIT_MAX = 120;

/** 简单 LRU 缓存：Map 保持插入顺序，命中后删除再插入实现「最近使用」 */
class LruCache {
  #map = new Map();
  #max;
  #ttl;

  constructor(max = CACHE_MAX, ttl = CACHE_TTL) {
    this.#max = max;
    this.#ttl = ttl;
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.time > this.#ttl) {
      this.#map.delete(key);
      return undefined;
    }
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, { value, time: Date.now() });
    if (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
    }
  }

  get size() {
    return this.#map.size;
  }

  clear() {
    this.#map.clear();
  }
}

const cache = new LruCache();
const rateLimit = new Map();

/** 滑动窗口计数限流 */
function checkRateLimit(ip) {
  const now = Date.now();
  const list = (rateLimit.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (list.length >= RATE_LIMIT_MAX) {
    rateLimit.set(ip, list);
    return false;
  }
  list.push(now);
  rateLimit.set(ip, list);
  return true;
}

let requestId = 0;

function send(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Request-Id': `r${++requestId}`,
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  send(res, status, { ok: false, error: { code, message } });
}

/**
 * 规范化查询参数：白名单化，避免非法值进入 SQL 层。
 * @param {URLSearchParams} params
 */
function normalizeParams(params) {
  const keyword = (params.get('keyword') || '').slice(0, 64);
  const category = (params.get('category') || '').slice(0, 32);
  const sortRaw = (params.get('sort') || 'default').slice(0, 16);
  const sort = ['default', 'sales', 'price_asc', 'price_desc'].includes(sortRaw) ? sortRaw : 'default';
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, 500));
  const pageSize = Math.max(1, Math.min(Number(params.get('pageSize')) || 20, 100));
  return { keyword, category, sort, page, pageSize, offset: (page - 1) * pageSize };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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
    sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET 请求');
    return;
  }

  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    sendError(res, 429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
    return;
  }

  try {
    if (url.pathname === '/api/health') {
      send(res, 200, { ok: true, uptime: Math.round(process.uptime()), cacheSize: cache.size });
      return;
    }

    if (url.pathname === '/api/products/stats') {
      send(res, 200, { ok: true, data: getStats() });
      return;
    }

    if (url.pathname === '/api/products/slow-queries') {
      send(res, 200, { ok: true, data: getSlowQueries(10) });
      return;
    }

    if (url.pathname === '/api/products') {
      const params = normalizeParams(url.searchParams);
      const cacheKey = JSON.stringify(params);

      const cached = cache.get(cacheKey);
      if (cached) {
        send(res, 200, { ok: true, data: cached, meta: { cached: true, cacheSize: cache.size } });
        return;
      }

      const result = searchProducts(params);

      // 缓存的是完整响应体，保证命中缓存与未命中时结构完全一致
      // （早期版本缓存了 searchProducts 的原始返回值，缺少分页字段，
      //   导致命中缓存的响应里没有 page/pageSize/totalPages）
      const payload = {
        items: result.items,
        total: result.total,
        page: params.page,
        pageSize: params.pageSize,
        totalPages: Math.ceil(result.total / params.pageSize),
        costMs: result.costMs,
      };
      cache.set(cacheKey, payload);

      send(res, 200, {
        ok: true,
        data: payload,
        meta: { cached: false, cacheSize: cache.size },
      });
      return;
    }

    sendError(res, 404, 'NOT_FOUND', '接口不存在');
  } catch (error) {
    console.error('[server error]', error);
    sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
  }
});

initDatabase();

server.listen(PORT, HOST, () => {
  const stats = getStats();
  console.log(`[潮购商城搜索服务] http://${HOST}:${PORT}`);
  console.log(`[数据库] 已载入 ${stats.total} 条商品，分类 ${stats.byCategory.length} 个`);
});

function shutdown() {
  console.log('\n[关闭中] 正在释放资源...');
  server.close(() => {
    closeDatabase();
    console.log('[已关闭]');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, cache };
