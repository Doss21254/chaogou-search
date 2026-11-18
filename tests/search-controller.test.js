import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearchController } from '../src/core/search-controller.js';

/**
 * 竞态处理的行为测试。
 *
 * 模拟真实场景：用户快速输入多个关键词，服务端响应顺序与请求顺序不一致。
 * 断言界面最终展示的一定是最后一个关键词对应的结果。
 */

const mockSearch = vi.fn();

vi.mock('../src/api/products.js', () => ({
  searchProducts: (...args) => mockSearch(...args),
  fetchCategoryStats: vi.fn().mockResolvedValue({ total: 0, categories: {}, byCategory: [] }),
}));

/** 构造一个可控延迟的 mock：延迟越大越晚返回 */
function makeResponse(keyword, delayMs, total = 3) {
  return {
    items: Array.from({ length: total }, (_, i) => ({
      id: i + 1,
      name: `${keyword}-结果${i}`,
      category: 'digital',
      categoryLabel: '3C 数码',
      brand: '测试',
      price: 99,
      sales: 10,
      rating: 4.5,
      stock: 100,
      tags: [],
    })),
    total,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    costMs: delayMs,
    cached: false,
  };
}

describe('SearchController 竞态处理', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSearch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('旧请求晚返回时不会覆盖新结果', async () => {
    // 「a」请求慢（500ms），「ab」请求快（50ms）
    mockSearch.mockImplementation(({ keyword, signal }) => {
      const delay = keyword === 'a' ? 500 : 50;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(makeResponse(keyword, delay)), delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const controller = new SearchController({ debounceMs: 100 });
    const states = [];
    controller.subscribe((s) => states.push({ ...s }));

    controller.setKeyword('a');
    vi.advanceTimersByTime(100); // 防抖触发，请求 a 发出
    controller.setKeyword('ab');
    vi.advanceTimersByTime(100); // 防抖触发，请求 ab 发出

    await vi.advanceTimersByTimeAsync(600);

    const final = states[states.length - 1];
    // 最终结果必须是「ab」的结果
    expect(final.items[0].name).toContain('ab');
    expect(final.items.some((i) => i.name.startsWith('a-'))).toBe(false);
  });

  it('连续输入只在防抖期结束后发起一次请求', async () => {
    mockSearch.mockResolvedValue(makeResponse('x', 10));

    const controller = new SearchController({ debounceMs: 300 });

    controller.setKeyword('蓝');
    vi.advanceTimersByTime(50);
    controller.setKeyword('蓝牙');
    vi.advanceTimersByTime(50);
    controller.setKeyword('蓝牙耳');
    vi.advanceTimersByTime(50);
    controller.setKeyword('蓝牙耳机');

    // 还没到防抖窗口，不该有请求
    expect(mockSearch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    // 4 次输入 → 1 次请求
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ keyword: '蓝牙耳机' }));
  });

  it('防抖期间的所有中间输入都不会发出请求', async () => {
    mockSearch.mockResolvedValue(makeResponse('x', 10));
    const controller = new SearchController({ debounceMs: 300 });

    controller.setKeyword('a');
    await vi.advanceTimersByTimeAsync(100);
    controller.setKeyword('ab');
    await vi.advanceTimersByTimeAsync(100);
    controller.setKeyword('abc');
    await vi.advanceTimersByTimeAsync(100);
    controller.setKeyword('abcd');
    await vi.advanceTimersByTimeAsync(400);

    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('请求被取消时不触发错误状态', async () => {
    mockSearch.mockImplementation(({ signal }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(makeResponse('a', 500)), 500);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const controller = new SearchController({ debounceMs: 50 });
    const states = [];
    controller.subscribe((s) => states.push({ ...s }));

    controller.setKeyword('a');
    await vi.advanceTimersByTimeAsync(60);
    controller.setKeyword('ab');
    await vi.advanceTimersByTimeAsync(200);

    // 取消不应产生 error
    expect(states.every((s) => s.error === null)).toBe(true);
  });

  it('真实网络错误会进入 error 状态', async () => {
    mockSearch.mockRejectedValue(new Error('服务不可用'));

    const controller = new SearchController({ debounceMs: 50 });
    const states = [];
    controller.subscribe((s) => states.push({ ...s }));

    controller.setKeyword('x');
    await vi.advanceTimersByTimeAsync(200);

    const final = states[states.length - 1];
    expect(final.error).toBeTruthy();
    expect(final.loading).toBe(false);
  });

  it('切换分类会取消上一个关键词的请求', async () => {
    mockSearch.mockImplementation(({ keyword, signal }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(makeResponse(keyword || 'all', 300)), 300);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const controller = new SearchController({ debounceMs: 50 });

    controller.setKeyword('蓝牙');
    await vi.advanceTimersByTimeAsync(60);
    controller.setCategory('digital');
    await vi.advanceTimersByTimeAsync(400);

    // 最后一次请求应该是分类切换后的
    const lastCall = mockSearch.mock.calls.at(-1)[0];
    expect(lastCall.category).toBe('digital');
  });

  it('切换排序方式会重新发起请求', async () => {
    mockSearch.mockResolvedValue(makeResponse('x', 10));

    const controller = new SearchController({ debounceMs: 50 });
    controller.setSort('price_asc');
    await vi.advanceTimersByTimeAsync(100);

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ sort: 'price_asc' }));
  });

  it('加载更多会追加结果而不是替换', async () => {
    mockSearch.mockImplementation(({ page }) => {
      const p = page ?? 1;
      return Promise.resolve({
        ...makeResponse(`第${p}页`, 5),
        page: p,
        totalPages: 3,
        total: 60,
      });
    });

    const controller = new SearchController({ debounceMs: 50, pageSize: 20 });
    const states = [];
    controller.subscribe((s) => states.push({ ...s }));

    controller.setKeyword('x');
    await vi.advanceTimersByTimeAsync(100);
    const afterFirst = states.at(-1).items.length;

    controller.loadMore();
    await vi.advanceTimersByTimeAsync(100);
    const afterMore = states.at(-1).items.length;

    expect(afterMore).toBeGreaterThan(afterFirst);
  });

  it('已到最后一页时 loadMore 不再发起请求', async () => {
    mockSearch.mockResolvedValue({ ...makeResponse('x', 5), totalPages: 1 });

    const controller = new SearchController({ debounceMs: 50 });
    controller.setKeyword('x');
    await vi.advanceTimersByTimeAsync(100);

    const callsBefore = mockSearch.mock.calls.length;
    controller.loadMore();
    await vi.advanceTimersByTimeAsync(100);

    expect(mockSearch.mock.calls.length).toBe(callsBefore);
  });

  it('loading 期间会拒绝重复的 loadMore', async () => {
    mockSearch.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(makeResponse('x', 300)), 300))
    );

    const controller = new SearchController({ debounceMs: 50 });
    controller.setKeyword('x');
    await vi.advanceTimersByTimeAsync(60);

    const callsBefore = mockSearch.mock.calls.length;
    controller.loadMore();
    controller.loadMore();
    await vi.advanceTimersByTimeAsync(400);

    // loading 期间只应有一次在途请求
    expect(mockSearch.mock.calls.length).toBe(callsBefore);
  });

  it('destroy 会取消在途请求与挂起的防抖', async () => {
    mockSearch.mockImplementation(({ signal }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(makeResponse('x', 300)), 300);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const controller = new SearchController({ debounceMs: 50 });
    controller.setKeyword('x');
    await vi.advanceTimersByTimeAsync(60);

    controller.destroy();
    await vi.advanceTimersByTimeAsync(400);

    // destroy 之后不应再更新状态
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });
});
