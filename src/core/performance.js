/**
 * 防抖（debounce）：等用户停下来再执行。
 *
 * 适用场景：搜索输入、窗口 resize、表单校验提示。
 * 语义：连续触发时只认最后一次，wait 毫秒内没有新触发才真正执行。
 *
 * @param {Function} fn 需要防抖的函数
 * @param {number} wait 静默等待时长（毫秒）
 * @param {{ leading?: boolean, trailing?: boolean }} [options]
 *   leading  - 首次触发立即执行（用于「立即搜索」按钮）
 *   trailing - 静默期结束后执行（默认开启，这是防抖的核心语义）
 * @returns {Function & { cancel: () => void, flush: () => void }} 带 cancel/flush 的包装函数
 */
export function debounce(fn, wait = 300, options = {}) {
  const { leading = false, trailing = true } = options;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;
  let result;

  function invoke() {
    timer = null;
    if (trailing && lastArgs) {
      result = fn.apply(lastThis, lastArgs);
      lastArgs = null;
      lastThis = null;
    }
    return result;
  }

  function debounced(...args) {
    lastArgs = args;
    lastThis = this;

    const callNow = leading && timer === null;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(invoke, wait);

    if (callNow) {
      result = fn.apply(lastThis, lastArgs);
      lastArgs = null;
      lastThis = null;
    }
    return result;
  }

  /** 取消尚未执行的调用（组件卸载时必须调用，避免内存泄漏与幽灵请求） */
  debounced.cancel = function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    lastThis = null;
  };

  /** 立即执行挂起的调用（用户按回车时用） */
  debounced.flush = function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      return invoke();
    }
    return result;
  };

  /** 是否存在挂起但未执行的调用 */
  debounced.pending = function pending() {
    return timer !== null;
  };

  return debounced;
}

/**
 * 节流（throttle）：每段时间内最多执行一次。
 *
 * 适用场景：滚动加载更多、resize 重排、鼠标移动跟随、埋点上报。
 * 语义：无论触发多少次，在 wait 窗口内最多执行一次。
 *
 * 注意：节流与防抖的适用场景是相反的，不要把节流套在搜索输入上——
 * 节流会在用户仍在打字时就发出请求，既浪费请求又可能拿到旧结果。
 *
 * @param {Function} fn 需要节流的函数
 * @param {number} wait 窗口时长（毫秒）
 * @param {{ leading?: boolean, trailing?: boolean }} [options]
 * @returns {Function & { cancel: () => void }}
 */
export function throttle(fn, wait = 200, options = {}) {
  const { leading = true, trailing = true } = options;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;
  let lastInvokeTime = 0;

  function invoke(context, args) {
    lastInvokeTime = Date.now();
    lastArgs = null;
    lastThis = null;
    return fn.apply(context, args);
  }

  function throttled(...args) {
    const now = Date.now();
    // lastInvokeTime 为 0 表示尚未执行过任何一次
    const isFirst = lastInvokeTime === 0;

    // leading 模式下首次调用立即执行
    if (leading && isFirst) {
      return invoke(this, args);
    }

    // 首次调用（leading 关闭）从现在开始计一个完整窗口
    const remaining = isFirst ? wait : wait - (now - lastInvokeTime);

    if (remaining <= 0) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      return invoke(this, args);
    }

    lastArgs = args;
    lastThis = this;

    // 同一窗口内只挂一个定时器，参数始终保留最新一次
    if (timer === null && trailing) {
      timer = setTimeout(() => {
        timer = null;
        if (lastArgs) invoke(lastThis, lastArgs);
      }, remaining);
    }
    return undefined;
  }

  throttled.cancel = function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    lastThis = null;
    lastInvokeTime = 0;
  };

  return throttled;
}

/**
 * 竞态控制器：解决「旧响应晚到覆盖新结果」的问题。
 *
 * 面试要点：单靠防抖不够。防抖只减少了请求数量，但当服务端响应时间
 * 不稳定时（请求 A 先发但后返回），晚到的 A 依然会覆盖 B 的结果。
 *
 * 这里用两道防线：
 *  1. AbortController —— 新请求发出时取消上一个在途请求，
 *     让浏览器直接丢弃旧响应，省掉带宽与解析开销。
 *  2. 请求序号 —— 响应回来时比对序号，非最新直接丢弃。
 *     即使取消失败（服务端已返回、无法 abort），也不会渲染错数据。
 *
 * @template T
 */
export class RequestSequencer {
  #controller = null;
  #seq = 0;
  #currentSeq = 0;

  /**
   * 发起新请求，自动取消上一个在途请求。
   * @returns {{ signal: AbortSignal, seq: number }}
   */
  start() {
    this.#controller?.abort();
    this.#controller = new AbortController();
    this.#currentSeq = ++this.#seq;
    return { signal: this.#controller.signal, seq: this.#currentSeq };
  }

  /**
   * 判断某个响应是否仍然有效（是最新一次请求且未被取消）。
   * @param {number} seq 发起时拿到的序号
   */
  isCurrent(seq) {
    return seq === this.#currentSeq;
  }

  /** 当前在途请求的 AbortSignal，无请求时为 null */
  get signal() {
    return this.#controller?.signal ?? null;
  }

  /** 取消当前在途请求 */
  abort() {
    this.#controller?.abort();
    this.#controller = null;
  }

  /**
   * 使当前在途请求失效，但不发起新请求。
   *
   * 用在防抖等待期：用户改了关键词但新搜索还没触发，
   * 这时旧请求如果返回，不应该渲染。
   * 调用此方法会：
   *   1. abort 当前在途请求（让浏览器丢弃响应）
   *   2. 推进 #currentSeq（让旧请求的 isCurrent 返回 false）
   *
   * 与 start() 的区别：start() 会创建新的 AbortController，
   * invalidate() 不会——它只是让旧请求失效，新请求由调用方稍后发起。
   */
  invalidate() {
    this.#controller?.abort();
    this.#controller = null;
    this.#currentSeq = ++this.#seq;
  }
}

/**
 * 判断一个错误是否为「主动取消」而非真实失败。
 * AbortController 触发的请求会以 AbortError 结束，属于预期行为，不该弹错误提示。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  return error instanceof DOMException && (error.name === 'AbortError' || error.code === 20);
}

/**
 * 判断一个 fetch 错误是否为网络中断（含 abort）。
 * @param {unknown} error
 */
export function isNetworkError(error) {
  return isAbortError(error) || error instanceof TypeError;
}
