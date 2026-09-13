import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OfficeOpenXmlExtractor } from "../../src/content/extractors/officeOpenXml.ts";
import { XmlExtractor } from "../../src/content/extractors/xml.ts";

function runPython(code: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", ["-c", code, ...args]);
    let err = ""; p.stderr.on("data", d => err += d.toString());
    p.on("exit", c => c === 0 ? resolve() : reject(new Error(err || `python exit ${c}`)));
  });
}

test("XML extractor rejects DTD/entity declarations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xml-safe-"));
  const path = join(dir, "bad.xml");
  await writeFile(path, `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`);
  const extractor = new XmlExtractor();
  await assert.rejects(() => extractor.extract({ filePath: path, fileName: "bad.xml", contentType: "application/xml" }), /UNSAFE_XML_DECLARATION/);
});

test("XML extractor decodes ampersands last to avoid double unescaping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xml-entities-"));
  const path = join(dir, "nested.xml");
  await writeFile(path, "<root>&amp;lt; &amp;#x41; &amp;#65;</root>");
  const extractor = new XmlExtractor();
  const result = await extractor.extract({ filePath: path, fileName: "nested.xml", contentType: "application/xml" });
  assert.equal(result.text, "&lt; &#x41; &#65;");
});

test("DOCX OOXML extractor returns text without external libraries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ooxml-"));
  const path = join(dir, "sample.docx");
  const py = String.raw`
import sys, zipfile
p=sys.argv[1]
content='''<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ArcSuite MCP sample</w:t></w:r></w:p></w:body></w:document>'''
with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    z.writestr('word/document.xml',content)
`;
  await runPython(py, [path]);
  const extractor = new OfficeOpenXmlExtractor();
  const result = await extractor.extract({ filePath: path, fileName: "sample.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  assert.match(result.text, /ArcSuite MCP sample/);
});
