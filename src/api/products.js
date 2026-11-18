/**
 * 商品搜索接口封装。
 * 所有请求都接受 AbortSignal，便于上层用 AbortController 取消过期请求。
 */

const BASE = import.meta.env?.VITE_API_BASE ?? '/api';

/**
 * @typedef {object} Product
 * @property {number} id
 * @property {string} name
 * @property {string} category
 * @property {string} categoryLabel
 * @property {string} brand
 * @property {number} price
 * @property {number} sales
 * @property {number} rating
 * @property {number} stock
 * @property {string[]} tags
 */

/**
 * @typedef {object} SearchResult
 * @property {Product[]} items
 * @property {number} total
 * @property {number} page
 * @property {number} pageSize
 * @property {number} totalPages
 * @property {number} costMs
 * @property {boolean} cached
 */

/**
 * 搜索商品。
 *
 * @param {object} params
 * @param {string} [params.keyword]
 * @param {string} [params.category]
 * @param {string} [params.sort]
 * @param {number} [params.page]
 * @param {number} [params.pageSize]
 * @param {AbortSignal} [params.signal] 取消信号
 * @returns {Promise<SearchResult>}
 */
export async function searchProducts({ keyword = '', category = '', sort = 'default', page = 1, pageSize = 20, signal } = {}) {
  const query = new URLSearchParams({ keyword, category, sort, page: String(page), pageSize: String(pageSize) });
  const response = await fetch(`${BASE}/products?${query}`, { signal, headers: { Accept: 'application/json' } });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  return { ...payload.data, cached: payload.meta?.cached ?? false };
}

/**
 * 获取分类统计，用于渲染分类标签与数量。
 * @returns {Promise<{ total: number, categories: Record<string,string>, byCategory: {category:string,c:number}[] }>}
 */
export async function fetchCategoryStats() {
  const response = await fetch(`${BASE}/products/stats`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('获取分类统计失败');
  const payload = await response.json();
  return payload.data;
}

/**
 * 获取慢查询日志，用于演示索引优化的实际效果。
 * @returns {Promise<object[]>}
 */
export async function fetchSlowQueries() {
  const response = await fetch(`${BASE}/products/slow-queries`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('获取慢查询日志失败');
  const payload = await response.json();
  return payload.data;
}
