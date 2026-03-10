const fs = require('fs');
const path = require('path');

/**
 * v1.4.0 → v1.5.0: MCP (Model Context Protocol) support
 * - Add .mcp.json to workspace (empty, user can configure)
 * - Write CLAUDE.md.new with MCP documentation
 * - Notify user about new MCP feature
 */
module.exports = async function migrate(ctx) {
  const { wsId, wsDir, templateDir, wm, log, notifyAllBindings } = ctx;

  // 1. Add .mcp.json if not exists
  const mcpPath = path.join(wsDir, '.mcp.json');
  if (!fs.existsSync(mcpPath)) {
    const templateMcp = path.join(templateDir, '.mcp.json');
    if (fs.existsSync(templateMcp)) {
      fs.copyFileSync(templateMcp, mcpPath);
    } else {
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2));
    }
    log.info(`Workspace ${wsId}: .mcp.json created (v1.5.0 MCP support)`);
  }

  // 2. Update CLAUDE.md with MCP docs
  const claudeMdPath = path.join(wsDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');

    if (!existing.includes('.mcp.json')) {
      const newContent = fs.readFileSync(path.join(templateDir, 'CLAUDE.md'), 'utf-8');
      fs.writeFileSync(path.join(wsDir, 'CLAUDE.md.new'), newContent);

      const notice = '> **⚠️ 系統升級通知 v1.5.0：** MCP 功能上線！你現在可以連接外部工具（Google Calendar、Notion 等）。有新版操作手冊 `CLAUDE.md.new`，請讀取它，將有用的新段落整合到這份文件中，然後刪除 `CLAUDE.md.new`。\n\n';
      if (!existing.includes('CLAUDE.md.new')) {
        fs.writeFileSync(claudeMdPath, notice + existing);
      }
      log.info(`Workspace ${wsId}: CLAUDE.md.new written (v1.5.0 MCP)`);
    }
  }

  // 3. Notify user about new feature
  if (notifyAllBindings) {
    try {
      await notifyAllBindings(
        wsDir,
        { id: 'migration-1.5.0', notify: true },
        '🔌 **MCP 功能上線！**\n\n' +
        '現在可以連接外部工具到 AI 對話中：\n' +
        '• **Puppeteer** — 已內建，AI 可以瀏覽網頁、截圖\n' +
        '• **Google Calendar** — 可選，讓 AI 讀取你的行事曆\n' +
        '• **Notion** — 可選，讓 AI 搜尋你的筆記\n\n' +
        '想啟用 Google Calendar 或 Notion？跟我說就好，我會幫你設定！',
        null,
        []
      );
    } catch (err) {
      log.warn(`Workspace ${wsId}: MCP notification failed: ${err.message}`);
    }
  }

  // 4. Clear session store (new system prompt with MCP)
  const sessionFile = wm.sessionStorePath(wsDir);
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
    log.info(`Workspace ${wsId}: session store cleared (v1.5.0)`);
  }
};
