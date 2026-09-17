# -*- coding: utf-8 -*-
"""
把「本科生学业竞赛项目库」之类的 PDF 抽成纯文本，交给 parse-pdf-text.js。

依赖 pypdf（不进项目依赖，装在隔离的 venv 里即可）：
    <venv>/Scripts/pip install pypdf

用法：
    python extract-pdf.py "D:/下载/某某项目库.pdf" > pdf-out.txt
"""
import io
import os
import sys

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    pdf = sys.argv[1]
    if not os.path.exists(pdf):
        print("找不到文件：%s" % pdf)
        return 1

    try:
        from pypdf import PdfReader
    except ImportError:
        print("缺 pypdf，先装：pip install pypdf")
        return 1

    out = io.StringIO()
    reader = PdfReader(pdf)
    for i, page in enumerate(reader.pages):
        out.write("\n===== PAGE %d =====\n" % (i + 1))
        out.write(page.extract_text() or "")
    sys.stdout.write(out.getvalue())
    return 0

if __name__ == '__main__':
    sys.exit(main())
