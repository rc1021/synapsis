const fs = require('fs');
const path = require('path');

/**
 * v1.7.0 → v1.8.0: Per-workspace semantic search
 * - New /search slash command for direct memory search
 * - AI can use mcp__memory__memory_search tool autonomously
 * - CLAUDE.md updated with memory search instructions
 * - Notify users of new capability
 */
module.exports = async function migrate(ctx) {
  const { wsId, wsDir, templateDir, log, notifyAllBindings } = ctx;

  // 1. Update CLAUDE.md with memory search section (via .new mechanism)
  const claudeMdPath = path.join(wsDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');

    if (!existing.includes('memory_search') && !existing.includes('mcp__memory')) {
      const newContent = fs.readFileSync(path.join(templateDir, 'CLAUDE.md'), 'utf-8');
      fs.writeFileSync(path.join(wsDir, 'CLAUDE.md.new'), newContent);

      const notice =
        '> **⚠️ 系統升級通知 v1.8.0：** 新增語意搜尋功能！' +
        '有新版操作手冊 `CLAUDE.md.new`，請讀取它，' +
        '將「語意搜尋」段落整合到這份文件中。系統會自動清理 `.new` 檔案。\n\n';

      if (!existing.includes('CLAUDE.md.new')) {
        fs.writeFileSync(claudeMdPath, notice + existing);
      }
      log.info(`Workspace ${wsId}: CLAUDE.md.new written (v1.8.0 memory search)`);
    }
  }

  // 2. Notify user about new features
  await notifyAllBindings(
    '🔍 **新功能：語意搜尋上線了！**\n\n' +
    '你的所有筆記現在都可以用自然語言搜尋：\n\n' +
    '**`/search <關鍵字或描述>`**\n' +
    '例如：`/search 穩定幣結算機制` 或 `/search 上次討論的投資策略`\n\n' +
    '搜尋會找到語意相關的筆記，不只是關鍵字完全一樣的內容。\n\n' +
    '我在對話中也會主動使用這個功能——當你提到過去討論的話題時，' +
    '我會自動搜尋相關筆記，不需要你特別說。'
  );

  log.info(`Workspace ${wsId}: v1.8.0 memory search notification sent`);
};
