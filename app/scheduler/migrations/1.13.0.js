/**
 * v1.12.0 → v1.13.0: /speak — convert workspace notes to audio
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '新功能：筆記也能用聽的了 🔊\n\n' +
    '`/speak note:<筆記路徑>` —— 把 workspace 裡的一篇筆記整篇轉成語音檔，' +
    '適合通勤、做家事的時候用耳朵「讀」筆記。\n\n' +
    '範例：`/speak note:memory/2026-06-10.md`\n\n' +
    '支援 .md / .markdown / .txt，會自動把標題、清單、表格轉成口語化的句子再朗讀。'
  );

  log.info(`Workspace ${wsId}: v1.13.0 /speak notification sent`);
};
