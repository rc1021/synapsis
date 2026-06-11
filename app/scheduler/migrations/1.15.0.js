/**
 * v1.14.0 → v1.15.0: /search now understands dates and filenames
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '`/search` 升級了 🔍\n\n' +
    '以前像「4到5月的筆記」這種帶時間範圍的查詢，語意搜尋找不到準確結果。' +
    '現在 `/search` 會先理解日期/星期/月份等時間描述，直接比對筆記日期，' +
    '也會比對檔名、標題、標籤，找不到時才退回語意搜尋，並標示信心程度。\n\n' +
    '範例：`/search query:上週的筆記`、`/search query:5月關於投資的筆記`'
  );

  log.info(`Workspace ${wsId}: v1.15.0 /search hybrid-search notification sent`);
};
