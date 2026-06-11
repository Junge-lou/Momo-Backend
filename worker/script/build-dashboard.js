const { execSync } = require('child_process');
const { rmSync, cpSync } = require('fs');
const path = require('path');

try {
  // 1. 进入 dashboard 目录并执行打包
  console.log('🚀 开始打包 dashboard...');
  execSync('pnpm build', { 
    cwd: path.resolve(__dirname, '../dashboard'), 
    stdio: 'inherit',
    shell: true
  });

  // 2. 定义路径
  const targetDir = path.resolve(__dirname, '../worker/public');
  const sourceDir = path.resolve(__dirname, '../dashboard/dist');

  // 3. 清理旧的静态文件
  console.log('🧹 正在清理旧的静态文件...');
  rmSync(targetDir, { recursive: true, force: true });

  // 4. 复制新文件
  console.log('📦 正在复制新的构建产物...');
  cpSync(sourceDir, targetDir, { recursive: true });

  console.log('✨ Dashboard 部署准备就绪！');
} catch (error) {
  console.error('❌ 执行过程中出错:', error.message);
  process.exit(1);
}