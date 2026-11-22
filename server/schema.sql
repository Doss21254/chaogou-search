-- ============================================================
-- 潮购商城 · 建库建表脚本
--
-- ⚠️  警告：本脚本会先 DROP DATABASE 再重建！
--    会删除 chaogou_mall 库里的所有数据，不可恢复。
--    仅用于开发环境初始化，不要在生产环境运行。
--
-- 用法（推荐用 npm run db:setup，自动读取 .env 凭据）：
--   npm run db:setup
--
-- 手动执行（需要自己填密码）：
--   mysql -u你的用户名 -p < server/schema.sql
-- ============================================================

-- 删除旧库重建（开发阶段方便重跑，生产环境去掉这两行）
DROP DATABASE IF EXISTS chaogou_mall;
CREATE DATABASE chaogou_mall
  DEFAULT CHARACTER SET utf8mb4        -- utf8mb4 才能存 emoji 和生僻字，utf8 不行
  DEFAULT COLLATE utf8mb4_unicode_ci;  -- 排序规则：中文按拼音排序

USE chaogou_mall;

-- ------------------------------------------------------------
-- 商品主表
-- 每一行代表一件商品
-- ------------------------------------------------------------
CREATE TABLE products (
  id          INT AUTO_INCREMENT PRIMARY KEY,  -- 自增主键
  name        VARCHAR(100) NOT NULL,            -- 商品名称，如「降噪蓝牙耳机」
  category    VARCHAR(20)  NOT NULL,            -- 分类代号：fashion / digital / home / food / sports
  brand       VARCHAR(20)  NOT NULL DEFAULT '', -- 品牌
  price       DECIMAL(10,2) NOT NULL,           -- 价格，DECIMAL 比 FLOAT 精确，钱不能用浮点
  sales       INT          NOT NULL DEFAULT 0,  -- 销量，用于排序
  rating      DECIMAL(2,1) NOT NULL DEFAULT 4.5,-- 评分 0.0 ~ 5.0
  stock       INT          NOT NULL DEFAULT 0,  -- 库存
  tags        VARCHAR(200) NOT NULL DEFAULT '', -- 标签，空格分隔，如「星辰 热销 正品」
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 普通索引：加速「按分类过滤 + 按销量排序」
--
-- 为什么要建索引？
--   没有索引时，按 category 过滤要把整张表从头扫到尾（全表扫描）。
--   建了索引后，数据库能直接定位到对应分类的那几行，快很多。
--
-- 为什么是 (category, sales) 组合索引而不是两个单列索引？
--   因为查询总是「WHERE category=? ORDER BY sales DESC」，
--   组合索引先按 category 聚拢，再按 sales 排好序，
--   过滤和排序一步完成，不用额外的排序步骤（filesort）。
-- ------------------------------------------------------------
CREATE INDEX idx_products_category_sales
  ON products(category, sales DESC);

-- ------------------------------------------------------------
-- 全文索引：加速「关键词搜索」
--
-- 为什么不用 LIKE '%关键词%'？
--   LIKE 前面带 % 无法走索引，1 万条数据就要扫 1 万行，
--   数据量到百万级时会卡到几秒。
--
-- 为什么用 ngram 分词器？
--   MySQL 默认的全文索引按空格分词，中文没空格所以用不了。
--   ngram 把中文按固定长度切成小块（默认 2 字），
--   「降噪蓝牙耳机」会被切成「降噪 降蓝 蓝牙 蓝牙 牙耳 耳机」，
--   搜索「蓝牙」时就能命中。
--
--   这比 SQLite 那套「trigram + 二元组倒排表双索引」简单得多——
--   一个 FULLTEXT 索引就搞定 2 字词和长词，不用按词长分流。
-- ------------------------------------------------------------
CREATE FULLTEXT INDEX ft_products_search
  ON products(name, brand, tags)
  WITH PARSER ngram;

-- ------------------------------------------------------------
-- 慢查询日志表：记录耗时超过 50ms 的搜索
-- 用来持续观察哪些查询需要优化
-- ------------------------------------------------------------
CREATE TABLE search_log (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  keyword     VARCHAR(64)  NOT NULL,
  category    VARCHAR(20)  DEFAULT NULL,
  hit_count   INT          NOT NULL,
  cost_ms     DECIMAL(8,2) NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_search_log_created (created_at DESC)
);
