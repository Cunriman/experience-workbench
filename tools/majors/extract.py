"""
从教育部《普通高等学校本科专业目录（2024年）》PDF 里抽出专业清单。

用法：
    <venv>/Scripts/python.exe tools/majors/extract.py

输出：tools/majors/moe-2024.txt（纯文本，交给 parse.js 再解析）

为什么分两步：PDF 抽文本依赖 Python（pypdf），而后续解析/建库用 Node，
两边各用自己顺手的工具，中间用纯文本交接。
"""
import sys
import pathlib

try:
    from pypdf import PdfReader
except ImportError:
    print("缺少 pypdf。装一下：<venv>/Scripts/pip.exe install pypdf", file=sys.stderr)
    raise

HERE = pathlib.Path(__file__).resolve().parent
PDF = HERE / "moe-2024.pdf"
OUT = HERE / "moe-2024.txt"

if not PDF.exists():
    print(f"找不到 {PDF}", file=sys.stderr)
    sys.exit(1)

reader = PdfReader(str(PDF))
pages = []
for i, page in enumerate(reader.pages):
    # 按行还原：extract_text 出来的行结构就是表格的行，直接留换行
    pages.append(page.extract_text() or "")

text = "\n".join(pages)
OUT.write_text(text, encoding="utf-8")
print(f"页数 {len(reader.pages)}，字符 {len(text)}，已写入 {OUT}")
