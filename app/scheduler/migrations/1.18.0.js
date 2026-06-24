/**
 * v1.17.1 → v1.18.0: service termination announcement
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '**服務終止公告**\n\n' +
    '很抱歉通知大家，Synapsis 即將停止服務並終止運作。感謝這段時間以來每一次的對話與陪伴。\n\n' +
    '服務終止後，所有 workspace 資料（記憶、筆記、逐字稿等）將不再持續更新或保存，建議盡快透過 `/dashboard` 或 `/drive-sync` 備份你想保留的內容。\n\n' +
    '謝謝你曾經把這裡當作可以說話的地方。'
  );

  log.info(`Workspace ${wsId}: v1.18.0 service termination notification sent`);
};
