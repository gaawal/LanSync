#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 LanSync 演示数据（纯标准库，不需要额外依赖）。

用法:
    python tools/make-demo-data.py <目标目录>

会在 <目标目录>/shared/ 下写出 files.json / files/ / docs/，
内容是一批示例文件（docx / xlsx / png / md / txt），
配合 tools/screenshots.js 可重新生成 README 里的界面截图。
"""
import hashlib
import json
import os
import shutil
import struct
import sys
import time
import zipfile
import zlib

PLAN = [
    ('产品设计方案.docx', 'Mac · 设计组'),
    ('项目排期.xlsx', 'Windows · 项目组'),
    ('团队合影.png', 'Mac · 设计组'),
    ('会议纪要.md', 'Windows · 项目组'),
    ('部署说明.txt', 'Mac · 运维'),
]

TEXT_EXTS = ('.md', '.txt', '.json', '.csv', '.log', '.js', '.ts', '.py', '.html', '.css')


# ---------------------------------------------------------------- 文件生成
def make_png(path, w=720, h=460):
    """一张示意图：渐变天空 + 太阳 + 山丘。"""
    def px(x, y):
        horizon = 300
        if y < horizon:
            t = y / horizon
            r, g, b = int(120 + 120 * (1 - t)), int(170 + 60 * (1 - t)), int(240 - 20 * t)
            dx, dy = x - 560, y - 90
            dist = (dx * dx + dy * dy) ** 0.5
            if dist < 46:
                return 255, 246, 208
            if dist < 62:
                k = (62 - dist) / 16
                return (int(r + (255 - r) * k), int(g + (246 - g) * k), int(b + (208 - b) * k))
            return r, g, b
        hill = 300 + 42 * ((x - 260) / 260) ** 2 if x < 520 else 300 + 42 * ((x - 520) / 200) ** 2
        if y < hill:
            return 86, 130, 92
        k = (y - horizon) / (h - horizon)
        return int(92 + 40 * k), int(150 + 30 * k), int(88 + 30 * k)

    raw = b''.join(b'\x00' + b''.join(bytes(px(x, y)) for x in range(w)) for y in range(h))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 6)))
        f.write(chunk(b'IEND', b''))


def make_docx(path, paragraphs):
    """最小可用的 docx（Word 能打开，docx-preview / mammoth 也能解析）。"""
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>')
    body = ''.join('<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % t for t in paragraphs)
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body>%s</w:body></w:document>' % body)
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', rels)
        z.writestr('word/document.xml', doc)


def make_xlsx(path, sheets):
    """最小 xlsx（inlineStr，SheetJS 可直接读取）。sheets = [(表名, 二维数组), ...]"""
    def esc(s):
        return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

    def col(i):
        s = ''
        i += 1
        while i:
            i, r = divmod(i - 1, 26)
            s = chr(65 + r) + s
        return s

    def sheet_xml(rows):
        out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>']
        for ri, row in enumerate(rows, 1):
            out.append('<row r="%d">' % ri)
            for ci, val in enumerate(row):
                out.append('<c r="%s%d" t="inlineStr"><is><t>%s</t></is></c>' % (col(ci), ri, esc(val)))
            out.append('</row>')
        out.append('</sheetData></worksheet>')
        return ''.join(out)

    types = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             '<Default Extension="xml" ContentType="application/xml"/>'
             '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>']
    for i in range(len(sheets)):
        types.append('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (i + 1))
    types.append('</Types>')

    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
          + ''.join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (esc(n), i + 1, i + 1)
                    for i, (n, _) in enumerate(sheets))
          + '</sheets></workbook>')

    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               + ''.join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>' % (i + 1, i + 1)
                         for i in range(len(sheets)))
               + '</Relationships>')

    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                 '</Relationships>')

    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('[Content_Types].xml', ''.join(types))
        z.writestr('_rels/.rels', root_rels)
        z.writestr('xl/workbook.xml', wb)
        z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
        for i, (_, rows) in enumerate(sheets):
            z.writestr('xl/worksheets/sheet%d.xml' % (i + 1), sheet_xml(rows))


# ---------------------------------------------------------------- 数据布局
def build(target):
    src = os.path.join(target, 'demo')
    shared = os.path.join(target, 'shared')
    files_dir = os.path.join(shared, 'files')
    docs_dir = os.path.join(shared, 'docs')

    os.makedirs(src, exist_ok=True)
    for d in (files_dir, docs_dir):
        if os.path.isdir(d):
            shutil.rmtree(d)
        os.makedirs(d, exist_ok=True)

    make_docx(os.path.join(src, '产品设计方案.docx'), [
        '产品设计方案（第一版）',
        '一、目标：让同一局域网内的 Mac 与 Windows 互传文件、协同编辑，无需互联网。',
        '二、核心能力：文件鱼池 / 实时协同 / Office 在线预览。',
        '三、下一步：补充移动端适配与批量下载。',
    ])
    make_xlsx(os.path.join(src, '项目排期.xlsx'), [
        ('本周任务', [
            ['任务', '负责人', '状态', '截止日期'],
            ['局域网双向传输实测', '小王', '已完成', '2026-09-25'],
            ['Office 预览扩展', '小李', '进行中', '2026-09-30'],
            ['macOS 版本打包', '小张', '待开始', '2026-10-08'],
            ['移动端适配', '小王', '待开始', '2026-10-15'],
        ]),
        ('版本记录', [
            ['版本', '日期', '说明'],
            ['v1.0.0', '2026-09-27', '首个版本：鱼池 + 协同 + 预览'],
        ]),
    ])
    make_png(os.path.join(src, '团队合影.png'))
    with open(os.path.join(src, '会议纪要.md'), 'w', encoding='utf-8') as f:
        f.write("""# 周会纪要 · 2026-09-27

## 讨论
- 局域网互传工具（LanSync）本周完成打包，产出单文件 `LanSync.exe`，无需安装 Node.js
- 鱼池视图：文件以小鱼形式游动，单击即打开预览或协同编辑

## 待办
1. [ ] Mac 与 Windows 双向传输实测
2. [ ] Office 预览适配更多格式
3. [ ] 打包 macOS 版本
""")
    with open(os.path.join(src, '部署说明.txt'), 'w', encoding='utf-8') as f:
        f.write("""LanSync 部署说明

1. 任选一台电脑双击 LanSync.exe（Windows）或 start.command（Mac）
2. 控制台会打印局域网地址，例如 http://192.168.1.13:7788
3. 局域网内其他设备用浏览器打开该地址即可
4. 首次运行如弹出防火墙提示，请勾选“允许访问”
""")

    meta, now = [], int(time.time() * 1000)
    for i, (name, uploader) in enumerate(PLAN):
        fid = hashlib.md5(name.encode('utf-8')).hexdigest()[:10]
        stored = fid + os.path.splitext(name)[1]
        shutil.copy2(os.path.join(src, name), os.path.join(files_dir, stored))
        meta.append({
            'id': fid, 'name': name, 'stored': stored,
            'size': os.path.getsize(os.path.join(files_dir, stored)),
            'uploader': uploader, 'time': now - (len(PLAN) - i) * 60000,
        })
        # 文本文件在上传时服务端会自动建协同文档（f-<fileId>），这里一并补上
        if os.path.splitext(name)[1].lower() in TEXT_EXTS:
            with open(os.path.join(src, name), encoding='utf-8') as f:
                content = f.read()
            with open(os.path.join(docs_dir, 'f-' + fid + '.json'), 'w', encoding='utf-8') as f:
                json.dump({'id': 'f-' + fid, 'name': name, 'content': content,
                           'boundFileId': fid, 'rich': False}, f, ensure_ascii=False)

    with open(os.path.join(shared, 'files.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print('演示数据已写入 %s' % shared)
    for m in meta:
        print('   %s  %s  %.1fKB  %s' % (m['id'], m['name'], m['size'] / 1024, m['uploader']))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('用法: python tools/make-demo-data.py <目标目录>')
        sys.exit(1)
    build(os.path.abspath(sys.argv[1]))
