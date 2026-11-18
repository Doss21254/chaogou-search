import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    // 开发环境把 /api 代理到 Node 服务，前端代码里用相对路径，生产同源部署
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    // 产物拆包：业务代码与样式分离，便于 CDN 分发与长期缓存
    // （vite/client 是虚拟模块，不能作为 manualChunks 的入口）
    rollupOptions: {
      output: {
        manualChunks: {
          styles: ['./src/styles/main.css'],
        },
      },
    },
    // gzip 后的真实体积，用于观察构建优化效果
    reportCompressedSize: true,
    chunkSizeWarningLimit: 300,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**/*.js'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
