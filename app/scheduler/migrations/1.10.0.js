/**
 * v1.9.0 → v1.10.0: Podcast & YouTube transcript commands
 * - /pod: fetch podcast transcript (Castbox, SoundOn, Apple Podcasts, etc.)
 *   via yt-dlp + Whisper, AI summarizes + saves notes, asks user about exploration
 * - /yt: now also saves structured notes and asks about exploration topics
 * - Transcripts saved permanently to transcripts/ (not auto-deleted)
 */
module.exports = async function migrate(ctx) {
  const { wsId, log, notifyAllBindings } = ctx;

  await notifyAllBindings(
    '新功能上線 🎙️\n\n' +
    '**`/yt`** 和 **`/pod`** — 現在可以直接丟 YouTube 影片或 Podcast 集數連結給我。\n\n' +
    '我會自動取得逐字稿，整理重點摘要、存成筆記，' +
    '如果內容裡有值得深挖的主題，我也會問你要不要加進探索清單。\n\n' +
    '`/yt video:<YouTube 網址>` — YouTube 影片\n' +
    '`/pod url:<Podcast 集數網址>` — Castbox、SoundOn 等 Podcast 平台\n\n' +
    '加上 `verify:true` 可以開啟事實查核模式——\n' +
    '我會逐一拆解內容裡的聲明，用 WebSearch 查找外部佐證，標記哪些有根據、哪些存疑，再把查核結果整理成筆記。\n' +
    '適合用在有數據引用、強烈觀點、或你想認真深入的集數。\n\n' +
    '筆記和逐字稿存好之後，有兩種方式查看：\n' +
    '`/search <關鍵字>` — 直接語意搜尋內容\n' +
    '`/dashboard` — 開啟檔案管理頁面，可以瀏覽 `notes/` 和 `transcripts/` 目錄'
  );

  log.info(`Workspace ${wsId}: v1.10.0 /yt + /pod notification sent`);
};
