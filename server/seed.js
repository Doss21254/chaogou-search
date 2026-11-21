/**
 * 种子数据脚本：往 MySQL 里灌入 1 万条商品数据。
 *
 * 用法：node server/seed.js
 *
 * 为什么要单独一个脚本？
 *   开发时需要测试数据来验证搜索效果。
 *   把「造数据」和「跑服务」分开，职责清晰，也方便随时重建数据。
 */

import 'dotenv/config'; // 自动读取 .env 文件里的环境变量
import mysql from 'mysql2/promise'; // mysql2 的 Promise 版本，可以用 async/await

// -------------------------------------------------------
// 商品名称池：每个分类 10 个基础名称，灌数据时循环使用
// -------------------------------------------------------
const NAMES = {
  fashion: ['轻薄连帽外套', '夏季时尚短裙', '宽松阔腿裤', '纯棉圆领T恤', '防风冲锋衣', '真皮短靴', '羊毛混纺大衣', '亚麻衬衫', '运动束脚裤', '针织开衫'],
  digital: ['降噪蓝牙耳机', '无线充电底座', '机械键盘', '高刷电竞显示器', '便携移动电源', '智能手表', 'USB-C扩展坞', '降噪头戴耳机', '桌面路由器', '固态移动硬盘'],
  home: ['智能护眼台灯', '记忆棉枕头', '全棉四件套', '静音落地扇', '香薰加湿器', '免安装收纳柜', '多层鞋架', '厨房沥水篮', '实木餐桌椅', '遮光窗帘'],
  food: ['手冲咖啡豆', '低脂鸡胸肉', '云南野生菌菇', '冷萃茶包', '坚果大礼包', '手工黑巧克力', '即食燕麦片', '古法红糖', '深海鳕鱼块', '气泡水'],
  sports: ['专业跑步鞋', '碳纤维登山杖', '加厚瑜伽垫', '速干运动T恤', '折叠健身车', '登山背包', '泳镜防雾套装', '筋膜枪', '羽毛球拍', '露营帐篷'],
};

const BRANDS = ['星辰', '拓野', '云鲸', '极光', '远山', '轻舟', '松野', '海风', '木白', '岩灰'];
const CATEGORIES = Object.keys(NAMES);

// 每个分类灌 2000 条，共 1 万条
const COUNT_PER_CATEGORY = 2000;

async function main() {
  // 创建连接（不用连接池，因为灌数据是一次性任务，用完就关）
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  console.log('开始灌入种子数据...');

  // 先清空旧数据（开发阶段方便重跑）
  await conn.execute('DELETE FROM products');

  // 准备插入语句
  // 注意：用的是 ? 占位符，不是字符串拼接——这是防 SQL 注入的标准做法
  // 即使 name 里有引号或特殊字符也不会出问题
  const sql = `
    INSERT INTO products (name, category, brand, price, sales, rating, stock, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  let total = 0;

  for (const category of CATEGORIES) {
    const pool = NAMES[category]; // 该分类的名称池

    for (let i = 0; i < COUNT_PER_CATEGORY; i++) {
      // 第几轮循环就加「N代」后缀，制造不同的商品名
      const base = pool[i % pool.length];
      const suffix = i < pool.length ? '' : ` ${Math.floor(i / pool.length) + 1}代`;
      const name = `${base}${suffix}`;

      // 用简单的数学制造有差异但不随机的数据
      const brand = BRANDS[(i * 7) % BRANDS.length];
      const price = Math.round((19 + ((i * 37) % 9800)) / 10) * 10 - 0.1;
      const sales = (i * 131) % 9999;
      const rating = Math.round((3.5 + ((i * 13) % 15) / 10) * 10) / 10;
      const stock = (i * 17) % 500;
      const tags = `${brand} ${category} 热销 正品 顺丰包邮`;

      await conn.execute(sql, [name, category, brand, price, sales, rating, stock, tags]);
      total++;

      // 每灌 1000 条打印一次进度
      if (total % 1000 === 0) {
        console.log(`  已灌入 ${total} 条...`);
      }
    }
  }

  console.log(`完成！共灌入 ${total} 条商品`);

  // 验证一下
  const [rows] = await conn.execute('SELECT COUNT(*) AS total FROM products');
  console.log(`数据库现有 ${rows[0].total} 条商品`);

  // 按分类统计
  const [cats] = await conn.execute(
    'SELECT category, COUNT(*) AS count FROM products GROUP BY category'
  );
  for (const row of cats) {
    console.log(`  ${row.category}: ${row.count} 条`);
  }

  await conn.end();
}

main().catch((err) => {
  console.error('灌入失败：', err.message);
  process.exit(1);
});
