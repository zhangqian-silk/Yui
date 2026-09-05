#!/usr/bin/env python3
"""Build a self-contained HTML reader from the handbook's Markdown documents.
Produces index.html and full-architecture.html.
Requires: pandoc on PATH; Python packages beautifulsoup4.
Run from any directory: python tools/build_html.py
After rebuilding: python tools/check_docs.py --write-manifest --typecheck --write-result
"""
from __future__ import annotations
import html
import re
import shutil
import subprocess
import unicodedata
from pathlib import Path
from urllib.parse import unquote, urlsplit
from bs4 import BeautifulSoup

ROOT=Path(__file__).resolve().parents[1]

def doc_id(path: Path) -> str:
    return 'doc-'+re.sub(r'[^a-zA-Z0-9_-]+','-',path.relative_to(ROOT).as_posix())

def document_groups():
    return [
        ('入口',[ROOT/'README.md']),
        ('总体架构',sorted((ROOT/'architecture').glob('*.md'))),
        ('模块设计',[ROOT/'modules/README.md']+sorted(p for p in (ROOT/'modules').glob('*.md') if p.name!='README.md')),
        ('接口约定',sorted((ROOT/'contracts').glob('*.md'))),
        ('实施路线',[ROOT/'implementation/README.md']),
        ('任务定义',sorted((ROOT/'implementation/tasks').glob('*.md'))),
        ('技术方案',sorted((ROOT/'implementation/designs').glob('*.md'))),
        ('参考与验收',sorted((ROOT/'reference').glob('*.md'))),
    ]

def render_diagram(text: str) -> str:
    # Explicit display cells keep CJK/ASCII boxes aligned across font fallbacks.
    # These are selectable text, not images or canvas content.
    out=[]
    for char in text.expandtabs(4):
        if ord(char)<128:
            out.append(html.escape(char)); continue
        width=0 if unicodedata.combining(char) else (2 if unicodedata.east_asian_width(char) in ('W','F') else 1)
        if width==0: out.append(html.escape(char)); continue
        cls='dcell dwide' if width==2 else 'dcell'
        out.append(f'<span class="{cls}">{html.escape(char)}</span>')
    return ''.join(out)

CSS=r'''
.full-architecture-section{background:#fff;border:2px solid #164b73;border-radius:8px;padding:22px 24px;margin:0 0 28px;scroll-margin-top:18px;min-width:0}
.full-architecture-section h2{margin:0 0 12px;border:0;padding:0;font-size:25px}
.full-architecture-section .diagram-intro,.full-architecture-section .diagram-note{font-size:14px;line-height:1.7}
.quickmap .primary-link{background:#fff;color:#163e60;font-weight:700}
.full-diagram-nav a{display:block;padding:9px 10px;border:1px solid #164b73;border-radius:5px;font-weight:700}

:root{color-scheme:light;--ink:#1b2a3c;--muted:#586779;--line:#dce2e8;--accent:#164b73}
*{box-sizing:border-box}html{scroll-padding-top:24px}body{margin:0;color:var(--ink);background:#f7f9fb;font-family:system-ui,-apple-system,"Noto Sans CJK SC","Microsoft YaHei",sans-serif;line-height:1.8}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}nav{position:fixed;inset:0 auto 0 0;width:285px;overflow:auto;padding:24px 20px;background:#fff;border-right:1px solid var(--line);font-size:13px}
nav h2{font-size:19px;margin:0 0 4px}nav p{color:var(--muted);margin-top:0}nav ul{list-style:none;margin:8px 0 16px;padding-left:10px}nav li{margin:5px 0}summary{font-weight:700;cursor:pointer;font-size:14px}
main{margin-left:285px;padding:30px 34px;max-width:1300px}header{margin-bottom:24px;padding:24px 30px;background:#163e60;color:white;border-radius:8px}header h1{margin:0 0 10px;font-size:29px}header p{margin:0}.quickmap{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.quickmap a{display:inline-block;color:#fff;border:1px solid #839eb5;border-radius:5px;padding:5px 12px;font-size:14px}
article{background:white;border:1px solid var(--line);border-radius:8px;padding:26px 30px;margin:28px 0;scroll-margin-top:18px;min-width:0}.source{font-size:12px;color:var(--muted)}article h1{font-size:28px;line-height:1.35;margin:18px 0 26px}h2{font-size:21px;border-bottom:1px solid var(--line);padding-bottom:6px;margin-top:34px}h3{font-size:18px;margin-top:26px}p{margin:13px 0}
pre{overflow:auto;max-width:100%;background:#f2f5f8;border:1px solid var(--line);border-radius:5px;padding:16px;line-height:1.6;font-size:13px}code{font-family:ui-monospace,SFMono-Regular,Consolas,"DejaVu Sans Mono",monospace;font-variant-ligatures:none;letter-spacing:0}pre code{font-size:inherit;line-height:inherit;white-space:pre;word-break:normal;overflow-wrap:normal}.dcell{display:inline-block;width:1ch;text-align:center;vertical-align:baseline}.dcell.dwide{width:2ch}
pre.diagram{font-size:14px;line-height:1.45}pre.diagram code{display:block;width:max-content;margin-inline:auto}
p code,li code{background:#f0f3f6;padding:1px 4px;border-radius:3px}table{border-collapse:collapse;width:100%;display:block;overflow:auto;margin:20px 0;font-size:14px}th,td{border:1px solid var(--line);padding:9px 12px;text-align:left;vertical-align:top}th{background:#edf3f7}blockquote{margin:20px 0;border-left:4px solid var(--accent);background:#f3f7fa;padding:8px 20px}ul,ol{padding-left:25px}li{margin:6px 0}
@media(max-width:960px){nav{position:relative;width:100%;max-height:380px;border-bottom:1px solid var(--line)}main{margin:0;padding:12px}article{padding:18px}header{padding:20px}.quickmap{gap:6px}}
@media print{nav,.source,.quickmap{display:none}main{margin:0;padding:0;max-width:none}body{background:white}article{border:0;break-before:page;padding:0}pre,table{overflow:visible}pre{font-size:10px}a{color:inherit}}
'''

def main():
    if not shutil.which('pandoc'): raise SystemExit('pandoc is required to build HTML')
    groups=document_groups()
    paths=[p for _,items in groups for p in items]
    all_md=set(ROOT.rglob('*.md'))
    if set(paths)!=all_md: raise SystemExit('Document groups do not cover all Markdown files')
    titles={};articles=[];overview_heads=[];full_diagram=None
    for path in paths:
        raw=path.read_text(encoding='utf-8')
        match=re.search(r'^#\s+(.+)$',raw,re.M)
        titles[path]=match.group(1) if match else path.stem
        proc=subprocess.run(['pandoc','--from=markdown','--to=html5','--wrap=none'],input=raw,text=True,capture_output=True,check=True,timeout=20)
        soup=BeautifulSoup(proc.stdout,'html.parser')
        prefix=doc_id(path)
        for tag in soup.find_all(id=True): tag['id']=prefix+'--'+tag['id']
        for tag in soup.find_all('a',href=True):
            target=tag['href'];parsed=urlsplit(target)
            if parsed.scheme or parsed.netloc: continue
            if not parsed.path:
                if parsed.fragment: tag['href']='#'+prefix+'--'+unquote(parsed.fragment)
                continue
            resolved=(path.parent/unquote(parsed.path)).resolve()
            if resolved in all_md:
                tag['href']='#'+doc_id(resolved)+(('--'+unquote(parsed.fragment)) if parsed.fragment else '')
            elif resolved==ROOT/'index.html': tag['href']='#top'
            else:
                if not resolved.is_relative_to(ROOT): raise ValueError(f'Path escapes package: {target}')
                tag['href']=resolved.relative_to(ROOT).as_posix()+(('#'+parsed.fragment) if parsed.fragment else '')
        for pre in soup.find_all('pre'):
            classes=pre.get('class',[])
            code=pre.find('code')
            if code is None: continue
            if 'text' in classes:
                original=code.get_text()
                code.clear()
                converted=BeautifulSoup('<pre><code>'+render_diagram(original)+'</code></pre>','html.parser').code
                for node in list(converted.contents): code.append(node.extract())
                pre['class']=classes+['diagram']
        if path==ROOT/'architecture/01-overview.md':
            overview_heads=[(h.get_text(),h['id']) for h in soup.find_all('h2',id=True)]
            full_heading=next(h for h in soup.find_all('h2') if '逻辑分层图' in h.get_text())
            full_diagram=str(full_heading.find_next('pre'))
        source=html.escape(path.relative_to(ROOT).as_posix(),quote=True)
        articles.append(f'<article id="{prefix}"><div class="source"><a href="{source}">Markdown 源文件</a> · <a href="#top">回到总览</a></div>{soup}</article>')
    quick=['<a class="primary-link" href="#full-architecture">完整架构图</a>','<a href="full-architecture.html">单独打开完整架构图</a>']
    for marker,label in [('2.','工作关系'),('3.','逻辑分层'),('5.','模块映射'),('6.','事实流'),('7.','热重载边界')]:
        dest=next(i for text,i in overview_heads if text.startswith(marker))
        quick.append(f'<a href="#{html.escape(dest,quote=True)}">{label}</a>')
    nav=['<nav aria-label="文档目录"><h2>Yui 设计手册</h2><p>架构 · 模块 · 契约 · 实施</p><p class="full-diagram-nav"><a href="#full-architecture">完整架构分层图</a></p>']
    for name,items in groups:
        nav.append(f'<details open><summary>{name}</summary><ul>')
        for path in items: nav.append(f'<li><a href="#{doc_id(path)}">{html.escape(titles[path])}</a></li>')
        nav.append('</ul></details>')
    nav.append('</nav>')
    heading='<header><h1>Yui 架构与实施手册</h1><p>工作关系说明谁负责；逻辑分层说明能力如何承接；模块说明实现归属。</p><div class="quickmap">'+''.join(quick)+'</div></header>'
    if full_diagram is None:
        raise ValueError('Complete architecture diagram not found in architecture/01-overview.md')
    for term in ('Experience Plane','Intelligence Plane','Capability Plane','Execution Plane','Minimal Kernel','Plugin Fabric'):
        if term not in full_diagram:
            raise ValueError('Incomplete architecture diagram: '+term)
    diagram_intro='<p class="diagram-intro">四个逻辑层、一个最小内核，以及贯穿各层的插件机制。图中能力是目标设计，实际可用范围以启用并验证的实现为准。</p>'
    diagram_footer='<p class="diagram-note">向下箭头表示主要使用关系，不是强制流水线：确定的 CLI／API 操作可以直接进入能力层，查询直接读取事实。Plugin Fabric 贯穿各层，不是下一层。</p>'
    diagram_section='<section id="full-architecture" class="full-architecture-section" aria-labelledby="full-architecture-title"><h2 id="full-architecture-title">完整架构分层图</h2>'+diagram_intro+full_diagram+diagram_footer+'<p><a href="full-architecture.html">单独打开此图</a> · <a href="#doc-architecture-01-overview-md">阅读架构说明与工作关系图</a></p></section>'
    standalone_css=CSS+'''
body.standalone{background:#f7f9fb}
body.standalone main{margin:0 auto;padding:24px;max-width:1060px}
body.standalone header{padding:18px 24px;margin:0 0 20px}
body.standalone header h1{font-size:27px;margin:0 0 6px}
body.standalone .full-architecture-section{margin:0;padding:20px 24px}
body.standalone pre.diagram{font-size:14px;line-height:1.48}
body.standalone .page-links{font-size:14px;margin:12px 0 0}
@media(max-width:760px){body.standalone main{padding:12px}body.standalone .full-architecture-section{padding:12px}body.standalone pre.diagram{font-size:12px}}
'''
    standalone_head='<header><h1>Yui 完整架构分层图</h1><p>Experience → Intelligence → Capability → Execution → Minimal Kernel</p></header>'
    standalone_body='<section id="full-architecture" class="full-architecture-section">'+diagram_intro+full_diagram+diagram_footer+'<p class="page-links"><a href="index.html#full-architecture">完整手册</a> · <a href="index.html#doc-architecture-01-overview-md">架构正文</a></p></section>'
    standalone='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yui 完整架构分层图</title><style>'+standalone_css+'</style></head><body class="standalone"><main>'+standalone_head+standalone_body+'</main></body></html>\n'
    (ROOT/'full-architecture.html').write_text(standalone,encoding='utf-8')
    result='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yui 架构与实施手册</title><style>'+CSS+'</style></head><body>'+''.join(nav)+'<main id="top">'+heading+diagram_section+''.join(articles)+'</main></body></html>\n'
    (ROOT/'index.html').write_text(result,encoding='utf-8')
    print(f'Built {len(paths)} documents into index.html ({len(result.encode()):,} bytes)')

if __name__=='__main__':main()
