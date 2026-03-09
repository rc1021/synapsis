const fs = require('fs');
const path = require('path');

/**
 * v1.1.0 → v1.2.0: Web dashboard
 * - Write CLAUDE.md.new with web dashboard instructions
 * - Clear session store
 */
module.exports = function migrate(ctx) {
  const { wsId, wsDir, templateDir, wm, log } = ctx;

  const claudeMdPath = path.join(wsDir, 'CLAUDE.md');
  const newClaudeMdTemplate = path.join(templateDir, 'CLAUDE.md');

  if (fs.existsSync(newClaudeMdTemplate) && fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');

    if (!existing.includes('REQUEST_WEB_ACCESS')) {
      const newContent = fs.readFileSync(newClaudeMdTemplate, 'utf-8');
      fs.writeFileSync(path.join(wsDir, 'CLAUDE.md.new'), newContent);

      const notice = '> **⚠️ 系統升級通知：** 有新版操作手冊 `CLAUDE.md.new`。請讀取它，將有用的新段落整合到這份文件中，然後刪除 `CLAUDE.md.new`。\n\n';
      if (!existing.includes('CLAUDE.md.new')) {
        fs.writeFileSync(claudeMdPath, notice + existing);
      }
      log.info(`Workspace ${wsId}: CLAUDE.md.new written (v1.2.0 web dashboard)`);
    }
  }

  // Clear session store
  const sessionFile = wm.sessionStorePath(wsDir);
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
    log.info(`Workspace ${wsId}: session store cleared (v1.2.0)`);
  }
};
