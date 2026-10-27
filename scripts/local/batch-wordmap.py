"""批量词级转写驱动（2026-10-27 ①）：TOP interior 课程 → temp/wordmap-v2/{cid}.json。

用法：python scripts/local/batch-wordmap.py [cid1,cid2,...]   # 缺省跑内置 TOP19
- 源音频 .ogg（六级新课）先 ffmpeg 转 mp3（ASR 渠道兼容）再送
- 经插件 CLI video_agent_tool.py speech_transcribe（cloud_asr，词级时间戳）
- 已存在 {cid}.json 跳过（断点续跑）
- 2 并发；每门 2.5 分钟左右
"""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "temp" / "wordmap-v2"
SRC = OUT / "src"
CLI = Path(r"C:\Users\Zsc\.zcode\cli\plugins\cache\zcode-plugins-official\video-agent-kit\0.4.3\cli\video_agent_tool.py")
STORE = ROOT / "temp" / "runtime" / "media-store" / "duolinting-media"

DEFAULT_IDS = [25, 1024, 1012, 17, 1016, 1005, 39, 1010, 61, 34, 1001, 1009, 55, 22, 1015, 1033, 14, 16, 1014]

ids = [int(x) for x in sys.argv[1].split(",")] if len(sys.argv) > 1 else DEFAULT_IDS
OUT.mkdir(parents=True, exist_ok=True)
SRC.mkdir(parents=True, exist_ok=True)

audio_of = {int(k): v for k, v in json.loads((OUT / "audio-map.json").read_text(encoding="utf-8")).items()}


def run_one(cid: int) -> str:
    dest = OUT / f"{cid}.json"
    if dest.exists():
        return f"#{cid} 已有词图，跳过"
    obj = audio_of.get(cid)
    if not obj:
        return f"#{cid} 无音频记录"
    src = STORE / obj[obj.index("audio/"):]
    if not src.exists():
        return f"#{cid} 音频不存在 {src}"
    # ogg/非 mp3 预转
    feed = src
    if src.suffix.lower() not in (".mp3", ".wav", ".m4a"):
        feed = SRC / f"{cid}.mp3"
        if not feed.exists():
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(src),
                            "-ac", "1", "-b:a", "64k", str(feed), "-y"], check=True)
    r = subprocess.run(
        ["python", str(CLI), "speech_transcribe", "--args-json",
         json.dumps({"input_path": str(feed), "output_json": str(dest), "language": "en"})],
        capture_output=True, text=True, timeout=1800, cwd=str(ROOT))
    if dest.exists():
        # 归一输出路径（工具可能写相对路径到别处）
        j = json.loads(dest.read_text(encoding="utf-8"))
        words = j.get("words") or []
        return f"#{cid} ✓ {len(words)} 词 / {len(j.get('segments') or [])} 段"
    # 工具把 output_json 相对路径写去了别处？尝试回找
    alt = ROOT.parent / "temp" / f"{cid}.json"
    if alt.exists():
        j = json.loads(alt.read_text(encoding="utf-8"))
        if j.get("words"):
            dest.write_text(json.dumps(j), encoding="utf-8")
            alt.unlink()
            return f"#{cid} ✓ {len(j['words'])} 词（回收自 Documents/temp）"
    return f"#{cid} ✗ {r.stdout[-200:]} {r.stderr[-200:]}"


with ThreadPoolExecutor(max_workers=2) as ex:
    for msg in ex.map(run_one, ids):
        print(msg, flush=True)
