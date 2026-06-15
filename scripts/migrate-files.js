#!/usr/bin/env node
// 扫描磁盘文件，补录到数据库
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'data', 'pages.db');
const STORAGE_BASE = path.join(__dirname, '..', 'storage');

const db = new sqlite3.Database(DB_PATH);

// 获取所有租户
db.all('SELECT tenant_id, storage_path FROM tenants', [], (err, tenants) => {
  if (err) {
    console.error('❌ 查询租户失败:', err.message);
    process.exit(1);
  }
  
  let totalScanned = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  
  tenants.forEach(tenant => {
    // 处理相对路径
    let storagePath = tenant.storage_path;
    if (!path.isAbsolute(storagePath)) {
      storagePath = path.resolve(path.join(__dirname, '..', storagePath));
    }
    
    if (!fs.existsSync(storagePath)) {
      console.log(`⏭️  租户 ${tenant.tenant_id} 存储目录不存在: ${storagePath}`);
      return;
    }
    
    const files = fs.readdirSync(storagePath)
      .filter(f => /\.(html|htm)$/i.test(f));
    
    console.log(`\n📂 租户 ${tenant.tenant_id}: ${files.length} 个HTML文件`);
    
    files.forEach(filename => {
      totalScanned++;
      
      // 计算 display_name：去掉时间戳前缀
      const displayName = filename.replace(/^\d+-upload-/, '').replace(/^\d+-/, '');
      
      db.run(
        'INSERT OR IGNORE INTO page_display_names (tenant_id, filename, display_name) VALUES (?, ?, ?)',
        [tenant.tenant_id, filename, displayName],
        function(err) {
          if (err) {
            console.error(`❌ 插入失败: ${tenant.tenant_id}/${filename}:`, err.message);
          } else if (this.changes > 0) {
            totalInserted++;
          } else {
            totalSkipped++;
          }
        }
      );
    });
  });
  
  // 所有异步插入完成后输出统计
  setTimeout(() => {
    db.all('SELECT COUNT(*) as cnt FROM page_display_names', [], (err, row) => {
      console.log('\n========== 补录完成 ==========');
      console.log(`扫描文件: ${totalScanned}`);
      console.log(`新增记录: ${totalInserted}`);
      console.log(`跳过已存在: ${totalSkipped}`);
      console.log(`DB 总记录数: ${row.cnt}`);
      console.log('==============================');
      db.close();
      process.exit(0);
    });
  }, 2000);
});
