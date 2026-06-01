#!/usr/bin/env node
/**
 * 设置表名迁移脚本
 *
 * 版本: v1.3.7
 * 目的: 确保数据库中的 Settings 表名在所有后端版本中一致
 *
 * 使用方法:
 *   node scripts/migrate-settings-table.js [--dry-run]
 *
 *   参数:
 *     --dry-run  仅检查，不执行修改
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// 数据库路径解析
const DATABASE_URL = process.env.DATABASE_URL || "file:./data/dev.db";
let dbPath = DATABASE_URL.replace(/^file:/, "");
if (!path.isAbsolute(dbPath)) {
  dbPath = path.resolve(process.cwd(), dbPath);
}

const dryRun = process.argv.includes("--dry-run");

console.log("=".repeat(60));
console.log("  Settings 表名一致性检查工具");
console.log("=".repeat(60));
console.log(`  数据库路径: ${dbPath}`);
console.log(`  模式: ${dryRun ? "仅检查（--dry-run）" : "自动修复"}`);
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("  ❌ 数据库文件不存在:", dbPath);
  process.exit(1);
}

const db = new Database(dbPath);

try {
  // 获取所有表
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

  console.log("  当前数据库中的表:");
  tables.forEach((t) => console.log(`    - ${t}`));
  console.log("");

  const hasSettings = tables.includes("Settings");
  const hasSetting = tables.includes("Setting");

  if (hasSettings && !hasSetting) {
    console.log("  ✅ Settings 表已存在且命名正确，无需迁移。");
  } else if (hasSetting && !hasSettings) {
    console.log("  ⚠️  发现旧表名 'Setting'（单数），需要重命名为 'Settings'（复数）");
    console.log("");

    if (!dryRun) {
      // 执行重命名
      db.exec("ALTER TABLE \"Setting\" RENAME TO \"Settings\";");
      console.log("  ✅ 已将 'Setting' 重命名为 'Settings'");
    } else {
      console.log("  🔍 未执行修改（--dry-run 模式）");
    }
  } else if (hasSetting && hasSettings) {
    console.log("  ⚠️  同时存在 'Setting' 和 'Settings' 表！");
    console.log("");

    // 检查数据量
    const settingCount = db.prepare("SELECT COUNT(*) as c FROM \"Setting\"").get().c;
    const settingsCount = db.prepare("SELECT COUNT(*) as c FROM \"Settings\"").get().c;

    console.log(`    'Setting'  表中的记录数: ${settingCount}`);
    console.log(`    'Settings' 表中的记录数: ${settingsCount}`);

    if (settingsCount > 0 && settingCount === 0) {
      if (!dryRun) {
        db.exec("DROP TABLE \"Setting\";");
        console.log("  ✅ 已删除空的 'Setting' 表，保留 'Settings'");
      } else {
        console.log("  🔍 建议：删空 'Setting' 表，保留 'Settings'");
      }
    } else if (settingCount > 0 && settingsCount === 0) {
      if (!dryRun) {
        db.exec("DROP TABLE \"Settings\";");
        db.exec("ALTER TABLE \"Setting\" RENAME TO \"Settings\";");
        console.log("  ✅ 已删除空 'Settings' 表，并将 'Setting' 重命名为 'Settings'");
      } else {
        console.log("  🔍 建议：删空 'Settings' 表，将 'Setting' 重命名为 'Settings'");
      }
    } else if (settingCount > 0 && settingsCount > 0) {
      console.log("  ❌ 两个表中都有数据！需要手动处理。");
      console.log("     建议操作:");
      console.log("     1. 备份数据库");
      console.log('     2. 将 "Setting" 表的数据合并到 "Settings"');
      console.log('     3. 删除 "Setting" 表');
    } else {
      // 都为空
      if (!dryRun) {
        db.exec("DROP TABLE IF EXISTS \"Setting\";");
        db.exec("DROP TABLE IF EXISTS \"Settings\";");
        console.log("  ✅ 两个空表已删除，应用启动时会自动创建新表");
      } else {
        console.log("  🔍 两个表都为空，建议全部删除");
      }
    }
  } else {
    console.log("  ℹ️  未找到 Settings 或 Setting 表，应用启动时会自动创建。");
  }

  // 检查 Comment 表是否存在
  const hasComment = tables.includes("Comment");
  if (!hasComment) {
    console.log("  ℹ️  未找到 Comment 表，应用启动时会自动创建。");
  } else {
    console.log("  ✅ Comment 表已存在。");
  }
} catch (err) {
  console.error("  ❌ 执行出错:", err.message);
  process.exit(1);
} finally {
  db.close();
}

console.log("");
console.log("=".repeat(60));
console.log("  检查完成！");
if (!dryRun) {
  console.log("  请重启应用以应用更改。");
}
