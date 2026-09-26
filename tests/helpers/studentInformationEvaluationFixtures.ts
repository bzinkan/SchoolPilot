import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import type {
  StudentInformationEvaluationFixture,
  ContactEvaluationRow,
} from "../../src/services/studentInformationEvaluation.js";

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function zip(files: Record<string, string>) {
  const entries: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name),
      bytes = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30),
      central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    entries.push(header, filename, bytes);
    directory.push(central, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, ...directory, end]);
}

/** Entirely invented records. Expected answers are separate from source bytes. */
export async function buildStudentInformationEvaluationFixtures(): Promise<
  StudentInformationEvaluationFixture[]
> {
  const result: StudentInformationEvaluationFixture[] = [];
  const formats = ["csv", "xlsx", "docx", "pdf", "png", "jpeg", "webp"];
  for (let packet = 0; packet < 20; packet++) {
    const expected: ContactEvaluationRow[] = Array.from(
      { length: 5 },
      (_, row) => {
        const n = packet * 5 + row;
        return {
          studentId: `synthetic-${n}`,
          name: `Synthetic Child ${n}`,
          phones: [`00${String(n).padStart(8, "0")}`],
          emails: [`guardian.${n}@example.invalid`],
          adultAssociation: `Synthetic Guardian ${n}`,
        };
      },
    );
    const rows = expected.map((row) => [
      row.studentId,
      row.name,
      row.adultAssociation,
      row.phones[0]!,
      row.emails[0]!,
    ]);
    const format = formats[packet % formats.length]!;
    let bytes: Buffer, contentType: string;
    if (format === "csv") {
      bytes = Buffer.from(
        [
          "Student identifier,Student,Contact,Phone,Email",
          ...rows.map((row) => row.join(",")),
        ].join("\n"),
      );
      contentType = "text/csv";
    } else if (format === "xlsx") {
      const book = new ExcelJS.Workbook();
      book
        .addWorksheet("Contacts")
        .addRows([
          ["Student identifier", "Student", "Contact", "Phone", "Email"],
          ...rows,
        ]);
      bytes = Buffer.from(await book.xlsx.writeBuffer());
      contentType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else if (format === "docx") {
      bytes = zip({
        "[Content_Types].xml":
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels":
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${rows.map((row) => `<w:p><w:r><w:t>${escapeXml(row.join(" | "))}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
      });
      contentType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else if (format === "pdf") {
      const doc = await PDFDocument.create(),
        page = doc.addPage([1100, 650]),
        font = await doc.embedFont(StandardFonts.Helvetica);
      rows.forEach((row, index) =>
        page.drawText(row.join(" | "), {
          x: 30,
          y: 600 - index * 65,
          size: 13,
          font,
        }),
      );
      bytes = Buffer.from(await doc.save());
      contentType = "application/pdf";
    } else {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="500"><rect width="100%" height="100%" fill="white"/>${rows.map((row, index) => `<text x="25" y="${60 + index * 75}" font-size="18" fill="black">${escapeXml(row.join(" | "))}</text>`).join("")}</svg>`;
      bytes = await sharp(Buffer.from(svg))
        .toFormat(format as "png" | "jpeg" | "webp")
        .toBuffer();
      contentType = `image/${format}`;
    }
    result.push({
      id: `synthetic-${format}-${packet}`,
      contentType,
      bytes,
      expected,
    });
  }
  return result;
}
