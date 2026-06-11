const { rmSync, cpSync } = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '../dashboard/dist');
const publicDir = path.resolve(__dirname, '../public');

try {
  // 1. 清理旧的 public 目录
  console.log('🧹 清理旧的静态文件...');
  rmSync(publicDir, { recursive: true, force: true });

  // 2. 复制新的构建产物
  console.log('📦 复制构建产物...');
  cpSync(distDir, publicDir, { recursive: true });

  console.log('✨ Dashboard 部署准备就绪！');
} catch (err) {
  console.error('❌ 复制失败:', err.message);
  process.exit(1);
}