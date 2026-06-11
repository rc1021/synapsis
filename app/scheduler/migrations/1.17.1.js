/**
 * v1.17.0 → v1.17.1: /speak now also attaches the converted transcript
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '`/speak` 現在除了語音檔，也會附上轉換後的逐字稿（.txt）📝\n\n' +
    '可以用來檢查唸出來的內容是否符合預期。'
  );

  log.info(`Workspace ${wsId}: v1.17.1 /speak transcript notification sent`);
};
