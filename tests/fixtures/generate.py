"""Generate synthetic project files in a caller-provided directory."""
import json
from pathlib import Path


def make_project(directory, kind):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "project.json"
    if kind == "broken":
        target.write_text('{"pes": 1, "stages":', encoding="utf-8")
    elif kind == "legacy":
        target.write_text(json.dumps({"pes": 1, "topic": "합성 주제", "stages": {"plan": {"items": [{"id": 1, "title": "합성 항목"}]}}}, ensure_ascii=False), encoding="utf-8")
    elif kind == "large":
        target.write_text(json.dumps({"pes": 1, "topic": "합성 주제", "stages": {}, "synthetic_payload": "x" * (2 * 1024 * 1024)}, ensure_ascii=False), encoding="utf-8")
    else:
        raise ValueError(kind)
    return directory
