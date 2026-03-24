#!/usr/bin/env python3
"""
Podcast Transcript Fetcher
用法: python3 pod-transcript.py <Podcast URL> [--lang <語言碼>] [--output <目錄>]

流程:
  1. yt-dlp 下載 MP3（支援 Castbox、SoundOn、Apple Podcasts 等平台）
  2. Whisper 語音轉文字
  3. 刪除 MP3

範例:
  python3 pod-transcript.py https://castbox.fm/episode/...
  python3 pod-transcript.py https://castbox.fm/episode/... --lang zh
  python3 pod-transcript.py https://castbox.fm/episode/... --output ./transcripts/
"""

import sys
import os
import re
import subprocess
import shutil
import tempfile

# Defaults (overridable via env vars)
DEFAULT_LANG = os.environ.get('POD_DEFAULT_LANG', 'zh')


def get_episode_title(url):
    """Get episode title via yt-dlp for filename."""
    try:
        result = subprocess.run(
            ['yt-dlp', '--get-title', '--no-warnings', url],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            title = result.stdout.strip()
            title = re.sub(r'[<>:"/\\|?*]', '', title)
            title = title.strip('. ')
            return title[:100]
    except Exception:
        pass
    return 'podcast-episode'


def fetch_transcript_whisper(url, lang, output_dir=None):
    """Download audio via yt-dlp, transcribe via Whisper, clean up."""
    if not shutil.which('yt-dlp'):
        raise RuntimeError("yt-dlp 未安裝")

    whisper_lang = lang or DEFAULT_LANG

    tmpdir = tempfile.mkdtemp(prefix='pod-transcript-')
    mp3_path = os.path.join(tmpdir, 'episode.mp3')

    try:
        # Step 1: Download MP3
        print(f"下載音訊中...", file=sys.stderr)
        dl_result = subprocess.run(
            [
                'yt-dlp',
                '-x', '--audio-format', 'mp3',
                '--audio-quality', '5',
                '-o', mp3_path,
                '--no-warnings',
                url,
            ],
            capture_output=True, text=True, timeout=600,
        )
        if dl_result.returncode != 0:
            raise RuntimeError(f"yt-dlp 下載失敗: {dl_result.stderr.strip()}")

        # yt-dlp may add extension, find the actual file
        if not os.path.exists(mp3_path):
            for f in os.listdir(tmpdir):
                if f.endswith('.mp3'):
                    mp3_path = os.path.join(tmpdir, f)
                    break

        if not os.path.exists(mp3_path):
            raise RuntimeError("MP3 下載後找不到檔案")

        # Step 2: Whisper transcribe
        print(f"語音轉文字中... (Whisper, lang={whisper_lang})", file=sys.stderr)
        whisper_result = subprocess.run(
            [
                sys.executable, '-m', 'whisper',
                mp3_path,
                '--language', whisper_lang,
                '--output_format', 'txt',
                '--output_dir', tmpdir,
            ],
            capture_output=True, text=True, timeout=1800,  # 30 min max
        )
        if whisper_result.returncode != 0:
            raise RuntimeError(f"Whisper 轉文字失敗: {whisper_result.stderr.strip()}")

        # Find the .txt output
        txt_path = None
        for f in os.listdir(tmpdir):
            if f.endswith('.txt'):
                txt_path = os.path.join(tmpdir, f)
                break

        if not txt_path or not os.path.exists(txt_path):
            raise RuntimeError("Whisper 輸出 .txt 找不到")

        whisper_text = open(txt_path, 'r', encoding='utf-8').read().strip()

        lines = []
        lines.append(f"來源: {url}")
        lines.append(f"語言: {whisper_lang}")
        lines.append(f"轉錄方式: Whisper 語音轉文字")
        lines.append("---")
        lines.append(whisper_text)

        content = '\n'.join(lines)

        # Output to file or stdout
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
            title = get_episode_title(url)
            filename = f"{title}.txt"
            filepath = os.path.join(output_dir, filename)
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            print(filepath)
        else:
            print(content)

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    args = sys.argv[1:]
    if not args:
        print("用法: python3 pod-transcript.py <Podcast URL> [--lang <語言碼>] [--output <目錄>]", file=sys.stderr)
        sys.exit(1)

    url = args[0]
    lang = None
    output_dir = None

    if '--lang' in args:
        lang_idx = args.index('--lang')
        if lang_idx + 1 < len(args):
            lang = args[lang_idx + 1]

    if '--output' in args:
        out_idx = args.index('--output')
        if out_idx + 1 < len(args):
            output_dir = args[out_idx + 1]

    try:
        fetch_transcript_whisper(url, lang, output_dir)
    except Exception as e:
        print(f"錯誤: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
