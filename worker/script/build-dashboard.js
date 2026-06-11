const { execFileSync } = require('child_process');
const { rmSync, cpSync } = require('fs');
const path = require('path');

const dashboardDir = path.resolve(__dirname, '../dashboard');
const distDir = path.resolve(__dirname, '../dashboard/dist');
const publicDir = path.resolve(__dirname, '../public');

try {
  // 1. 安装 dashboard 依赖并构建
  console.log('🚀 开始打包 dashboard...');
  execFileSync('pnpm', ['install'], { cwd: dashboardDir, stdio: 'inherit' });
  execFileSync('pnpm', ['build'], { cwd: dashboardDir, stdio: 'inherit' });

  // 2. 清理旧的 public 目录
  console.log('🧹 清理旧的静态文件...');
  rmSync(publicDir, { recursive: true, force: true });

  // 3. 复制新文件
  console.log('📦 复制新的构建产物...');
  cpSync(distDir, publicDir, { recursive: true });

  console.log('✨ Dashboard 部署准备就绪！');
} catch (err) {
  console.error('❌ 构建失败:', err.message);
  process.exit(1);
}