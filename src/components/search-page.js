/**
 * 搜索页渲染层：把 SearchController 的状态映射成 DOM。
 *
 * 渲染策略：
 *   - 骨架屏（而非转圈）作为 loading 态，感知更快
 *   - 结果变更用 DocumentFragment 批量插入，避免逐条 append 触发多次重排
 *   - 关键词高亮：对用户输入做转义后替换，避免 XSS
 */

import { SearchController } from '../core/search-controller.js';
import { fetchCategoryStats } from '../api/products.js';

const CATEGORY_ORDER = ['fashion', 'digital', 'home', 'food', 'sports'];

const SORT_OPTIONS = [
  { value: 'default', label: '综合排序' },
  { value: 'sales', label: '销量优先' },
  { value: 'price_asc', label: '价格从低到高' },
  { value: 'price_desc', label: '价格从高到低' },
];

/** HTML 转义，所有插入 DOM 的用户数据都要过这一层 */
function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * 高亮关键词：先转义再插入 <mark>，顺序不能反。
 * @param {string} text
 * @param {string} keyword
 */
function highlight(text, keyword) {
  const safe = escapeHtml(text);
  const kw = keyword.trim();
  if (!kw) return safe;
  const pattern = kw.split(/\s+/).filter(Boolean).map(escapeHtml).join('|');
  if (!pattern) return safe;
  return safe.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
}

function skeletonMarkup(count = 8) {
  return Array.from(
    { length: count },
    () => `
    <article class="skeleton-card" aria-hidden="true">
      <div class="skeleton-block skeleton-img"></div>
      <div class="skeleton-block skeleton-line"></div>
      <div class="skeleton-block skeleton-line short"></div>
      <div class="skeleton-block skeleton-price"></div>
    </article>
  `
  ).join('');
}

function productMarkup(item, keyword) {
  const lowStock = item.stock < 50;
  return `
    <article class="product-card" data-id="${item.id}">
      <div class="product-thumb" aria-hidden="true">
        <span class="product-cat">${escapeHtml(item.categoryLabel)}</span>
        <span class="product-brand">${escapeHtml(item.brand)}</span>
      </div>
      <h3 class="product-name">${highlight(item.name, keyword)}</h3>
      <div class="product-meta">
        <span class="product-rating">★ ${item.rating.toFixed(1)}</span>
        <span class="product-sales">已售 ${item.sales}</span>
      </div>
      <div class="product-tags">
        ${item.tags
          .slice(0, 3)
          .map((t) => `<span class="product-tag">${escapeHtml(t)}</span>`)
          .join('')}
        ${lowStock ? '<span class="product-tag warn">库存紧张</span>' : ''}
      </div>
      <div class="price-row">
        <span class="price">¥${item.price.toFixed(2)}</span>
        <button class="btn btn-primary add-to-cart" type="button" data-id="${item.id}">加入购物车</button>
      </div>
    </article>
  `;
}

export function mountSearchPage(root) {
  const controller = new SearchController({ debounceMs: 300, pageSize: 20 });

  root.innerHTML = `
    <div class="search-shell">
      <header class="search-header">
        <div class="shell-inner">
          <a class="brand" href="#top"><span class="brand-dot"></span>潮购商城</a>
          <label class="search-box" for="searchInput">
            <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>
            <input id="searchInput" data-role="search-input" type="search" placeholder="搜索商品、品牌或标签" autocomplete="off" aria-describedby="searchHint" />
            <span class="search-spinner" data-role="spinner" hidden aria-hidden="true"></span>
          </label>
          <button class="btn btn-primary search-submit" type="button" data-role="submit">搜索</button>
        </div>
      </header>

      <nav class="filter-bar" aria-label="筛选与排序">
        <div class="shell-inner filter-inner">
          <div class="chips" role="group" aria-label="商品分类" data-role="categories"></div>
          <label class="sort-select">
            <span class="sr-only">排序方式</span>
            <select data-role="sort">
              ${SORT_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
            </select>
          </label>
        </div>
      </nav>

      <main class="shell-inner" id="top">
        <p class="search-hint" id="searchHint" role="status" aria-live="polite" data-role="summary"></p>
        <div class="products" data-role="results" aria-busy="false"></div>
        <div class="load-more" data-role="load-more" hidden>
          <button class="btn btn-secondary" type="button" data-role="load-more-btn">加载更多</button>
        </div>
      </main>
    </div>
    <div id="toast" role="status" aria-live="polite"></div>
  `;

  const el = {
    input: root.querySelector('[data-role="search-input"]'),
    spinner: root.querySelector('[data-role="spinner"]'),
    summary: root.querySelector('[data-role="summary"]'),
    results: root.querySelector('[data-role="results"]'),
    categories: root.querySelector('[data-role="categories"]'),
    sort: root.querySelector('[data-role="sort"]'),
    loadMore: root.querySelector('[data-role="load-more"]'),
    loadMoreBtn: root.querySelector('[data-role="load-more-btn"]'),
    toast: root.querySelector('#toast'),
  };

  const toast = (message) => {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.toast.classList.remove('show'), 1600);
  };

  // 分类标签
  el.categories.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-category]');
    if (!chip) return;
    controller.setCategory(chip.dataset.category);
  });

  el.sort.addEventListener('change', () => controller.setSort(el.sort.value));

  root.querySelector('[data-role="submit"]').addEventListener('click', () => {
    el.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

  el.loadMoreBtn.addEventListener('click', () => controller.loadMore());

  root.querySelector('.products').addEventListener('click', (event) => {
    if (event.target.closest('.add-to-cart')) {
      toast('已加入购物车');
    }
  });

  let lastRequestCount = 0;

  controller.subscribe((state) => {
    el.spinner.hidden = !state.loading;
    el.results.setAttribute('aria-busy', String(state.loading));

    // 分类高亮
    el.categories.querySelectorAll('[data-category]').forEach((chip) => {
      const active = chip.dataset.category === state.category;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    });

    if (state.error) {
      el.results.innerHTML = `<p class="empty-state error">${escapeHtml(state.error)}</p>`;
      el.summary.textContent = '';
      el.loadMore.hidden = true;
      return;
    }

    // 首次加载显示骨架屏
    if (state.loading && state.items.length === 0) {
      el.results.innerHTML = skeletonMarkup();
      el.summary.textContent = '正在搜索…';
      return;
    }

    if (state.items.length === 0) {
      el.results.innerHTML = `<p class="empty-state">没有找到匹配「${escapeHtml(state.keyword)}」的商品，换个关键词试试。</p>`;
      el.summary.textContent = `共 0 条结果`;
      el.loadMore.hidden = true;
      return;
    }

    // 用 DocumentFragment 批量渲染
    const fragment = document.createDocumentFragment();
    const wrapper = document.createElement('div');
    wrapper.style.display = 'contents';
    wrapper.innerHTML = state.items.map((item) => productMarkup(item, state.keyword)).join('');
    while (wrapper.firstElementChild) fragment.appendChild(wrapper.firstElementChild);
    el.results.replaceChildren(fragment);

    const pageInfo = `第 ${state.page} / ${Math.max(state.totalPages, 1)} 页`;
    el.summary.textContent = `共 ${state.total} 条结果 · ${pageInfo} · 服务端耗时 ${state.costMs}ms · 本次会话发起 ${state.requestCount} 次请求`;
    el.loadMore.hidden = state.page >= state.totalPages;

    if (state.requestCount !== lastRequestCount) {
      lastRequestCount = state.requestCount;
    }
  });

  controller.attach(root);

  // 分类统计
  fetchCategoryStats()
    .then((stats) => {
      const counts = Object.fromEntries(stats.byCategory.map((c) => [c.category, c.c]));
      el.categories.innerHTML = [
        `<button class="chip active" type="button" data-category="" aria-pressed="true">全部</button>`,
        ...CATEGORY_ORDER.filter((c) => stats.categories[c]).map(
          (c) =>
            `<button class="chip" type="button" data-category="${c}" aria-pressed="false">${escapeHtml(stats.categories[c])}<span class="chip-count">${counts[c] ?? 0}</span></button>`
        ),
      ].join('');
    })
    .catch(() => {
      el.categories.innerHTML = `<button class="chip active" type="button" data-category="" aria-pressed="true">全部</button>`;
    });

  controller.setKeyword('');
  return controller;
}
