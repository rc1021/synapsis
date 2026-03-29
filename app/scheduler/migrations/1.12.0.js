/**
 * v1.11.1 → v1.12.0: Stock Scanner MCP — Taiwan stock signals, valuation, chips, fundamentals
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '新功能：現在可以直接問我台股問題了。\n\n' +
    '均線糾結訊號、357 存股估值（便宜/合理/昂貴價）、籌碼（法人買賣超、融資券）、EPS 趨勢、配息紀錄——直接問就好，不用自己查。\n\n' +
    '範例：「2330 現在貴不貴？」「今天台灣150 有哪些 S2 訊號？」「外資最近在買還是賣 2412？」\n\n' +
    '有什麼想問的直接試試看。'
  );

  log.info(`Workspace ${wsId}: v1.12.0 notification sent`);
};
