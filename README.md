# 潮购商城 · 商品搜索

一个把「搜索框」做透的前端工程项目：Node 服务端 + SQLite 全文索引 + 前端防抖与请求竞态处理。

重点不在界面，而在**搜索链路**——从输入到渲染之间每一个可能出问题的地方，都被显式处理并有测试覆盖。

---

## 快速开始

```bash
npm install
npm run dev
```

- 前端：http://localhost:5173
- 后端：http://127.0.0.1:3001

首次启动会自动创建 SQLite 数据库并灌入 1 万条商品数据。

单独运行：

```bash
npm run dev:server   # 仅后端
npm run dev:web      # 仅前端（Vite 已配置 /api 代理）
npm test             # 单元测试
npm run test:coverage
npm run lint         # ESLint
npm run build        # 生产构建
```

---

## 技术栈

| 层       | 选型                                    | 说明                                  |
| -------- | --------------------------------------- | ------------------------------------- |
| 前端     | 原生 ES Module + Vite                   | 不引入框架，聚焦搜索链路本身的实现    |
| 后端     | Node.js 原生 `http`                     | 零框架依赖，可读性与可讲解性优先      |
| 数据库   | SQLite（`node:sqlite`）                 | Node 22 内置，无需安装数据库服务      |
| 全文检索 | FTS5 `trigram` + 二元组倒排表           | 中文子串检索的双索引方案              |
| 测试     | Vitest + v8 coverage                    | 27 个用例，核心模块覆盖率 89%         |
| 规范     | ESLint + Prettier + Husky + lint-staged | 提交前自动检查                        |
| CI       | GitHub Actions                          | lint / format / test / build 四道关卡 |

---

## 核心：搜索链路的三层设计

搜索框最容易出问题的地方，不是「怎么把结果显示出来」，而是**连续输入时旧响应覆盖新响应**。

```
用户输入 a    →  立刻改成 ab
                 ├─ 请求 A 发出（慢）
                 └─ 请求 B 发出（快）
                      ↓
                 响应 B 先回来 → 界面显示 ab ✓
                 响应 A 后回来 → 界面被覆盖回 a ✗
```

解决办法分三层，各司其职：

### 1. 输入层：防抖（debounce）

连续输入在 300ms 窗口内只发最后一次请求。

```js
const debouncedSearch = debounce(() => this.#execute(), 300);
```

**为什么不是节流？** 防抖与节流的适用场景是相反的：

- **防抖** —— 等用户停下来再做。适用于搜索输入、表单校验、窗口 resize。
- **节流** —— 每段时间最多做一次。适用于滚动加载、鼠标移动、埋点上报。

节流套在搜索框上会在用户仍在打字时就发请求，既浪费请求又可能拿到旧结果。本项目中节流用在了**滚动加载更多**上——这才是它的正确位置。

### 2. 请求层：AbortController

新请求发出时主动取消上一个在途请求，浏览器直接丢弃旧响应，不占用带宽。

```js
const { signal, seq } = this.#sequencer.start(); // start() 内部会 abort 上一个
```

### 3. 渲染层：请求序号

即使 abort 失败（比如响应已经到达、无法再取消），响应回来时比对序号，非最新直接丢弃。这是兜底防线。

```js
if (!this.#sequencer.isCurrent(seq)) return; // 序号不符 → 绝不渲染
```

三层缺一不可：只有防抖会漏掉乱序响应，只有 abort 在服务端已返回时失效，只有序号则浪费了已取消的请求。

---

## 中文检索：为什么需要两套索引

这是本项目踩过最深的坑，也是中文搜索与英文搜索的本质差异。

### unicode61 分词器（默认）——不能用

FTS5 默认的 `unicode61` 按「词」切分。中文没有空格，整句会被当成一个词：

```sql
-- 商品名是「降噪蓝牙耳机」，搜索「蓝牙」
SELECT * FROM product_fts WHERE product_fts MATCH '蓝牙';  -- → 查不到
```

### trigram 分词器 —— 能用，但有长度限制

`trigram` 按三字符切分，支持子串匹配。但它要求关键词**至少 3 个字符**：

```sql
SELECT * FROM product_fts WHERE product_fts MATCH '蓝牙耳机';  -- → 命中 ✓
SELECT * FROM product_fts WHERE product_fts MATCH '蓝牙';     -- → 查不到 ✗
```

而「蓝牙」「耳机」「台灯」「咖啡」这类两字词，在中文电商里占比极高。

### 最终方案：按关键词长度自动路由

| 关键词长度 | 走哪条路              | 实现                                 |
| ---------- | --------------------- | ------------------------------------ |
| ≥ 3 字符   | FTS5 trigram 全文索引 | `product_fts` 虚拟表                 |
| ≤ 2 字符   | 二元组倒排表          | `product_bigram(bigram, product_id)` |

构建时把每个商品的「名称 + 品牌 + 标签」切成所有相邻二字组合写入倒排表，共 24 万条。查询时按长度自动选择，用户无需感知。

### 实测对比（1 万条商品）

| 查询方式         | 耗时        | 说明                            |
| ---------------- | ----------- | ------------------------------- |
| `LIKE '%蓝牙%'`  | 2.11 ms     | 全表扫描，无法走索引            |
| 二元组倒排索引   | **0.18 ms** | `SEARCH b USING COVERING INDEX` |
| trigram 全文索引 | 0.66 ms     | `SCAN f VIRTUAL TABLE INDEX`    |

倒排索引比全表扫描快 **11.7 倍**。执行计划可验证索引确实生效：

```
SEARCH b USING COVERING INDEX sqlite_autoindex_product_bigram_1 (bigram=?)
SEARCH p USING INTEGER PRIMARY KEY (rowid=?)
```

---

## 工程化细节

### 服务端

- **参数白名单化**：`sort` 只接受枚举值，`pageSize` 限制在 1–100，防止非法值进入 SQL 层
- **LRU 缓存**：200 条容量、30s TTL，命中缓存与未命中时返回结构完全一致
- **滑动窗口限流**：单 IP 10 秒内最多 120 次请求
- **慢查询日志**：超过 50ms 的查询落库，用于持续观察索引效果
- **参数化查询**：全程使用 `?` 占位符，无字符串拼接
- **优雅关闭**：SIGINT/SIGTERM 时关闭连接

### 前端

- **骨架屏**：loading 态用骨架屏而非转圈，感知更快
- **批量渲染**：用 `DocumentFragment` 一次性插入，避免逐条 append 触发多次重排
- **XSS 防护**：用户输入先转义再插入 DOM，关键词高亮顺序不可颠倒
- **无障碍**：`aria-live` 播报结果数、`aria-busy` 标记加载态、键盘上下键与 Enter/Esc 支持、焦点可见、`prefers-reduced-motion` 降级
- **响应式**：4 档断点（980 / 680 / 380 px），移动端搜索框独占一行
- **资源清理**：`destroy()` 取消防抖定时器、中止在途请求、移除事件监听

---

## 测试

```bash
npm run test:coverage
```

```
 Test Files  2 passed (2)
      Tests  27 passed (27)

 % Coverage report from v8
-------------------|---------|----------|---------|---------|
File               | % Stmts | % Branch | % Funcs | % Lines |
-------------------|---------|----------|---------|---------|
All files          |   89.13 |    89.23 |      90 |   89.13 |
 performance.js    |   96.31 |    94.28 |   88.23 |   96.31 |
 search-controller |   81.46 |    83.33 |    92.3 |   81.46 |
```

覆盖重点是「容易出错且肉眼难验证」的部分：

- 乱序响应下旧数据不覆盖新数据（竞态）
- 连续输入只发一次请求（防抖）
- leading / trailing 两种模式的边界行为
- cancel / flush 的语义
- 取消请求不触发错误提示
- 加载更多是追加而非替换

CI 配置了覆盖率阈值（语句 85% / 函数 85% / 分支 80%），不达标流水线直接失败——阈值设了不检查等于没设。

---

## 接口

| 方法 | 路径                         | 说明                                                         |
| ---- | ---------------------------- | ------------------------------------------------------------ |
| GET  | `/api/products`              | 搜索商品，支持 `keyword` `category` `sort` `page` `pageSize` |
| GET  | `/api/products/stats`        | 分类统计                                                     |
| GET  | `/api/products/slow-queries` | 慢查询日志                                                   |
| GET  | `/api/health`                | 健康检查                                                     |

响应示例：

```json
{
  "ok": true,
  "data": {
    "items": [{ "id": 3451, "name": "降噪蓝牙耳机 146代", "price": 4669.9 }],
    "total": 200,
    "page": 1,
    "pageSize": 20,
    "totalPages": 10,
    "costMs": 0.46
  },
  "meta": { "cached": false, "cacheSize": 0 }
}
```

---

## 目录结构

```
├── src/
│   ├── core/
│   │   ├── performance.js       # debounce / throttle / RequestSequencer
│   │   └── search-controller.js # 搜索链路控制器
│   ├── api/products.js          # 接口封装
│   ├── components/search-page.js# 渲染层
│   ├── styles/main.css
│   └── main.js
├── server/
│   ├── index.js                 # HTTP 服务
│   └── db.js                    # 数据层与索引
├── tests/                       # 单元测试
└── .github/workflows/ci.yml
```

---

## 可以继续做的

- [ ] 接入 MySQL，替换 SQLite（当前 `node:sqlite` 为实验特性）
- [ ] 搜索建议（输入前缀联想）
- [ ] Elasticsearch 中文分词（`ik_smart`），支持拼音与纠错
- [ ] 虚拟滚动，支撑万级结果列表
- [ ] 前端虚拟列表 + 无限滚动的性能对比数据
