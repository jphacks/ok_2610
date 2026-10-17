"""日本語NERモデルを ONNX に変換し、8bit 量子化して public/models/ に置く。

元モデル: tsmatz/xlm-roberta-ner-japanese（MIT）。出所を固定するため revision を指定する（SEC-03）。
使い方:
  python3 -m venv .venv-ner && .venv-ner/bin/pip install "optimum[onnxruntime]" torch
  .venv-ner/bin/python scripts/convert-ner.py
"""

import hashlib
import json
import pathlib
import shutil
import sys
import tempfile

from onnxruntime.quantization import QuantType, quantize_dynamic
from optimum.exporters.onnx import main_export

MODEL_ID = "tsmatz/xlm-roberta-ner-japanese"
REVISION = "aba094e118d5ffc622e9b25e07edc49f9dd85feb"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "models" / MODEL_ID
COPY_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = pathlib.Path(tmp)
        main_export(MODEL_ID, output=tmp_dir, task="token-classification", revision=REVISION)
        (OUT / "onnx").mkdir(parents=True, exist_ok=True)
        for name in COPY_FILES:
            if (tmp_dir / name).exists():
                shutil.copy(tmp_dir / name, OUT / name)
        quantized = OUT / "onnx" / "model_quantized.onnx"
        quantize_dynamic(tmp_dir / "model.onnx", quantized, weight_type=QuantType.QUInt8)

    manifest = {
        "model": MODEL_ID,
        "revision": REVISION,
        "license": "MIT",
        "files": {
            str(p.relative_to(OUT)): sha256(p) for p in sorted(OUT.rglob("*")) if p.is_file() and p.name != "manifest.json"
        },
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"配置しました: {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
