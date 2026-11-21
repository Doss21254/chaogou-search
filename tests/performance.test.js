import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce, throttle, RequestSequencer, isAbortError } from '../src/core/performance.js';

describe('debounce 防抖', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('连续触发只执行最后一次', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    debounced('ab');
    debounced('abc');

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('abc');
  });

  it('间隔超过等待时长则各自执行一次', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    vi.advanceTimersByTime(301);
    debounced('b');
    vi.advanceTimersByTime(301);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'a');
    expect(fn).toHaveBeenNthCalledWith(2, 'b');
  });

  it('leading 模式下首次立即执行', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300, { leading: true });

    debounced('a');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');

    debounced('ab');
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, 'ab');
  });

  it('cancel 能取消待执行调用', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    expect(debounced.pending()).toBe(true);

    debounced.cancel();
    vi.advanceTimersByTime(500);

    expect(fn).not.toHaveBeenCalled();
    expect(debounced.pending()).toBe(false);
  });

  it('flush 能立即执行挂起的调用', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('abc');
    debounced.flush();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('abc');

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('没有挂起调用时 flush 不会重复执行', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced.flush();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('throttle 节流', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('窗口内多次触发只执行一次', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 200);

    throttled();
    throttled();
    throttled();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('窗口结束后可以再次执行', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 200);

    throttled();
    vi.advanceTimersByTime(201);
    throttled();

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('trailing 模式会在窗口结束时补一次最后一次调用', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 200, { leading: false });

    throttled('a');
    throttled('b');
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('cancel 能取消挂起调用', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 200, { leading: false });

    throttled('a');
    throttled.cancel();
    vi.advanceTimersByTime(300);

    expect(fn).not.toHaveBeenCalled();
  });
});

describe('RequestSequencer 竞态控制器', () => {
  it('新请求会取消上一个在途请求的 signal', () => {
    const seq = new RequestSequencer();

    const first = seq.start();
    expect(first.signal.aborted).toBe(false);

    const second = seq.start();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('只有最新序号的请求被视为有效', () => {
    const seq = new RequestSequencer();

    const first = seq.start();
    const second = seq.start();

    expect(seq.isCurrent(first.seq)).toBe(false);
    expect(seq.isCurrent(second.seq)).toBe(true);
  });

  it('序号严格递增', () => {
    const seq = new RequestSequencer();

    const a = seq.start();
    const b = seq.start();
    const c = seq.start();

    expect(b.seq).toBeGreaterThan(a.seq);
    expect(c.seq).toBeGreaterThan(b.seq);
  });

  it('abort 能取消当前在途请求', () => {
    const seq = new RequestSequencer();
    const current = seq.start();

    seq.abort();
    expect(current.signal.aborted).toBe(true);
  });

  it('invalidate 使当前在途请求失效但不创建新请求', () => {
    const seq = new RequestSequencer();

    const first = seq.start();
    expect(first.signal.aborted).toBe(false);
    expect(seq.isCurrent(first.seq)).toBe(true);

    seq.invalidate();

    // 旧请求被取消
    expect(first.signal.aborted).toBe(true);
    // 旧序号失效
    expect(seq.isCurrent(first.seq)).toBe(false);
    // 没有创建新的 AbortController（signal 为 null）
    expect(seq.signal).toBe(null);
  });

  it('invalidate 后 start 拿到的新序号大于旧序号', () => {
    const seq = new RequestSequencer();
    const first = seq.start();
    seq.invalidate();
    const second = seq.start();

    expect(second.seq).toBeGreaterThan(first.seq);
    expect(seq.isCurrent(second.seq)).toBe(true);
  });
});

describe('isAbortError', () => {
  it('识别 AbortError', () => {
    const error = new DOMException('The user aborted a request.', 'AbortError');
    expect(isAbortError(error)).toBe(true);
  });

  it('普通错误不被误判', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(new TypeError('network'))).toBe(false);
  });
});
