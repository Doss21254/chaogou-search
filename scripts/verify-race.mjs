/**
 * 端到端验证脚本（无浏览器依赖，直接用 Node 模拟前端调用序列）。
 *
 * 目的：验证在「连续输入 + 响应乱序」的真实条件下，
 * 最终界面数据一定来自最后一个关键词。
 */

import { RequestSequencer, debounce } from '../src/core/performance.js';

/** 模拟服务端：响应时间随关键词长度变化，制造乱序 */
const server = async (keyword, { delay, signal }) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({
        keyword,
        items: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: `${keyword} 商品 ${i}` })),
      });
    }, delay);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
};

const delayOf = (kw) => {
  // 短词响应慢、长词响应快 —— 制造最容易触发竞态的条件
  if (kw.length <= 1) return 400;
  if (kw.length === 2) return 200;
  return 30;
};

async function main() {
  console.log('=== 竞态场景：输入 "蓝" → "蓝牙" → "蓝牙耳机" ===');
  console.log('（短词故意更慢，让旧请求后到）\n');

  const sequencer = new RequestSequencer();
  const debounced = debounce(async () => {
    const { signal, seq } = sequencer.start();
    const keyword = currentKeyword;
    console.log(`  → 发出请求「${keyword}」(seq=${seq}, 延迟=${delayOf(keyword)}ms)`);
    try {
      const result = await server(keyword, { delay: delayOf(keyword), signal });
      if (!sequencer.isCurrent(seq)) {
        console.log(`  ✗ 丢弃「${keyword}」的响应(seq=${seq}) —— 已有更新的请求`);
        return;
      }
      displayed = result;
      console.log(`  ✓ 渲染「${keyword}」的结果(seq=${seq})`);
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(`  ⊘ 「${keyword}」的请求被主动取消`);
        return;
      }
      throw error;
    }
  }, 200);

  let currentKeyword = '';
  let displayed = null;

  const type = async (text) => {
    currentKeyword = text;
    console.log(`输入「${text}」`);
    debounced();
    await new Promise((r) => setTimeout(r, 260)); // 跨过防抖窗口
  };

  await type('蓝');
  await type('蓝牙');
  await type('蓝牙耳机');

  // 等待所有在途请求结束
  await new Promise((r) => setTimeout(r, 800));

  console.log('\n=== 最终结果 ===');
  console.log('界面展示的关键词:', displayed?.keyword);
  console.log('商品:', displayed?.items.map((i) => i.name).join(' / '));

  if (displayed?.keyword === '蓝牙耳机') {
    console.log('\n✓ 通过：最终结果是最后一个关键词，未被旧响应污染');
    return 0;
  }
  console.log('\n✗ 失败：最终结果被旧响应覆盖');
  return 1;
}

process.exit(await main());
