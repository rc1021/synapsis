# Google Cloud TTS — 中文語音清單

切換語音只需改 `.env` 的 `GOOGLE_TTS_VOICE`，`languageCode` 會自動從語音名稱解析
(`<languageCode>-<Type>-<Variant>`，例如 `cmn-CN-Chirp3-HD-Aoede` → `cmn-CN`)。
不需要額外設定或改程式碼。

來源：`GET https://texttospeech.googleapis.com/v1/voices?languageCode=<code>&key=<API_KEY>`
（2026-06-11 查詢）

## cmn-TW（台灣腔）

只有 Standard / WaveNet，無 Neural2 / Chirp3 HD。

| 語音 | 性別 |
|---|---|
| cmn-TW-Standard-A | FEMALE |
| cmn-TW-Standard-B | MALE |
| cmn-TW-Standard-C | MALE |
| cmn-TW-Wavenet-A | FEMALE（目前預設） |
| cmn-TW-Wavenet-B | MALE |
| cmn-TW-Wavenet-C | MALE |

## cmn-CN（大陸腔）

有 Standard / WaveNet，以及最新的 **Chirp3 HD**（30 種語音，更自然的語調/停頓/情緒）。

| 語音 | 性別 |
|---|---|
| cmn-CN-Standard-A/B/C/D | F/M/M/F |
| cmn-CN-Wavenet-A/B/C/D | F/M/M/F |
| cmn-CN-Chirp3-HD-Achernar | FEMALE |
| cmn-CN-Chirp3-HD-Achird | MALE |
| cmn-CN-Chirp3-HD-Algenib | MALE |
| cmn-CN-Chirp3-HD-Algieba | MALE |
| cmn-CN-Chirp3-HD-Alnilam | MALE |
| cmn-CN-Chirp3-HD-Aoede | FEMALE |
| cmn-CN-Chirp3-HD-Autonoe | FEMALE |
| cmn-CN-Chirp3-HD-Callirrhoe | FEMALE |
| cmn-CN-Chirp3-HD-Charon | MALE |
| cmn-CN-Chirp3-HD-Despina | FEMALE |
| cmn-CN-Chirp3-HD-Enceladus | MALE |
| cmn-CN-Chirp3-HD-Erinome | FEMALE |
| cmn-CN-Chirp3-HD-Fenrir | MALE |
| cmn-CN-Chirp3-HD-Gacrux | FEMALE |
| cmn-CN-Chirp3-HD-Iapetus | MALE |
| cmn-CN-Chirp3-HD-Kore | FEMALE |
| cmn-CN-Chirp3-HD-Laomedeia | FEMALE |
| cmn-CN-Chirp3-HD-Leda | FEMALE |
| cmn-CN-Chirp3-HD-Orus | MALE |
| cmn-CN-Chirp3-HD-Puck | MALE |
| cmn-CN-Chirp3-HD-Pulcherrima | FEMALE |
| cmn-CN-Chirp3-HD-Rasalgethi | MALE |
| cmn-CN-Chirp3-HD-Sadachbia | MALE |
| cmn-CN-Chirp3-HD-Sadaltager | MALE |
| cmn-CN-Chirp3-HD-Schedar | MALE |
| cmn-CN-Chirp3-HD-Sulafat | FEMALE |
| cmn-CN-Chirp3-HD-Umbriel | MALE |
| cmn-CN-Chirp3-HD-Vindemiatrix | FEMALE |
| cmn-CN-Chirp3-HD-Zephyr | FEMALE |
| cmn-CN-Chirp3-HD-Zubenelgenubi | MALE |

注意：cmn-CN 語音以大陸腔發音朗讀繁體文字內容（內容不變，僅發音/語調為大陸腔）。

## 免費額度與計價（2026-06-11 查詢）

| 類型 | 免費額度 | 超額費用 |
|---|---|---|
| Standard | 4M 字/月 | $4 / 1M 字 |
| WaveNet | 4M 字/月 | $4 / 1M 字 |
| Neural2 | 1M 字/月 | $16 / 1M 字 |
| Chirp3 HD | 1M 字/月 | $30 / 1M 字 |
| Studio | 1M 字/月 | $160 / 1M 字 |
