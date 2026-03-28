/**
 * v1.11.0 → v1.11.1: Drive sync upgrade + message symbol markers
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '`/drive-sync` 升級了 — 現在兩端都改過的檔案會自動合併，不會互蓋；Drive 那邊刪掉的也會同步過來。同步更安心了。\n\n' +
    '另外，我傳的訊息底部開始會有個小符號，算是我自己的小記號，你可以無視它 :)'
  );

  log.info(`Workspace ${wsId}: v1.11.1 notification sent`);
};
