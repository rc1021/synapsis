#!/usr/bin/env python3
"""
YouTube Transcript Fetcher
用法: python3 yt-transcript.py <YouTube URL or Video ID> [--lang <語言碼>]

範例:
  python3 yt-transcript.py https://youtu.be/3gtGEYj8Kks
  python3 yt-transcript.py 3gtGEYj8Kks --lang en
  python3 yt-transcript.py 3gtGEYj8Kks --list   # 只列出可用語言
"""

import sys
import re
from youtube_transcript_api import YouTubeTranscriptApi


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


def main():
    args = sys.argv[1:]
    if not args:
        print("用法: python3 yt-transcript.py <YouTube URL or Video ID> [--lang <語言碼>] [--list]", file=sys.stderr)
        sys.exit(1)

    input_str = args[0]
    lang = None
    list_only = '--list' in args

    if '--lang' in args:
        lang_idx = args.index('--lang')
        if lang_idx + 1 < len(args):
            lang = args[lang_idx + 1]

    video_id = extract_video_id(input_str)
    if not video_id:
        print(f"無法解析 Video ID: {input_str}", file=sys.stderr)
        sys.exit(1)

    ytt_api = YouTubeTranscriptApi()

    try:
        transcript_list = ytt_api.list(video_id)
    except Exception as e:
        print(f"錯誤: {e}", file=sys.stderr)
        sys.exit(1)

    # Show available languages
    available = []
    for t in transcript_list:
        label = t.language_code
        if t.is_generated:
            label += " (auto)"
        available.append(label)

    if list_only:
        print(f"Video: https://youtube.com/watch?v={video_id}")
        print(f"可用語言: {', '.join(available)}")
        sys.exit(0)

    # Fetch transcript
    try:
        if lang:
            transcript = ytt_api.fetch(video_id, languages=[lang])
        else:
            # Try manual first, then auto
            transcript = ytt_api.fetch(video_id)
    except Exception as e:
        print(f"錯誤: {e}", file=sys.stderr)
        print(f"可用語言: {', '.join(available)}", file=sys.stderr)
        sys.exit(1)

    # Output
    print(f"Video: https://youtube.com/watch?v={video_id}")
    print(f"語言: {transcript.language_code}")
    print(f"可用語言: {', '.join(available)}")
    print("---")
    for entry in transcript:
        time_str = format_time(entry.start)
        text = entry.text.replace('\n', ' ')
        print(f"[{time_str}] {text}")


if __name__ == '__main__':
    main()
