#!/usr/bin/env python3
"""Extract text from OOXML without executing macros or embedded objects.

This helper intentionally reads only the XML parts used for visible text. It
does not open external relationships, execute VBA, or materialize embedded
objects. All archive and output limits are enforced before returning text.
"""

import io
import re
import sys
import zipfile
from pathlib import Path
from xml.parsers import expat


class _Element:
    """Small ElementTree-compatible view built by the safe Expat parser."""

    def __init__(self, tag: str, attrib: dict[str, str]):
        self.tag = tag
        self.attrib = attrib
        self.text = None
        self._text_parts = []
        self._children = []

    def __iter__(self):
        return iter(self._children)

    def iter(self):
        yield self
        for child in self._children:
            yield from child.iter()


class _SafeElementTree:
    """ElementTree-compatible facade with parser-level DTD/entity rejection."""

    @staticmethod
    def fromstring(data: bytes):
        root = None
        stack = []
        parser = expat.ParserCreate(namespace_separator="}")

        def unsafe(*_args):
            raise RuntimeError("UNSAFE_XML_DECLARATION")

        parser.StartDoctypeDeclHandler = unsafe
        parser.EntityDeclHandler = unsafe
        parser.ExternalEntityRefHandler = unsafe
        parser.SkippedEntityHandler = unsafe
        parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
        parser.buffer_text = True

        def start(name, attrs):
            nonlocal root
            element = _Element(name, dict(attrs))
            if stack:
                stack[-1]._children.append(element)
            elif root is not None:
                raise RuntimeError("OOXML_XML_INVALID")
            else:
                root = element
            stack.append(element)

        def end(_name):
            if not stack:
                raise RuntimeError("OOXML_XML_INVALID")
            element = stack.pop()
            if element._text_parts:
                element.text = "".join(element._text_parts)

        def character_data(value):
            if stack:
                stack[-1]._text_parts.append(value)

        parser.StartElementHandler = start
        parser.EndElementHandler = end
        parser.CharacterDataHandler = character_data
        try:
            parser.Parse(data, True)
        except RuntimeError:
            raise
        except expat.ExpatError as error:
            raise RuntimeError("OOXML_XML_INVALID") from error
        if root is None or stack:
            raise RuntimeError("OOXML_XML_INVALID")
        return root


# Tests may replace this narrow facade with a synthetic tree, while production
# always uses the encoding-aware Expat parser above.
ET = _SafeElementTree

MAX_FILES = 20_000
MAX_TOTAL_UNCOMPRESSED = 128 * 1024 * 1024
MAX_RATIO = 200.0


class OutputBudget:
    def __init__(self, limit: int):
        self.limit = limit
        self._buffer = io.StringIO()
        self.size = 0

    @property
    def remaining(self) -> int:
        return self.limit - self.size

    def append(self, value: str):
        self.append_slice(value, 0, len(value))

    def append_slice(self, value: str, start: int, end: int):
        if self.remaining <= 0 or start >= end:
            return
        end = min(end, start + self.remaining)
        part = value[start:end]
        if part:
            self._buffer.write(part)
            self.size += len(part)

    def build(self) -> str:
        return self._buffer.getvalue()


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


def xml_text_parts(data: bytes):
    root = ET.fromstring(data)
    for elem in root.iter():
        local = elem.tag.rsplit("}", 1)[-1]
        if local not in {"t", "v", "f", "instrText"} or not elem.text:
            continue
        value = elem.text
        start = 0
        end = len(value)
        while start < end and value[start].isspace():
            start += 1
        while end > start and value[end - 1].isspace():
            end -= 1
        if start < end:
            yield value, start, end


def append_xml_text(writer: OutputBudget, data: bytes, prefix: str = "") -> bool:
    parts = iter(xml_text_parts(data))
    first = next(parts, None)
    if first is None:
        return False
    writer.append(prefix)
    writer.append_slice(*first)
    for value, start, end in parts:
        if writer.remaining <= 0:
            break
        writer.append(" ")
        writer.append_slice(value, start, end)
    return True


def docx(zf, member_limit: int, max_chars: int):
    writer = OutputBudget(max_chars)
    has_content = False
    for name in zf.namelist():
        if writer.remaining <= 0:
            break
        if name != "word/document.xml" and not re.match(r"word/(header|footer)\d+\.xml$", name):
            continue
        data = read_member(zf, name, member_limit)
        if append_xml_text(writer, data, "\n" if has_content else ""):
            has_content = True
    return writer.build()


def xlsx(zf, member_limit: int, max_chars: int):
    shared = []
    if "xl/sharedStrings.xml" in zf.namelist():
        data = read_member(zf, "xl/sharedStrings.xml", member_limit)
        root = ET.fromstring(data)
        for si in root.iter():
            if si.tag.rsplit("}", 1)[-1] == "si":
                shared.append(si)
    writer = OutputBudget(max_chars)
    has_sheet_block = False
    sheets = sorted(n for n in zf.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
    for sheet in sheets:
        if writer.remaining <= 0:
            break
        data = read_member(zf, sheet, member_limit)
        root = ET.fromstring(data)
        sheet_has_rows = False
        stop = False
        for row in root.iter():
            if row.tag.rsplit("}", 1)[-1] != "row":
                continue
            row_has_cells = False
            for cell in row:
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
                if not row_has_cells:
                    if not sheet_has_rows:
                        prefix = ("\n\n" if has_sheet_block else "") + f"[{Path(sheet).stem}]\n"
                        writer.append(prefix)
                        has_sheet_block = True
                        if writer.remaining <= 0:
                            stop = True
                            break
                    else:
                        writer.append("\n")
                        if writer.remaining <= 0:
                            stop = True
                            break
                    row_has_cells = True
                    sheet_has_rows = True
                else:
                    writer.append("\t")
                    if writer.remaining <= 0:
                        stop = True
                        break
                if kind == "s":
                    try:
                        index = int(value)
                        if index < 0:
                            raise IndexError
                        shared_value = shared[index]
                    except (ValueError, IndexError):
                        writer.append(str(value))
                    else:
                        for element in shared_value.iter():
                            if element.tag.rsplit("}", 1)[-1] == "t" and element.text:
                                writer.append(element.text)
                                if writer.remaining <= 0:
                                    break
                else:
                    writer.append(str(value))
                if writer.remaining <= 0:
                    stop = True
                    break
            if stop:
                break
    return writer.build()


def pptx(zf, member_limit: int, max_chars: int):
    slides = sorted(
        (n for n in zf.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
        key=lambda n: int(re.search(r"(\d+)", Path(n).stem).group(1)),
    )
    writer = OutputBudget(max_chars)
    has_slide = False
    for index, name in enumerate(slides, 1):
        if writer.remaining <= 0:
            break
        data = read_member(zf, name, member_limit)
        prefix = ("\n\n" if has_slide else "") + f"[Slide {index}]\n"
        if append_xml_text(writer, data, prefix):
            has_slide = True
    return writer.build()


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
