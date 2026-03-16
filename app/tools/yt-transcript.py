#!/usr/bin/env python3
"""
YouTube Transcript Fetcher
用法: python3 yt-transcript.py <YouTube URL or Video ID> [--lang <語言碼>] [--output <目錄>]

流程:
  1. 嘗試透過 YouTube API 下載字幕
  2. 若無字幕，用 yt-dlp 下載 MP3 → Whisper 語音轉文字 → 刪除 MP3

範例:
  python3 yt-transcript.py https://youtu.be/3gtGEYj8Kks
  python3 yt-transcript.py 3gtGEYj8Kks --lang en
  python3 yt-transcript.py 3gtGEYj8Kks --output ./transcripts/
  python3 yt-transcript.py 3gtGEYj8Kks --list   # 只列出可用語言
"""

import sys
import os
import re
import subprocess
import shutil
import tempfile
from youtube_transcript_api import YouTubeTranscriptApi

# Defaults (overridable via env vars)
DEFAULT_LANG = os.environ.get('YT_DEFAULT_LANG', 'zh')
FALLBACK_LANG = os.environ.get('YT_FALLBACK_LANG', 'en')


def extract_video_id(input_str):
    if re.match(r'^[a-zA-Z0-9_-]{11}$', input_str):
        return input_str
    patterns = [
        r'(?:youtu\.be/)([a-zA-Z0-9_-]{11})',
        r'(?:youtube\.com/watch\?v=)([a-zA-Z0-9_-]{11})',
        r'(?:youtube\.com/embed/)([a-zA-Z0-9_-]{11})',
        r'(?:youtube\.com/shorts/)([a-zA-Z0-9_-]{11})',
    ]
    for p in patterns:
        m = re.search(p, input_str)
        if m:
            return m.group(1)
    return None


def format_time(seconds):
    total = int(seconds)
    h, remainder = divmod(total, 3600)
    m, s = divmod(remainder, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def get_video_title(video_id):
    """Get video title via yt-dlp for filename."""
    try:
        result = subprocess.run(
            ['yt-dlp', '--get-title', '--no-warnings', f'https://youtube.com/watch?v={video_id}'],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            # Sanitize for filename
            title = result.stdout.strip()
            title = re.sub(r'[<>:"/\\|?*]', '', title)
            title = title.strip('. ')
            return title[:100]  # limit length
    except Exception:
        pass
    return video_id


def fetch_transcript_api(video_id, lang):
    """Try to fetch transcript via YouTube API. Returns (lines, lang_code) or raises."""
    ytt_api = YouTubeTranscriptApi()
    transcript_list = ytt_api.list(video_id)

    # Show available languages
    available = []
    for t in transcript_list:
        label = t.language_code
        if t.is_generated:
            label += " (auto)"
        available.append(label)

    # Fetch transcript
    if lang:
        transcript = ytt_api.fetch(video_id, languages=[lang])
    else:
        # Try default lang, fallback lang, then whatever is available
        try:
            transcript = ytt_api.fetch(video_id, languages=[DEFAULT_LANG])
        except Exception:
            try:
                transcript = ytt_api.fetch(video_id, languages=[FALLBACK_LANG])
            except Exception:
                transcript = ytt_api.fetch(video_id)

    lines = []
    lines.append(f"Video: https://youtube.com/watch?v={video_id}")
    lines.append(f"語言: {transcript.language_code}")
    lines.append(f"可用語言: {', '.join(available)}")
    lines.append(f"來源: YouTube 字幕")
    lines.append("---")
    for entry in transcript:
        time_str = format_time(entry.start)
        text = entry.text.replace('\n', ' ')
        lines.append(f"[{time_str}] {text}")

    return lines, available


def fetch_transcript_whisper(video_id, lang):
    """Fallback: download MP3 via yt-dlp, transcribe via Whisper, clean up."""
    # Check dependencies
    if not shutil.which('yt-dlp'):
        raise RuntimeError("yt-dlp 未安裝")

    whisper_lang = lang or DEFAULT_LANG

    tmpdir = tempfile.mkdtemp(prefix='yt-transcript-')
    mp3_path = os.path.join(tmpdir, f'{video_id}.mp3')

    try:
        # Step 1: Download MP3
        print(f"下載音訊中... ({video_id})", file=sys.stderr)
        dl_result = subprocess.run(
            [
                'yt-dlp',
                '-x', '--audio-format', 'mp3',
                '--audio-quality', '5',  # medium quality, smaller file
                '-o', mp3_path,
                '--no-warnings',
                f'https://youtube.com/watch?v={video_id}',
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
        lines.append(f"Video: https://youtube.com/watch?v={video_id}")
        lines.append(f"語言: {whisper_lang}")
        lines.append(f"來源: Whisper 語音轉文字")
        lines.append("---")
        lines.append(whisper_text)

        return lines

    finally:
        # Step 3: Clean up temp files
        shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    args = sys.argv[1:]
    if not args:
        print("用法: python3 yt-transcript.py <YouTube URL or Video ID> [--lang <語言碼>] [--output <目錄>] [--list]", file=sys.stderr)
        sys.exit(1)

    input_str = args[0]
    lang = None
    list_only = '--list' in args
    output_dir = None

    if '--lang' in args:
        lang_idx = args.index('--lang')
        if lang_idx + 1 < len(args):
            lang = args[lang_idx + 1]

    if '--output' in args:
        out_idx = args.index('--output')
        if out_idx + 1 < len(args):
            output_dir = args[out_idx + 1]

    video_id = extract_video_id(input_str)
    if not video_id:
        print(f"無法解析 Video ID: {input_str}", file=sys.stderr)
        sys.exit(1)

    # --list mode
    if list_only:
        ytt_api = YouTubeTranscriptApi()
        try:
            transcript_list = ytt_api.list(video_id)
            available = []
            for t in transcript_list:
                label = t.language_code
                if t.is_generated:
                    label += " (auto)"
                available.append(label)
            print(f"Video: https://youtube.com/watch?v={video_id}")
            print(f"可用語言: {', '.join(available)}")
        except Exception as e:
            print(f"錯誤: {e}", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)

    # Try YouTube API first, fallback to Whisper
    # Even if subtitles are listed but fail to download, always attempt audio transcription.
    lines = None
    try:
        lines, available = fetch_transcript_api(video_id, lang)
        print("使用 YouTube 字幕", file=sys.stderr)
    except Exception as e:
        print(f"YouTube 字幕不可用 ({e})，改用 Whisper 音訊轉文字...", file=sys.stderr)
        try:
            lines = fetch_transcript_whisper(video_id, lang)
            print("使用 Whisper 語音轉文字", file=sys.stderr)
        except SystemExit:
            raise
        except Exception as whisper_err:
            print(f"Whisper 也失敗 ({whisper_err})，無法取得逐字稿", file=sys.stderr)
            sys.exit(1)

    content = '\n'.join(lines)

    # Output to file or stdout
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        title = get_video_title(video_id)
        filename = f"{title}.txt"
        filepath = os.path.join(output_dir, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        # Print the saved path to stdout (for caller to parse)
        print(filepath)
    else:
        print(content)


if __name__ == '__main__':
    main()
