#!/usr/bin/env python3
"""Put one dialect prompt into firmware/stackchan/manifest_local.json.

Usage:
  python3 tools/apply_dialect.py yanbian
  python3 tools/apply_dialect.py gyeongsang --voice YOUR_VOICE_ID

Dialects: chungcheong, jeolla, gyeongsang, gangwon, yanbian
If manifest_local.json does not exist yet, it is created from
manifest_local.example.json. Wi-Fi and API key must still be filled in by hand.
Nothing secret is printed.
"""
import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROMPTS = ROOT / "dialect-prompts.json"
LOCAL = ROOT / "firmware" / "stackchan" / "manifest_local.json"
EXAMPLE = ROOT / "firmware" / "stackchan" / "manifest_local.example.json"


def main() -> None:
    prompts = json.loads(PROMPTS.read_text(encoding="utf-8"))
    parser = argparse.ArgumentParser(description="Apply a dialect prompt to manifest_local.json")
    parser.add_argument("dialect", choices=sorted(prompts.keys()))
    parser.add_argument("--voice", help="ElevenLabs voice ID to use for this dialect")
    args = parser.parse_args()

    if not LOCAL.exists():
        shutil.copyfile(EXAMPLE, LOCAL)
        print(f"created {LOCAL.relative_to(ROOT)} from the example")

    data = json.loads(LOCAL.read_text(encoding="utf-8"))
    config = data.setdefault("config", {})
    config["chatType"] = "elevenLabsAgent"
    config["chatInstructions"] = prompts[args.dialect]["instructions"]
    if args.voice:
        config["chatVoiceID"] = args.voice
    LOCAL.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"applied: {prompts[args.dialect]['name']} ({args.dialect})")
    missing = [k for k in ("ssid", "password", "chatProviderID", "chatVoiceID") if str(config.get(k, "")).startswith("YOUR_")]
    if missing:
        print("still to fill in by hand: " + ", ".join(missing))


if __name__ == "__main__":
    main()
