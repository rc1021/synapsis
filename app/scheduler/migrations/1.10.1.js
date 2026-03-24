const fs = require('fs');
const path = require('path');

/**
 * v1.10.0 → v1.10.1: Fix /pod and /yt response delivery on long processing
 * - When processing exceeds Discord's 15-min interaction token window,
 *   responses now fall back to DM automatically
 * - Retroactively re-queues failed /pod job for workspace 9cf9863f0ed3653b
 */
module.exports = async function migrate(ctx) {
  const { wsId, wsDir, log, notifyAllBindings } = ctx;

  // Re-queue the failed /pod analysis for the affected workspace
  if (wsId === '9cf9863f0ed3653b') {
    const jobsPath = path.join(wsDir, 'jobs.json');
    let jobsData = { jobs: [] };
    try {
      jobsData = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    } catch {
      // no existing jobs.json
    }

    const transcriptFile = '人生賽道 EP129｜揭開管理顧問的神秘面紗！從被拒絕開戶到百億委任都是挑戰！ feat. Matt 陳詩超 (1).txt';

    // Only add if not already queued
    if (!jobsData.jobs.find(j => j.id === 'pod-retry-ep129')) {
      jobsData.jobs.push({
        id: 'pod-retry-ep129',
        name: '補發：人生賽道 EP129 逐字稿分析',
        schedule: '* * * * *',
        once: true,
        tier: 'standard',
        prompt: `[補發任務] 上次 /pod 指令因處理時間超過 Discord 限制，分析結果未能送達。\n\n逐字稿已保存在 transcripts/"${transcriptFile}"，請：\n1. 閱讀逐字稿，回覆重點摘要（核心觀點、精彩段落、金句）\n2. 將結構化筆記（主題、重點、可行動事項）存到 notes/ 目錄下適當位置\n3. 如果逐字稿中有值得深挖的主題或概念（不超過 3 個），在回覆末尾列出，問用戶是否加進探索清單`,
        notify: { when: 'always' },
      });
      fs.writeFileSync(jobsPath, JSON.stringify(jobsData, null, 2));
      log.info(`Workspace ${wsId}: pod-retry-ep129 job queued`);
    }
  }

  // Notify all users
  await notifyAllBindings(
    '剛才發現 `/pod` 和 `/yt` 有個問題——\n\n' +
    '如果集數很長、處理時間超過 15 分鐘，Discord 的回覆視窗會過期，' +
    '結果就石沉大海，什麼都沒收到。\n\n' +
    '已經修好了。現在超時的話我會改用私訊把結果送過來，不會再消失了。\n\n' +
    '如果你最近有用過 `/pod` 或 `/yt` 卻沒收到回覆，可以再試一次。'
  );

  log.info(`Workspace ${wsId}: v1.10.1 pod/yt fix notification sent`);
};
