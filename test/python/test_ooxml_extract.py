import io
import unittest
import zipfile
from unittest.mock import patch

from scripts import ooxml_extract


def xlsx_bytes(parts):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in parts.items():
            archive.writestr(name, value)
    return buffer.getvalue()


class FakeZipInfo:
    def __init__(self, name, data):
        self.filename = name
        self.file_size = len(data)
        self.compress_size = max(1, len(data))


class FakeZip:
    def __init__(self, parts):
        self.parts = parts
        self.infos = {name: FakeZipInfo(name, value) for name, value in parts.items()}
        self.opened = []

    def namelist(self):
        return list(self.parts)

    def getinfo(self, name):
        return self.infos[name]

    def open(self, info, _mode):
        self.opened.append(info.filename)
        return io.BytesIO(self.parts[info.filename])


class FakeElement:
    def __init__(self, tag, text=None, attrib=None, children=None, on_yield=None):
        self.tag = tag
        self.text = text
        self.attrib = attrib or {}
        self.children = children or []
        self.on_yield = on_yield

    def __iter__(self):
        for child in self.children:
            if self.on_yield:
                self.on_yield(child)
            yield child

    def iter(self):
        yield self
        for child in self:
            yield from child.iter()


class OoxmlXlsxTests(unittest.TestCase):
    def test_output_budget_coalesces_many_tiny_fragments(self):
        writer = ooxml_extract.OutputBudget(40_000)
        for _ in range(20_000):
            writer.append("x")
            writer.append("\t")

        self.assertEqual(writer.size, 40_000)
        self.assertEqual(writer.build(), "x\t" * 20_000)
        self.assertIsInstance(writer._buffer, io.StringIO)

    def test_small_shared_strings_and_sheet_order_are_preserved(self):
        parts = {
            "xl/sharedStrings.xml": "<sst><si><t>Alpha</t></si><si><r><t>Beta</t></r></si></sst>",
            "xl/worksheets/sheet1.xml": (
                "<worksheet><sheetData><row><c t='s'><v>0</v></c><c t='s'><v>1</v></c>"
                "<c><v>42</v></c></row><row><c t='s'><v>1</v></c></row></sheetData></worksheet>"
            ),
            "xl/worksheets/sheet2.xml": "<worksheet><sheetData><row><c><v>Second</v></c></row></sheetData></worksheet>",
        }
        with zipfile.ZipFile(io.BytesIO(xlsx_bytes(parts))) as archive:
            result = ooxml_extract.xlsx(archive, 1024 * 1024, 200)
        self.assertEqual(result, "[sheet1]\nAlpha\tBeta\t42\nBeta\n\n[sheet2]\nSecond")

    def test_many_references_to_a_large_shared_string_stop_within_the_output_budget(self):
        visited_cells = 0

        def mark_cell(_cell):
            nonlocal visited_cells
            visited_cells += 1

        text_value = FakeElement("{sheet}t", text="X" * 100_000)
        shared_item = FakeElement("{sheet}si", children=[text_value])
        shared_root = FakeElement("{sheet}sst", children=[shared_item])
        cells = [
            FakeElement("{sheet}c", attrib={"t": "s"}, children=[FakeElement("{sheet}v", text="0")])
            for _ in range(20_000)
        ]
        row = FakeElement("{sheet}row", children=cells, on_yield=mark_cell)
        sheet_root = FakeElement("{sheet}worksheet", children=[FakeElement("{sheet}sheetData", children=[row])])
        parts = {
            "xl/sharedStrings.xml": b"<sst/>",
            "xl/worksheets/sheet1.xml": b"<worksheet/>",
        }

        def parse_xml(data):
            return shared_root if data == parts["xl/sharedStrings.xml"] else sheet_root

        appended_chunks = []
        append_slice = ooxml_extract.OutputBudget.append_slice

        def track_appended_chunk(writer, value, start, end):
            previous_size = writer.size
            append_slice(writer, value, start, end)
            appended_chunks.append(writer.size - previous_size)

        with patch.object(ooxml_extract.ET, "fromstring", side_effect=parse_xml), \
             patch.object(ooxml_extract.OutputBudget, "append_slice", track_appended_chunk):
            result = ooxml_extract.xlsx(FakeZip(parts), 1024 * 1024, 64)

        self.assertLessEqual(len(result), 64)
        self.assertEqual(len(result), 64)
        self.assertTrue(result.startswith("[sheet1]\n"))
        self.assertLess(visited_cells, 20_000, "cell traversal must stop when the output budget is consumed")
        self.assertLessEqual(max(appended_chunks), 64, "output materialization must never exceed the remaining budget")


class OoxmlStreamingBudgetTests(unittest.TestCase):
    def test_docx_and_pptx_stop_reading_members_when_the_shared_output_budget_is_full(self):
        docx_parts = {
            "word/document.xml": b"<document/>",
            "word/header1.xml": b"<header/>"
        }
        pptx_parts = {
            "ppt/slides/slide2.xml": b"<slide/>",
            "ppt/slides/slide1.xml": b"<slide/>"
        }
        xml_texts = {
            b"<document/>": FakeElement("{w}document", children=[FakeElement("{w}t", text="D" * 100)]),
            b"<header/>": FakeElement("{w}header", children=[FakeElement("{w}t", text="H" * 100)]),
            b"<slide/>": FakeElement("{p}slide", children=[FakeElement("{p}t", text="P" * 100)])
        }

        with patch.object(ooxml_extract.ET, "fromstring", side_effect=lambda data: xml_texts[data]):
            docx_archive = FakeZip(docx_parts)
            docx_result = ooxml_extract.docx(docx_archive, 1024, 16)
            pptx_archive = FakeZip(pptx_parts)
            pptx_result = ooxml_extract.pptx(pptx_archive, 1024, 16)

        self.assertEqual(docx_result, "D" * 16)
        self.assertEqual(docx_archive.opened, ["word/document.xml"])
        self.assertEqual(pptx_result, "[Slide 1]\n" + "P" * 6)
        self.assertEqual(pptx_archive.opened, ["ppt/slides/slide1.xml"])


if __name__ == "__main__":
    unittest.main()
