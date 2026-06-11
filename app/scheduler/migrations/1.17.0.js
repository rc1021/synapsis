/**
 * v1.16.0 → v1.17.0: /list gains a folders-only option
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '`/list` 多了一個參數 📂\n\n' +
    '`folders:true` — 只顯示資料夾，不顯示檔案（可與 `filter`、`count`、`keywords` 搭配使用）\n\n' +
    '範例：`/list path:memory folders:true`'
  );

  log.info(`Workspace ${wsId}: v1.17.0 /list folders option notification sent`);
};
