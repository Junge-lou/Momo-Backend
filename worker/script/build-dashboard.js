// Cloudflare Workers Builds 的构建环境没有 /bin/sh，execSync/exec 的命令行
// 会以 ENOENT 失败：这里 pnpm 用 spawnSync 直接执行（不经 shell），
// 复制产物只用 node:fs，不依赖任何系统命令。
const { spawnSync } = require('child_process');
const { rmSync, cpSync, existsSync } = require('fs');
const path = require('path');

try {
  // 0. 路径：本脚本位于 worker/script/，dashboard 与 worker 同级
  const dashboardDir = path.resolve(__dirname, '../../dashboard');
  const sourceDir = path.join(dashboardDir, 'dist');
  const targetDir = path.resolve(__dirname, '../public');

  // 1. 打包 dashboard。优先直接用当前 Node 进程跑 vite 的 JS 入口：
  //    完全不经 shell（CF 构建环境没有 /bin/sh），也没有 pnpm.cmd 的平台差异
  //    （Windows 上 Node 出于安全不允许无 shell 直接 spawn .cmd，会报 EINVAL）。
  console.log('🚀 开始打包 dashboard...');
  const viteBin = path.join(dashboardDir, 'node_modules', 'vite', 'bin', 'vite.js');
  let build;
  if (existsSync(viteBin)) {
    build = spawnSync(process.execPath, [viteBin, 'build'], { cwd: dashboardDir, stdio: 'inherit' });
  } else {
    // 兜底：走 pnpm（Windows 下需显式开 shell 才能执行 .cmd）
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    build = spawnSync(pnpm, ['build'], { cwd: dashboardDir, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`dashboard 构建失败（退出码 ${build.status}）`);
  if (!existsSync(sourceDir)) {
    throw new Error(`未找到构建产物目录: ${sourceDir}`);
  }

  // 2. 清理旧的静态文件
  console.log('🧹 正在清理旧的静态文件...');
  rmSync(targetDir, { recursive: true, force: true });

  // 3. 复制新文件
  console.log('📦 正在复制新的构建产物...');
  cpSync(sourceDir, targetDir, { recursive: true });

  console.log('✨ Dashboard 部署准备就绪！');
} catch (error) {
  console.error('❌ 执行过程中出错:', error.message);
  process.exit(1);
}
