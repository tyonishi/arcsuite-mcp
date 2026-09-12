#!/usr/bin/env python3
"""Extract text from OOXML without executing macros or embedded objects.

This helper intentionally reads only the XML parts used for visible text. It
does not open external relationships, execute VBA, or materialize embedded
objects. All archive and output limits are enforced before returning text.
"""

import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAX_FILES = 20_000
MAX_TOTAL_UNCOMPRESSED = 128 * 1024 * 1024
MAX_RATIO = 200.0


def bounded_text(value: str, limit: int) -> str:
    return value[:limit]


def safe_zip(path: str, max_chars: int):
    archive_size = Path(path).stat().st_size
    if archive_size > 50 * 1024 * 1024:
        raise RuntimeError("OOXML_ARCHIVE_SIZE_LIMIT")
    max_uncompressed = min(MAX_TOTAL_UNCOMPRESSED, max(8 * 1024 * 1024, max_chars * 16))
    zf = zipfile.ZipFile(path)
    infos = zf.infolist()
    if len(infos) > MAX_FILES:
        raise RuntimeError("OOXML_ZIP_TOO_MANY_FILES")
    total = 0
    for info in infos:
        total += info.file_size
        if total > max_uncompressed:
            raise RuntimeError("OOXML_ZIP_UNCOMPRESSED_LIMIT")
        ratio = info.file_size / max(1, info.compress_size)
        if ratio > MAX_RATIO and info.file_size > 1024 * 1024:
            raise RuntimeError("OOXML_ZIP_SUSPICIOUS_RATIO")
        name = info.filename.replace("\\", "/")
        if name.startswith("/") or "../" in name:
            raise RuntimeError("OOXML_ZIP_UNSAFE_PATH")
    return zf, max_uncompressed


def read_member(zf, name: str, max_bytes: int) -> bytes:
    try:
        info = zf.getinfo(name)
    except KeyError:
        raise RuntimeError("OOXML_MEMBER_NOT_FOUND")
    if info.file_size > max_bytes:
        raise RuntimeError("OOXML_MEMBER_SIZE_LIMIT")
    with zf.open(info, "r") as stream:
        data = stream.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise RuntimeError("OOXML_MEMBER_SIZE_LIMIT")
    return data


def xml_text(data: bytes, limit: int):
    head = data[:65536].upper()
    if b"<!DOCTYPE" in head or b"<!ENTITY" in head:
        raise RuntimeError("UNSAFE_XML_DECLARATION")
    root = ET.fromstring(data)
    parts = []
    size = 0
    for elem in root.iter():
        if elem.text and elem.text.strip():
            local = elem.tag.rsplit("}", 1)[-1]
            if local in {"t", "v", "f", "instrText"}:
                part = elem.text.strip()
                remaining = limit - size
                if remaining <= 0:
                    break
                parts.append(part[:remaining])
                size += len(parts[-1]) + 1
    return bounded_text(" ".join(parts), limit)


def docx(zf, member_limit: int, max_chars: int):
    names = [n for n in zf.namelist() if n == "word/document.xml" or re.match(r"word/(header|footer)\d+\.xml$", n)]
    out = []
    for name in names:
        out.append(xml_text(read_member(zf, name, member_limit), max_chars))
    return bounded_text("\n".join(x for x in out if x), max_chars)


def xlsx(zf, member_limit: int, max_chars: int):
    shared = []
    if "xl/sharedStrings.xml" in zf.namelist():
        data = read_member(zf, "xl/sharedStrings.xml", member_limit)
        if b"<!DOCTYPE" in data[:65536].upper() or b"<!ENTITY" in data[:65536].upper():
            raise RuntimeError("UNSAFE_XML_DECLARATION")
        root = ET.fromstring(data)
        used = 0
        for si in root.iter():
            if si.tag.rsplit("}", 1)[-1] == "si":
                value = "".join(e.text or "" for e in si.iter() if e.tag.rsplit("}", 1)[-1] == "t")
                if used < max_chars:
                    shared.append(bounded_text(value, max_chars - used))
                    used += len(shared[-1])
    out = []
    used = 0
    sheets = sorted(n for n in zf.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
    for sheet in sheets:
        data = read_member(zf, sheet, member_limit)
        if b"<!DOCTYPE" in data[:65536].upper() or b"<!ENTITY" in data[:65536].upper():
            raise RuntimeError("UNSAFE_XML_DECLARATION")
        root = ET.fromstring(data)
        rows = []
        for row in root.iter():
            if row.tag.rsplit("}", 1)[-1] != "row":
                continue
            cells = []
            for cell in list(row):
                if cell.tag.rsplit("}", 1)[-1] != "c":
                    continue
                kind = cell.attrib.get("t")
                value = None
                for child in cell.iter():
                    if child.tag.rsplit("}", 1)[-1] == "v":
                        value = child.text
                        break
                if value is None:
                    continue
                if kind == "s":
                    try:
                        value = shared[int(value)]
                    except (ValueError, IndexError):
                        pass
                cells.append(str(value))
            if cells:
                rows.append("\t".join(cells))
        if rows:
            block = f"[{Path(sheet).stem}]\n" + "\n".join(rows)
            remaining = max_chars - used
            if remaining <= 0:
                break
            out.append(block[:remaining])
            used += len(out[-1])
    return bounded_text("\n\n".join(out), max_chars)


def pptx(zf, member_limit: int, max_chars: int):
    slides = sorted(
        (n for n in zf.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
        key=lambda n: int(re.search(r"(\d+)", Path(n).stem).group(1)),
    )
    out = []
    used = 0
    for index, name in enumerate(slides, 1):
        text = xml_text(read_member(zf, name, member_limit), max_chars)
        block = f"[Slide {index}]\n{text}" if text else ""
        remaining = max_chars - used
        if remaining <= 0:
            break
        out.append(block[:remaining])
        used += len(out[-1])
    return bounded_text("\n\n".join(x for x in out if x), max_chars)


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: ooxml_extract.py <file> <docx|xlsx|pptx> <max_chars>")
    path, kind = sys.argv[1], sys.argv[2]
    try:
        max_chars = int(sys.argv[3])
    except ValueError:
        raise SystemExit("max_chars must be an integer")
    if max_chars < 1 or max_chars > 10_000_000:
        raise SystemExit("max_chars out of range")
    zf, max_uncompressed = safe_zip(path, max_chars)
    member_limit = min(max_uncompressed, max(8 * 1024 * 1024, max_chars * 16))
    try:
        if kind == "docx":
            result = docx(zf, member_limit, max_chars)
        elif kind == "xlsx":
            result = xlsx(zf, member_limit, max_chars)
        elif kind == "pptx":
            result = pptx(zf, member_limit, max_chars)
        else:
            raise RuntimeError("OOXML_UNSUPPORTED_KIND")
    finally:
        zf.close()
    sys.stdout.write(result)


if __name__ == "__main__":
    main()
