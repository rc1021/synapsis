/**
 * v1.13.0 → v1.14.0: /list — browse workspace folders from Discord
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '新功能：`/list` —— 直接在 Discord 看 workspace 裡有哪些檔案 🗂️\n\n' +
    '`/list` 列出根目錄，`/list path:memory` 看子資料夾，' +
    '不用開網頁版檔案總管也能快速看一眼。\n\n' +
    '範例：`/list path:transcripts`'
  );

  log.info(`Workspace ${wsId}: v1.14.0 /list notification sent`);
};
