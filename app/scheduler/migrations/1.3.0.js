const fs = require('fs');
const path = require('path');

/**
 * v1.2.0 → v1.3.0: Fix CLAUDE.md — silence .new merge, restrict web marker
 * - Write CLAUDE.md.new with corrected instructions
 * - Clear session store
 */
module.exports = function migrate(ctx) {
  const { wsId, wsDir, templateDir, wm, log } = ctx;

  const claudeMdPath = path.join(wsDir, 'CLAUDE.md');
  const newClaudeMdTemplate = path.join(templateDir, 'CLAUDE.md');

  if (fs.existsSync(newClaudeMdTemplate) && fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');

    // Always write .new — this fixes prompt instructions
    const newContent = fs.readFileSync(newClaudeMdTemplate, 'utf-8');
    fs.writeFileSync(path.join(wsDir, 'CLAUDE.md.new'), newContent);

    const notice = '> **⚠️ 系統升級通知：** 有新版操作手冊 `CLAUDE.md.new`。請讀取它，將有用的新段落整合到這份文件中，然後刪除 `CLAUDE.md.new`。\n\n';
    if (!existing.includes('CLAUDE.md.new')) {
      fs.writeFileSync(claudeMdPath, notice + existing);
    }
    log.info(`Workspace ${wsId}: CLAUDE.md.new written (v1.3.0 prompt fix)`);
  }

  // Clear session store
  const sessionFile = wm.sessionStorePath(wsDir);
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
    log.info(`Workspace ${wsId}: session store cleared (v1.3.0)`);
  }
};
