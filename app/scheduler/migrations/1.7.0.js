/**
 * v1.6.0 → v1.7.0: Binary file upload support
 * - Discord bridge now accepts all file types (images, PDFs, Excel, etc.)
 * - All uploads saved to workspace uploads/ directory
 * - AI uses Read tool to view images and PDFs natively
 * - Notify users of the new capability
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '📎 **新功能：現在可以上傳圖片、PDF、Excel 等各種檔案了！**\n\n' +
    '直接把檔案拖進對話，我就能讀取並分析：\n' +
    '• 🖼️ 圖片（jpg、png、gif、webp）\n' +
    '• 📄 PDF 文件\n' +
    '• 📊 Excel / CSV 等資料檔案\n' +
    '• 📝 任何文字檔\n\n' +
    '試試看直接傳一張截圖或文件給我吧！'
  );

  log.info(`Workspace ${wsId}: v1.7.0 binary upload notification sent`);
};
