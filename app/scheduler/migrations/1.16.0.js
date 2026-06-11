/**
 * v1.15.0 → v1.16.0: /list gains filter, count, and keywords options
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '`/list` 多了三個參數 🗂️\n\n' +
    '`filter:關鍵字` — 只顯示名稱包含關鍵字的項目，並標出命中的部分\n' +
    '`count:true` — 不列出項目，只顯示數量\n' +
    '`keywords:true` — 從項目名稱中萃取常見關鍵字\n\n' +
    '範例：`/list path:memory filter:下雨`、`/list path:memory keywords:true`'
  );

  log.info(`Workspace ${wsId}: v1.16.0 /list options notification sent`);
};
