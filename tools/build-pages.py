#!/usr/bin/env python3
"""tools/template.html から3製品のページを生成する（python3 tools/build-pages.py）"""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
tpl = (root / "tools" / "template.html").read_text(encoding="utf-8")
products = {
    "getback": ("GetBack Clone", "研究・検証用の実験的再現です。原製品・特許権者とは無関係です。"),
    "kamae": ("KAMAE Lite", "KAMAE by STONY &amp; Co."),
    "kamae-ai": ("KAMAE AI", "KAMAE by STONY &amp; Co."),
}
for pid, (name, foot) in products.items():
    out = root / pid / "index.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(tpl.replace("{{ID}}", pid).replace("{{NAME}}", name).replace("{{FOOT}}", foot), encoding="utf-8")
    print("wrote", out.relative_to(root))
