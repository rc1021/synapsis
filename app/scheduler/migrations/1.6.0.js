const fs = require('fs');
const path = require('path');

/**
 * v1.5.0 → v1.6.0: Per-workspace cron job improvements
 * - notify field documentation in CLAUDE.md
 * - once:true auto-disable support
 * - Add default notify to existing jobs.json entries that lack it
 */
module.exports = async function migrate(ctx) {
  const { wsId, wsDir, templateDir, log } = ctx;

  // 1. Update CLAUDE.md with jobs.json documentation
  const claudeMdPath = path.join(wsDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');

    if (!existing.includes('notify')) {
      const newContent = fs.readFileSync(path.join(templateDir, 'CLAUDE.md'), 'utf-8');
      fs.writeFileSync(path.join(wsDir, 'CLAUDE.md.new'), newContent);

      const notice = '> **⚠️ 系統升級通知 v1.6.0：** 排程提醒功能改善！新增 `notify` 和 `once` 欄位支援。有新版操作手冊 `CLAUDE.md.new`，請讀取它，將有用的新段落整合到這份文件中。系統會自動清理 `.new` 檔案。\n\n';
      if (!existing.includes('CLAUDE.md.new')) {
        fs.writeFileSync(claudeMdPath, notice + existing);
      }
      log.info(`Workspace ${wsId}: CLAUDE.md.new written (v1.6.0 jobs notify/once)`);
    }
  }

  // 2. Add notify to existing jobs.json entries that lack it
  const jobsPath = path.join(wsDir, 'jobs.json');
  if (fs.existsSync(jobsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
      let changed = false;

      for (const job of (data.jobs || [])) {
        if (!job.notify) {
          job.notify = { when: 'always' };
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(jobsPath, JSON.stringify(data, null, 2));
        log.info(`Workspace ${wsId}: jobs.json updated with default notify (v1.6.0)`);
      }
    } catch (err) {
      log.warn(`Workspace ${wsId}: failed to update jobs.json: ${err.message}`);
    }
  }
};
