# 潮购商城 · 商品搜索

一个把「搜索框」做透的前端工程项目：Node 服务端 + MySQL 全文索引 + 前端防抖与请求竞态处理。

重点不在界面，而在**搜索链路**——从输入到渲染之间每一个可能出问题的地方，都被显式处理并有测试覆盖。

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 复制环境配置，填入你的 MySQL 密码
cp .env.example .env
# 然后编辑 .env，把 DB_PASSWORD 改成你的数据库密码

# 3. 建库建表 + 灌入 1 万条测试数据
npm run db:setup

# 4. 启动开发服务（前后端同时跑）
npm run dev
```

- 前端：http://localhost:5173
- 后端：http://127.0.0.1:3001

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

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端 | 原生 ES Module + Vite | 不引入框架，聚焦搜索链路本身的实现 |
| 后端 | Node.js 原生 `http` | 零框架依赖，可读性与可讲解性优先 |
| 数据库 | MySQL 9.x + `mysql2` 连接池 | 生产级数据库，简历技术栈一致 |
| 全文检索 | MySQL `FULLTEXT INDEX` + `ngram` 分词器 | 原生支持中文子串检索，一个索引搞定 |
| 测试 | Vitest + v8 coverage | 27 个用例，核心模块覆盖率 89% |
| 规范 | ESLint + Prettier + Husky + lint-staged | 提交前自动检查 |
| CI | GitHub Actions | lint / format / test / build 四道关卡 |

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

## 中文检索：MySQL ngram 全文索引

### 为什么不用 LIKE '%关键词%'

`LIKE` 前面带 `%` 无法走索引，1 万条数据要扫 1 万行，百万级会卡到几秒。

### 为什么用 ngram 分词器

MySQL 默认的全文索引按空格分词，中文没空格所以用不了。`ngram` 把中文按固定长度（默认 2 字）切成小块，「降噪蓝牙耳机」会被切成「降噪 降蓝 蓝牙 蓝牙 牙耳 耳机」，搜索「蓝牙」就能命中。

一个 `FULLTEXT INDEX` 就搞定 2 字词和长词，不需要按词长分流。

### 实测对比（1 万条商品，各跑 100 次取平均）

| 查询方式 | 平均耗时 | 说明 |
| --- | --- | --- |
| `LIKE '%蓝牙%'` | 2.60 ms | 全表扫描，扫描 9786 行 |
| `FULLTEXT + ngram` | **0.99 ms** | 全文索引搜索，只扫匹配行 |

执行计划验证索引确实生效：

```
FULLTEXT:  Full-text index search on products using ft_products_search (cost=0.35 rows=1)
LIKE:      Table scan on products (cost=1003 rows=9786)
```

数据量越大差距越明显：LIKE 是线性增长（扫全部行），FULLTEXT 是对数级（只扫匹配的行）。

---

## 工程化细节

### 服务端

- **连接池**：`mysql2` 连接池，最多 10 个连接复用，避免频繁建连
- **参数白名单化**：`sort` 只接受枚举值，`pageSize` 限制在 1–100，防止非法值进入 SQL 层
- **LRU 缓存**：200 条容量、30s TTL，命中缓存与未命中时返回结构完全一致
- **滑动窗口限流**：单 IP 10 秒内最多 120 次请求
- **慢查询日志**：超过 50ms 的查询落库，用于持续观察索引效果
- **参数化查询**：全程使用 `?` 占位符，无字符串拼接（防 SQL 注入）
- **优雅关闭**：SIGINT/SIGTERM 时先关 HTTP 服务再关连接池

### 前端

- **骨架屏**：loading 态用骨架屏而非转圈，感知更快
- **批量渲染**：用 `DocumentFragment` 一次性插入，避免逐条 append 触发多次重排
- **XSS 防护**：用户输入先转义再插入 DOM，关键词高亮顺序不可颠倒
- **无障碍**：`aria-live` 播报结果数、`aria-busy` 标记加载态、键盘 Enter/Esc 支持、焦点可见、`prefers-reduced-motion` 降级
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

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/products` | 搜索商品，支持 `keyword` `category` `sort` `page` `pageSize` |
| GET | `/api/products/stats` | 分类统计 |
| GET | `/api/products/slow-queries` | 慢查询日志 |
| GET | `/api/health` | 健康检查 |

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
    "costMs": 5.14
  },
  "meta": { "cached": false, "cacheSize": 0 }
}
```

---

## 目录结构

```
├── src/
│   ├── core/
│   │   ├── performance.js        # debounce / throttle / RequestSequencer
│   │   └── search-controller.js  # 搜索链路控制器
│   ├── api/products.js           # 接口封装
│   ├── components/search-page.js # 渲染层
│   ├── styles/main.css
│   └── main.js
├── server/
│   ├── index.js                  # HTTP 服务
│   ├── db.js                     # 数据层（MySQL 连接池 + 搜索查询）
│   ├── seed.js                   # 种子数据脚本（灌入 1 万条商品）
│   └── schema.sql                # 建库建表 SQL
├── tests/                        # 单元测试
├── .env                          # 数据库密码（不入 git）
├── .env.example                  # 密码模板（入 git）
└── .github/workflows/ci.yml
```

---

## 可以继续做的

- [ ] 搜索建议（输入前缀联想）
- [ ] Elasticsearch 中文分词（`ik_smart`），支持拼音与纠错
- [ ] 虚拟滚动，支撑万级结果列表
- [ ] 前端虚拟列表 + 无限滚动的性能对比数据
