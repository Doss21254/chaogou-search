/**
 * 搜索控制器：把「输入 → 防抖 → 请求 → 竞态防护 → 渲染」这条链路串起来。
 *
 * 这是整个项目的技术内核，也是面试时最值得讲的部分。
 *
 * 分工：
 *   debounce        —— 输入层，合并连续输入，减少无效请求
 *   RequestSequencer—— 请求层，取消在途旧请求 + 请求序号兜底
 *   throttle        —— 滚动加载场景，与搜索互不干扰
 */

import { searchProducts } from '../api/products.js';
import { debounce, throttle, RequestSequencer, isAbortError } from './performance.js';

export const DEFAULT_DEBOUNCE_MS = 300;

export class SearchController {
  #sequencer = new RequestSequencer();
  #debouncedSearch;
  #state = {
    keyword: '',
    category: '',
    sort: 'default',
    page: 1,
    pageSize: 20,
    items: [],
    total: 0,
    totalPages: 0,
    costMs: 0,
    loading: false,
    error: null,
    requestCount: 0,
  };
  #listeners = new Set();
  #element = null;

  constructor({ debounceMs = DEFAULT_DEBOUNCE_MS, pageSize = 20 } = {}) {
    this.#debouncedSearch = debounce(() => this.#execute(), debounceMs);
    this.#state.pageSize = pageSize;
  }

  /**
   * 订阅状态变化。
   * @param {(state: object) => void} listener
   * @returns {() => void} 取消订阅函数
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.#getState());
    return () => this.#listeners.delete(listener);
  }

  #getState() {
    return { ...this.#state, items: [...this.#state.items] };
  }

  #emit() {
    const snapshot = this.#getState();
    this.#listeners.forEach((fn) => fn(snapshot));
  }

  #patch(partial) {
    Object.assign(this.#state, partial);
    this.#emit();
  }

  /**
   * 绑定 DOM 元素：自动监听输入与滚动。
   * @param {HTMLElement} element 包含搜索框与结果列表的容器
   */
  attach(element) {
    this.#element = element;
    const input = element.querySelector('[data-role="search-input"]');
    const scrollRoot = element.querySelector('[data-role="scroll-root"]') ?? window;

    input?.addEventListener('input', () => {
      this.setKeyword(input.value);
    });

    input?.addEventListener('keydown', (event) => {
      // 回车立即执行，跳过等待防抖
      if (event.key === 'Enter') {
        event.preventDefault();
        this.#debouncedSearch.flush();
      }
      // Esc 清空
      if (event.key === 'Escape') {
        input.value = '';
        this.setKeyword('');
      }
    });

    // 滚动加载更多：这里才是节流的正确用法
    if (scrollRoot === window) {
      window.addEventListener('scroll', this.#throttledLoadMore, { passive: true });
    } else {
      scrollRoot.addEventListener('scroll', this.#throttledLoadMore, { passive: true });
    }
  }

  /** 组件卸载时务必调用，取消定时器与在途请求，避免内存泄漏 */
  destroy() {
    this.#debouncedSearch.cancel();
    this.#sequencer.abort();
    // SSR / Node 环境下没有 window，需要判空
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', this.#throttledLoadMore);
    }
    this.#listeners.clear();
  }

  /**
   * 更新关键词：立即更新 UI 状态，请求交给防抖延后。
   *
   * 关键：调用 invalidate() 使上一个在途请求立即失效。
   * 否则在防抖等待的 300ms 内，旧关键词的响应如果返回，
   * 会通过序号检查并渲染旧结果——用户看到关键词已变、结果却没变。
   * @param {string} value
   */
  setKeyword(value) {
    this.#state.keyword = value;
    this.#state.page = 1;
    // 立即作废当前在途请求：abort + 推进序号，旧响应回来时 isCurrent 返回 false
    this.#sequencer.invalidate();
    this.#patch({ keyword: value, page: 1, requestCount: this.#state.requestCount });
    this.#debouncedSearch();
  }

  /**
   * 更新分类：立即请求（用户点击是明确意图，不需要防抖）。
   * @param {string} category
   */
  setCategory(category) {
    this.#state.category = category;
    this.#state.page = 1;
    this.#debouncedSearch.cancel();
    this.#execute();
  }

  /**
   * 更新排序方式。
   * @param {string} sort
   */
  setSort(sort) {
    this.#state.sort = sort;
    this.#state.page = 1;
    this.#debouncedSearch.cancel();
    this.#execute();
  }

  /** 加载下一页（无限滚动用） */
  loadMore() {
    if (this.#state.loading) return;
    if (this.#state.page >= this.#state.totalPages) return;
    this.#state.page += 1;
    this.#execute({ append: true });
  }

  /** 节流版：滚动事件高频触发，用节流合并到 200ms 一次 */
  #throttledLoadMore = throttle(() => {
    // 优先用 [data-role="scroll-root"] 元素的滚动位置（如果有独立滚动容器）
    // 没有就用 window/document.documentElement（整页滚动）
    const scrollRoot = this.#element?.querySelector('[data-role="scroll-root"]');
    let scrollTop, scrollHeight, clientHeight;
    if (scrollRoot) {
      scrollTop = scrollRoot.scrollTop;
      scrollHeight = scrollRoot.scrollHeight;
      clientHeight = scrollRoot.clientHeight;
    } else {
      // 整页滚动：用 documentElement（<html>）的滚动数据
      const doc = document.documentElement;
      scrollTop = doc.scrollTop;
      scrollHeight = doc.scrollHeight;
      clientHeight = doc.clientHeight;
    }
    // 距底部不足 200px 时加载下一页
    if (scrollHeight - scrollTop - clientHeight < 200) {
      this.loadMore();
    }
  }, 200);

  /**
   * 真正发起请求。
   *
   * 竞态防护在这里落地：
   *   1. RequestSequencer.start() 会 abort 上一个在途请求；
   *   2. 响应回来后用 isCurrent(seq) 判断是否仍是最新请求。
   *
   * @param {{ append?: boolean }} [options]
   */
  async #execute({ append = false } = {}) {
    const { signal, seq } = this.#sequencer.start();
    const { keyword, category, sort, page, pageSize } = this.#state;

    this.#patch({ loading: true, error: null, requestCount: this.#state.requestCount + 1 });

    try {
      const result = await searchProducts({ keyword, category, sort, page, pageSize, signal });

      // 关键：即使 abort 失败（响应已到），序号不符也绝不渲染
      if (!this.#sequencer.isCurrent(seq)) return;

      this.#patch({
        items: append ? [...this.#state.items, ...result.items] : result.items,
        total: result.total,
        totalPages: result.totalPages,
        costMs: result.costMs,
        loading: false,
        error: null,
      });
    } catch (error) {
      // 主动取消不是错误，静默忽略
      if (isAbortError(error)) return;
      if (!this.#sequencer.isCurrent(seq)) return;

      this.#patch({
        loading: false,
        error: error.message || '搜索失败，请稍后重试',
        items: append ? this.#state.items : [],
      });
    }
  }
}
