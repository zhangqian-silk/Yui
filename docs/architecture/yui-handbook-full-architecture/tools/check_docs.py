#!/usr/bin/env python3
"""Validate the documentation package. This does not execute Yui behavior tests."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'MANIFEST.json', 'tools/verification.json'}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def files() -> list[Path]:
    return sorted(p for p in ROOT.rglob('*') if p.is_file()
                  and '__pycache__' not in p.parts)


def write_manifest() -> None:
    items = [{'path': p.relative_to(ROOT).as_posix(), 'bytes': p.stat().st_size,
              'sha256': digest(p)} for p in files()
             if p.relative_to(ROOT).as_posix() not in EXCLUDED]
    data = {'schema': 1, 'purpose': 'package-integrity',
            'excluded': sorted(EXCLUDED), 'files': items}
    (ROOT / 'MANIFEST.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def validate(require_types: bool = False) -> dict:
    errors: list[str] = []
    checks: dict = {}
    docs = sorted(ROOT.rglob('*.md'))
    required = ['README.md', 'index.html', 'full-architecture.html', 'contracts/model.ts', 'contracts/examples.ts',
                'implementation/task-index.json', 'reference/scenarios.json']
    for item in required:
        if not (ROOT / item).is_file():
            errors.append(f'missing file: {item}')
    checks['markdown_documents'] = len(docs)

    link_count = 0
    # These terms identify edition-comparison prose, not ordinary code migration.
    prohibited = ('本轮修订', '上一版文档', '上一个压缩包', '相比之前的压缩包',
                  'R1', 'R2', '修订摘要', '逐项复核报告', '文档补丁')
    for p in docs:
        text = p.read_text(encoding='utf-8')
        rel = p.relative_to(ROOT).as_posix()
        for term in prohibited:
            if term in text:
                errors.append(f'edition-dependent prose: {rel}: {term}')
        fence = None
        for line in text.splitlines():
            m = re.match(r'^\s*(`{3,}|~{3,})(.*)$', line)
            if m:
                mark = m.group(1)
                if fence is None:
                    fence = mark[0]
                elif fence == mark[0]:
                    fence = None
        if fence is not None:
            errors.append(f'unclosed code fence: {rel}')
        for match in re.finditer(r'\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)', text):
            target = match.group(1)
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith('#'):
                continue
            path = (p.parent / unquote(parsed.path)).resolve()
            link_count += 1
            if not path.is_relative_to(ROOT):
                errors.append(f'link outside package: {rel} -> {target}')
            elif not path.exists():
                errors.append(f'broken link: {rel} -> {target}')
    checks['relative_links'] = link_count
    checks['standalone_prose'] = 'checked'
    checks['code_fences'] = 'checked'

    # Check the generated offline reader as an artifact, not just Markdown links.
    class ReaderInspector(HTMLParser):
        def __init__(self):
            super().__init__()
            self.ids = []
            self.hrefs = []
            self.articles = []
            self.remote_assets = []
        def handle_starttag(self, tag, attrs):
            data = dict(attrs)
            if "id" in data:
                self.ids.append(data["id"])
            if tag == "article":
                self.articles.append(data.get("id"))
            if tag == "a" and "href" in data:
                self.hrefs.append(data["href"])
            asset = data.get("src") if tag in {"script", "img", "iframe"} else data.get("href") if tag == "link" else None
            if asset and urlsplit(asset).scheme in {"http", "https"}:
                self.remote_assets.append(asset)
    reader = ReaderInspector()
    reader.feed((ROOT/"index.html").read_text(encoding="utf-8"))
    if len(reader.ids) != len(set(reader.ids)):
        errors.append("duplicate HTML reader anchor IDs")
    expected_articles = {"doc-"+re.sub(r"[^a-zA-Z0-9_-]+", "-", p.relative_to(ROOT).as_posix()) for p in docs}
    if set(reader.articles) != expected_articles or len(reader.articles) != len(docs):
        errors.append("HTML reader does not contain exactly one article per Markdown document")
    for href in reader.hrefs:
        parsed = urlsplit(href)
        if parsed.scheme or parsed.netloc:
            continue
        if not parsed.path:
            if parsed.fragment and unquote(parsed.fragment) not in set(reader.ids):
                errors.append("broken HTML fragment: "+href)
        elif not (ROOT/unquote(parsed.path)).is_file():
            errors.append("broken HTML file reference: "+href)
    if reader.remote_assets:
        errors.append("HTML reader depends on remote assets")
    checks["offline_html"] = {"articles": len(reader.articles), "anchors": len(reader.ids), "remote_assets": len(reader.remote_assets)}

    # The complete layered diagram must be directly accessible and fully included.
    diagram_html = (ROOT/'full-architecture.html').read_text(encoding='utf-8')
    diagram_reader = ReaderInspector()
    diagram_reader.feed(diagram_html)
    layers = ['Experience Plane', 'Intelligence Plane', 'Capability Plane',
              'Execution Plane', 'Minimal Kernel', 'Plugin Fabric']
    for layer in layers:
        if layer not in diagram_html:
            errors.append('complete architecture diagram missing: '+layer)
    if 'full-architecture' not in reader.ids or 'full-architecture' not in diagram_reader.ids:
        errors.append('complete architecture diagram entry anchor missing')
    if diagram_reader.remote_assets:
        errors.append('standalone diagram depends on remote assets')
    if len(diagram_reader.ids) != len(set(diagram_reader.ids)):
        errors.append('duplicate standalone diagram IDs')
    for href in diagram_reader.hrefs:
        parsed = urlsplit(href)
        if parsed.scheme or parsed.netloc:
            continue
        if parsed.path and not (ROOT/unquote(parsed.path)).is_file():
            errors.append('broken standalone diagram file reference: '+href)
    checks['complete_architecture_diagram'] = {'layers': len(layers), 'standalone': True,
        'reader_entry': 'full-architecture', 'remote_assets': len(diagram_reader.remote_assets)}

    catalog = json.loads((ROOT/'implementation/task-index.json').read_text(encoding='utf-8'))
    tasks = catalog['tasks']
    ids = [t['id'] for t in tasks]
    if len(ids) != len(set(ids)) or set(ids) != {f'T{i:02}' for i in range(12)}:
        errors.append('task IDs must be unique T00..T11')
    byid = {t['id']: t for t in tasks}
    done, visiting = set(), set()
    def visit(tid: str) -> None:
        if tid in done:
            return
        if tid in visiting:
            errors.append(f'dependency cycle: {tid}'); return
        if tid not in byid:
            errors.append(f'unknown dependency: {tid}'); return
        visiting.add(tid)
        for dep in byid[tid]['requires']:
            visit(dep)
        visiting.remove(tid); done.add(tid)
    for tid in ids:
        visit(tid)
    for task in tasks:
        expected = task['requires']
        for field in ('task', 'design'):
            p = ROOT/'implementation'/task[field]
            if not p.exists():
                errors.append(f'missing {field}: {task["id"]}'); continue
            txt = p.read_text(encoding='utf-8')
            m = re.search(r'^硬依赖：([^\n]+)', txt, re.M)
            actual = re.findall(r'T\d{2}', m.group(1)) if m else None
            if actual != expected:
                errors.append(f'dependency header mismatch: {p.relative_to(ROOT)}')
    checks['task_dependency_dag'] = 'checked'
    checks['tasks'] = len(tasks)

    scenario_data = json.loads((ROOT/'reference/scenarios.json').read_text(encoding='utf-8'))
    scenarios = scenario_data['scenarios']
    sids = [s['id'] for s in scenarios]
    if len(sids) != len(set(sids)):
        errors.append('duplicate scenario ID')
    scenario_md = (ROOT/'reference/acceptance-scenarios.md').read_text(encoding='utf-8')
    for scenario in scenarios:
        sid = scenario['id']
        expected_owners = [t['id'] for t in tasks if sid in t['scenarios']]
        if scenario['tasks'] != expected_owners or not expected_owners:
            errors.append(f'scenario ownership mismatch: {sid}')
        if scenario['status'] != 'planned':
            errors.append(f'scenario must not claim execution: {sid}')
        if f'## {sid}｜' not in scenario_md:
            errors.append(f'missing scenario prose: {sid}')
    for task in tasks:
        for sid in task['scenarios']:
            if sid not in sids:
                errors.append(f'unknown scenario: {task["id"]} {sid}')
    checks['acceptance_scenarios'] = {'count': len(scenarios), 'status': 'planned'}

    caps = json.loads((ROOT/'contracts/capabilities.json').read_text(encoding='utf-8'))['capabilities']
    names = [c['name'] for c in caps]
    if len(names) != len(set(names)):
        errors.append('duplicate capability name')
    for cap in caps:
        if cap['effect'] not in {'query','local-mutation','external-operation'}:
            errors.append(f'unknown effect: {cap["name"]}')
        if cap['requestIdRequired'] != (cap['effect'] != 'query'):
            errors.append(f'request ID mismatch: {cap["name"]}')
    checks['capability_descriptors'] = len(caps)

    mf = ROOT/'MANIFEST.json'
    if mf.exists():
        declared = json.loads(mf.read_text(encoding='utf-8'))['files']
        actual = {p.relative_to(ROOT).as_posix() for p in files()
                  if p.relative_to(ROOT).as_posix() not in EXCLUDED}
        if actual != {x['path'] for x in declared}:
            errors.append('manifest file set mismatch')
        for item in declared:
            p = ROOT/item['path']
            if not p.is_file() or p.stat().st_size != item['bytes'] or digest(p) != item['sha256']:
                errors.append(f'manifest mismatch: {item["path"]}')
        checks['manifest'] = 'checked'
    else:
        errors.append('MANIFEST.json is missing')

    tsc = shutil.which('tsc')
    if require_types:
        if not tsc:
            errors.append('TypeScript compiler not found')
            checks['typescript'] = 'unavailable'
        else:
            cmd = [tsc, '--strict', '--noEmit', '--target', 'ES2022', '--module', 'commonjs',
                   'contracts/model.ts', 'contracts/examples.ts']
            proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, timeout=30)
            checks['typescript'] = 'passed' if proc.returncode == 0 else 'failed'
            if proc.returncode:
                errors.append(proc.stdout + proc.stderr)
    else:
        checks['typescript'] = 'not-run'

    return {'status': 'passed' if not errors else 'failed',
            'scope': 'documents-contracts-and-package-only',
            'yui_runtime_tests': 'not-run', 'checks': checks, 'errors': errors}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write-manifest', action='store_true')
    parser.add_argument('--typecheck', action='store_true')
    parser.add_argument('--write-result', action='store_true')
    args = parser.parse_args()
    if args.write_manifest:
        write_manifest()
    result = validate(args.typecheck)
    if args.write_result:
        (ROOT/'tools/verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'passed' else 1

if __name__ == '__main__':
    raise SystemExit(main())
