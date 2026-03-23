const fs = require('fs');
const path = require('path');

/**
 * v1.8.0 → v1.9.0: Proactive learning tracking
 * - In-session AI now recognizes seed-worthy topics from conversation signals
 *   (consecutive questions, shared links, recurring topics, "why" questions, etc.)
 *   and adds them to SEEDS.md without user needing to use any keywords
 * - seed-watering job gains Path 0: self-bootstraps SEEDS.md when no nodes exist
 * - CLAUDE.md updated with 主動學習追蹤 section
 */
module.exports = async function migrate(ctx) {
  const { wsId, wsDir, templateDir, log, notifyAllBindings } = ctx;

  // 1. Push updated CLAUDE.md via .new mechanism
  const claudeMdPath = path.join(wsDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');

    if (!existing.includes('主動學習追蹤')) {
      const newContent = fs.readFileSync(path.join(templateDir, 'CLAUDE.md'), 'utf-8');
      fs.writeFileSync(path.join(wsDir, 'CLAUDE.md.new'), newContent);

      const notice =
        '> **⚠️ 系統升級通知 v1.9.0：** 新增主動學習追蹤功能！' +
        '有新版操作手冊 `CLAUDE.md.new`，請讀取它，' +
        '將「主動學習追蹤」段落整合到這份文件中。系統會自動清理 `.new` 檔案。\n\n';

      if (!existing.includes('CLAUDE.md.new')) {
        fs.writeFileSync(claudeMdPath, notice + existing);
      }
      log.info(`Workspace ${wsId}: CLAUDE.md.new written (v1.9.0 proactive learning)`);
    }
  }

  // 2. Notify user
  await notifyAllBindings(
    '從現在起，我會開始主動記住你在意的事。\n\n' +
    '當你在聊天中對某個話題連續追問、分享了什麼連結、或者話題一直繞回來——' +
    '我會悄悄記下來，之後主動深入研究，有新發現再告訴你。'
  );

  log.info(`Workspace ${wsId}: v1.9.0 proactive learning notification sent`);
};
