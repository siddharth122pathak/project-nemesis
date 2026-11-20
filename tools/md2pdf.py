"""Converts a markdown file to PDF (via headless Chromium). Usage: python3 tools/md2pdf.py docs/MILESTONE2.md"""
import os, subprocess, sys, markdown
src = os.path.abspath(sys.argv[1])
html = markdown.markdown(open(src).read(), extensions=["tables", "fenced_code"])
css = """body{font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:10.5pt;line-height:1.45;max-width:780px;margin:auto;color:#1b1f23}
h1{font-size:20pt;border-bottom:2px solid #e04848;padding-bottom:4px}h2{font-size:14pt;margin-top:22px;color:#b02a2a}h3{font-size:12pt}
table{border-collapse:collapse;margin:8px 0;font-size:9pt;width:100%}th,td{border:1px solid #ccd;padding:3px 6px;text-align:left}th{background:#f2f4f7}
img{max-width:100%;margin:6px 0;page-break-inside:avoid}code{background:#f2f4f7;padding:0 3px;border-radius:3px;font-size:9pt}"""
page = os.path.splitext(src)[0] + ".html"
open(page, "w").write(f"<html><head><meta charset='utf-8'><style>{css}</style></head><body>{html}</body></html>")
pdf = os.path.splitext(src)[0] + ".pdf"
js = f"""const {{chromium}}=require('playwright');(async()=>{{const b=await chromium.launch();const p=await b.newPage();
await p.goto('file://{page}');await p.waitForTimeout(500);await p.pdf({{path:'{pdf}',format:'Letter',margin:{{top:'0.6in',bottom:'0.6in',left:'0.6in',right:'0.6in'}}}});await b.close();}})();"""
subprocess.run(["node", "-e", js], check=True, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.remove(page)
print("wrote", pdf)
