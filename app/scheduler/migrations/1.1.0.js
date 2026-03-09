const fs = require('fs');
const path = require('path');

/**
 * v1.0.0 → v1.1.0: Soul system redesign
 * - IDENTITY.md Name/Emoji → USER.md "對我的設定"
 * - Delete IDENTITY.md
 * - Write SOUL.md.new for AI to self-merge (with Creature/Vibe injected)
 * - Write CLAUDE.md.new for AI to self-merge
 * - Clean up BOOTSTRAP.md if onboarding is done
 * - Clear session store
 * - Notify user
 */
module.exports = async function migrate(ctx) {
  const { wsId, wsDir, profile, templateDir, wm, log, notifyAllBindings } = ctx;

  const identityPath = path.join(wsDir, 'IDENTITY.md');
  const userMdPath = path.join(wsDir, 'USER.md');
  const soulPath = path.join(wsDir, 'SOUL.md');
  const claudeMdPath = path.join(wsDir, 'CLAUDE.md');
  const bootstrapPath = path.join(wsDir, 'BOOTSTRAP.md');

  // 1. Extract fields from IDENTITY.md
  let aiName = '';
  let aiEmoji = '';
  let aiCreature = '';
  let aiVibe = '';
  if (fs.existsSync(identityPath)) {
    const identity = fs.readFileSync(identityPath, 'utf-8');
    const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/);
    const emojiMatch = identity.match(/\*\*Emoji:\*\*\s*(.+)/);
    const creatureMatch = identity.match(/\*\*Creature:\*\*\s*(.+)/);
    const vibeMatch = identity.match(/\*\*Vibe:\*\*\s*(.+)/);
    if (nameMatch) aiName = nameMatch[1].trim();
    if (emojiMatch) aiEmoji = emojiMatch[1].trim();
    if (creatureMatch) aiCreature = creatureMatch[1].trim();
    if (vibeMatch) aiVibe = vibeMatch[1].trim();

    // Name/Emoji → USER.md "對我的設定"
    if (fs.existsSync(userMdPath)) {
      let userMd = fs.readFileSync(userMdPath, 'utf-8');
      if (!userMd.includes('對我的設定')) {
        const section = `\n## 對我的設定\n\n- **叫我什麼名字：** ${aiName || '_(not set)_'}\n- **Emoji：** ${aiEmoji || '_(not set)_'}\n`;
        userMd += section;
        fs.writeFileSync(userMdPath, userMd);
      }
    }

    fs.unlinkSync(identityPath);
    log.info(`Workspace ${wsId}: IDENTITY.md merged into USER.md and deleted`);
  }

  // 2. SOUL.md — write .new with Creature/Vibe injected
  const newSoulTemplate = path.join(templateDir, 'SOUL.md');
  if (fs.existsSync(newSoulTemplate)) {
    let newSoul = fs.readFileSync(newSoulTemplate, 'utf-8');

    if (aiCreature && !aiCreature.includes('not set')) {
      newSoul = newSoul.replace(/- \*\*形象：\*\*\s*.+/, `- **形象：** ${aiCreature}`);
    }
    if (aiVibe && !aiVibe.includes('not set')) {
      newSoul = newSoul.replace(/- \*\*語氣：\*\*\s*.+/, `- **語氣：** ${aiVibe}`);
    }

    fs.writeFileSync(path.join(wsDir, 'SOUL.md.new'), newSoul);

    if (fs.existsSync(soulPath)) {
      const existingSoul = fs.readFileSync(soulPath, 'utf-8');
      const notice = '> **⚠️ 系統升級通知：** 有新版個人靈魂模板 `SOUL.md.new`。請讀取它，將新的結構整合到這份文件中（保留你已演化的內容），然後刪除 `SOUL.md.new`。\n\n';
      if (!existingSoul.includes('SOUL.md.new')) {
        fs.writeFileSync(soulPath, notice + existingSoul);
      }
    } else {
      fs.renameSync(path.join(wsDir, 'SOUL.md.new'), soulPath);
    }
    log.info(`Workspace ${wsId}: SOUL.md.new written for AI self-merge`);
  }

  // 3. Write CLAUDE.md.new
  const newClaudeMdTemplate = path.join(templateDir, 'CLAUDE.md');
  if (fs.existsSync(newClaudeMdTemplate) && fs.existsSync(claudeMdPath)) {
    const newContent = fs.readFileSync(newClaudeMdTemplate, 'utf-8');
    fs.writeFileSync(path.join(wsDir, 'CLAUDE.md.new'), newContent);

    const existing = fs.readFileSync(claudeMdPath, 'utf-8');
    const notice = '> **⚠️ 系統升級通知：** 有新版操作手冊 `CLAUDE.md.new`。請讀取它，將有用的新段落整合到這份文件中，然後刪除 `CLAUDE.md.new`。\n\n';
    if (!existing.includes('CLAUDE.md.new')) {
      fs.writeFileSync(claudeMdPath, notice + existing);
    }
    log.info(`Workspace ${wsId}: CLAUDE.md.new written for AI self-merge`);
  }

  // 4. Clean up BOOTSTRAP.md if onboarding is done
  if (fs.existsSync(bootstrapPath)) {
    const userMd = fs.existsSync(userMdPath) ? fs.readFileSync(userMdPath, 'utf-8') : '';
    if (!userMd.includes('_(not set)_')) {
      fs.unlinkSync(bootstrapPath);
      log.info(`Workspace ${wsId}: stale BOOTSTRAP.md removed`);
    }
  }

  // 5. Clear session store
  const sessionFile = wm.sessionStorePath(wsDir);
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
    log.info(`Workspace ${wsId}: session store cleared (force reload)`);
  }

  // 6. Notify user
  const lang = detectLanguage(wsDir);
  let message;
  if (lang === 'zh') {
    message = `系統升級完成 (v1.1.0)：\n- 新增共同靈魂系統，AI 夥伴有了更清晰的核心價值觀\n- IDENTITY.md 已合併到 USER.md 和 SOUL.md\n- 操作手冊有更新，下次對話時會自動整合`;
  } else {
    message = `System upgrade complete (v1.1.0):\n- New shared soul system with clearer core values\n- IDENTITY.md merged into USER.md and SOUL.md\n- Operations manual updated, will be auto-merged on next conversation`;
  }
  if (aiName && !aiName.includes('not set')) {
    message += `\n\n— ${aiName}`;
  }

  try {
    await notifyAllBindings(wsDir, { id: 'system-upgrade', name: 'System upgrade' }, message, null);
  } catch (err) {
    log.warn(`Migration notification failed for ${wsId}: ${err.message}`);
  }
};

function detectLanguage(wsDir) {
  try {
    const userMd = fs.readFileSync(path.join(wsDir, 'USER.md'), 'utf-8');
    if (/Language:.*中文|Language:.*zh|Language:.*Chinese/i.test(userMd)) return 'zh';
    if (/[\u4e00-\u9fff]/.test(userMd)) return 'zh';
    return 'en';
  } catch {
    return 'en';
  }
}
