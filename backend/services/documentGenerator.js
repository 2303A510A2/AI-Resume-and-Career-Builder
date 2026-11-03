const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell,
  WidthType, Footer, PageNumber,
} = require('docx');
const PDFDocument = require('pdfkit');
const pptxgen = require('pptxgenjs');
const ExcelJS = require('exceljs');
const { stringify } = require('csv-stringify/sync');

const TYPES = {
  pdf: { mimeType: 'application/pdf', artifactType: 'document' },
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', artifactType: 'document' },
  pptx: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', artifactType: 'presentation' },
  xlsx: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', artifactType: 'spreadsheet' },
  csv: { mimeType: 'text/csv; charset=utf-8', artifactType: 'data' },
};

const normalizeContent = (content) => {
  if (typeof content === 'string') return { text: content, sections: [] };
  const value = content && typeof content === 'object' ? content : {};
  return {
    text: String(value.text || ''),
    sections: Array.isArray(value.sections) ? value.sections : [],
    rows: Array.isArray(value.rows) ? value.rows : [],
    slides: Array.isArray(value.slides) ? value.slides : [],
    images: Array.isArray(value.images) ? value.images : [],
    slideCount: Number.isInteger(Number(value.slideCount)) ? Math.max(0, Number(value.slideCount)) : 0,
  };
};

const imageType = (mimeType) => {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/gif') return 'gif';
  return 'png';
};

const imageBuffer = (image) => {
  if (!image || !Buffer.isBuffer(image.buffer) || !image.buffer.length) return null;
  return image.buffer;
};

const fitImage = (image, maxWidth, maxHeight) => {
  const width = Number(image?.width) > 0 ? Number(image.width) : maxWidth;
  const height = Number(image?.height) > 0 ? Number(image.height) : maxHeight;
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

const tableRows = (content) => {
  const normalized = normalizeContent(content);
  if (!normalized.rows.length) return [];
  const headers = Object.keys(normalized.rows[0] || {});
  if (!headers.length) return [];
  return [
    new TableRow({
      children: headers.map((header) => new TableCell({
        width: { size: 100 / headers.length, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: String(header), bold: true, color: 'FFFFFF' })] })],
        shading: { fill: '4F46E5' },
      })),
    }),
    ...normalized.rows.map((row) => new TableRow({
      children: headers.map((header) => new TableCell({
        children: [new Paragraph({ text: String(row?.[header] ?? '') })],
      })),
    })),
  ];
};

const paragraphs = (content) => {
  const normalized = normalizeContent(content);
  const items = [];
  if (normalized.text) {
    normalized.text.split(/\r?\n/).forEach((line) => {
      if (line.trim()) items.push(new Paragraph({ children: [new TextRun(line.trim())] }));
    });
  }
  normalized.sections.forEach((section) => {
    if (section && section.heading) items.push(new Paragraph({ text: String(section.heading), heading: HeadingLevel.HEADING_1 }));
    if (section && section.body) {
      String(section.body).split(/\r?\n/).forEach((line) => {
        if (line.trim()) items.push(new Paragraph({ text: line.trim() }));
      });
    }
  });
  return items.length ? items : [new Paragraph({ text: 'No content was supplied.' })];
};

const generateDocx = async (title, content) => {
  const normalized = normalizeContent(content);
  const imageParagraphs = normalized.images.flatMap((image) => {
    const buffer = imageBuffer(image);
    if (!buffer) return [];
    const dimensions = fitImage(image, 540, 300);
    return [
      new Paragraph({
        children: [new ImageRun({
          data: buffer,
          transformation: dimensions,
          type: imageType(image.mimeType),
        })],
      }),
      ...(image.caption ? [new Paragraph({ children: [new TextRun({ text: String(image.caption), italics: true, color: '64748B' })] })] : []),
    ];
  });
  const doc = new Document({
    creator: 'AI Resume & Career Builder',
    title,
    sections: [{ properties: { page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } } }, footers: {
      default: new Footer({
        children: [new Paragraph({ alignment: 'center', children: [new TextRun('Page '), PageNumber.CURRENT] })],
      }),
    }, children: [
      new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
      ...paragraphs(content),
      ...(tableRows(content).length
        ? [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows(content) })]
        : []),
      ...imageParagraphs,
    ] }],
  });
  return Packer.toBuffer(doc);
};

const generatePdf = (title, content) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ margin: 54, info: { Title: title, Creator: 'AI Resume & Career Builder' } });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
  doc.fontSize(20).text(title, { align: 'center' }).moveDown();
  const normalized = normalizeContent(content);
  const lines = [
    ...(normalized.text ? normalized.text.split(/\r?\n/) : []),
    ...normalized.sections.flatMap((section) => [section.heading ? `\n${section.heading}` : '', section.body || '']),
  ];
  doc.fontSize(11);
  lines.filter((line) => String(line).trim()).forEach((line) => doc.text(String(line).trim(), { paragraphGap: 6 }));
  doc.end();
});

const generatePptx = async (title, content) => {
  const pptx = new pptxgen();
  pptx.author = 'AI Resume & Career Builder';
  pptx.subject = title;
  pptx.layout = 'LAYOUT_WIDE';
  const normalized = normalizeContent(content);
  const sourceSlides = normalized.slides.length
    ? normalized.slides
    : [{ title, body: normalized.text || normalized.sections.map((s) => `${s.heading || ''}\n${s.body || ''}`).join('\n\n') }];
  const targetCount = normalized.slideCount || sourceSlides.length;
  const slides = sourceSlides.slice(0, targetCount);
  while (slides.length < targetCount) {
    slides.push({
      title: `${title} — Part ${slides.length + 1}`,
      body: normalized.sections[slides.length - 1]?.body || '',
    });
  }
  slides.forEach((item, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: 'F7F8FC' };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.16, line: { color: '4F46E5', transparency: 100 }, fill: { color: '4F46E5' } });
    slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.18, w: 0.08, h: 5.55, line: { color: '22D3EE', transparency: 100 }, fill: { color: '22D3EE' } });
    slide.addText(String(item.title || (index === 0 ? title : `Section ${index + 1}`)), {
      x: 0.6, y: 0.45, w: 12.1, h: 0.6, fontFace: 'Aptos Display', fontSize: 26, bold: true, color: '18213A',
    });
    slide.addText(String(item.body || item.content || ''), {
      x: 0.8, y: 1.35, w: 11.6, h: 5.3, fontFace: 'Aptos', fontSize: 18, color: '2F3852', breakLine: false, fit: 'shrink',
    });
    const images = Array.isArray(item.images) && item.images.length
      ? item.images
      : (index < normalized.images.length ? [normalized.images[index]] : []);
    images.slice(0, 2).forEach((image, imageIndex) => {
      const buffer = imageBuffer(image);
      if (!buffer) return;
      const data = `data:${image.mimeType || 'image/png'};base64,${buffer.toString('base64')}`;
      const box = imageIndex === 0
        ? { x: 8.55, y: 1.55, w: 3.25, h: 2.35 }
        : { x: 10.55, y: 1.55, w: 2.0, h: 1.45 };
      const dimensions = fitImage(image, box.w, box.h);
      slide.addImage({
        data,
        x: box.x + (box.w - dimensions.width) / 2,
        y: box.y + (box.h - dimensions.height) / 2,
        w: dimensions.width,
        h: dimensions.height,
      });
      if (image.caption) slide.addText(String(image.caption), {
        x: imageIndex === 0 ? 8.55 : 10.55, y: imageIndex === 0 ? 3.95 : 3.1,
        w: imageIndex === 0 ? 3.25 : 2.0, h: 0.3, fontSize: 8, color: '64748B', fit: 'shrink',
      });
      if (item.chart && Array.isArray(item.chart.values)) {
        const values = item.chart.values.map(Number).filter(Number.isFinite);
        const max = Math.max(...values, 1);
        values.slice(0, 8).forEach((value, chartIndex) => {
          const height = Math.max(0.08, (value / max) * 1.6);
          slide.addShape(pptx.ShapeType.rect, {
            x: 8.55 + chartIndex * 0.42, y: 6.55 - height, w: 0.27, h: height,
            line: { color: '6366F1', transparency: 100 }, fill: { color: '6366F1' },
          });
        });
      }
    });
    slide.addText(`${index + 1}`, { x: 12.1, y: 7.05, w: 0.5, h: 0.2, fontSize: 9, color: '64748B', align: 'right' });
  });
  return pptx.write({ outputType: 'nodebuffer' });
};

const rowsFor = (content) => {
  const normalized = normalizeContent(content);
  if (normalized.rows.length) return normalized.rows;
  return normalized.text.split(/\r?\n/).filter(Boolean).map((value) => ({ content: value }));
};

const generateXlsx = async (title, content) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31) || 'Data');
  const rows = rowsFor(content);
  const headers = rows.length && typeof rows[0] === 'object' ? Object.keys(rows[0]) : ['content'];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '4F46E5' } };
  rows.forEach((row) => sheet.addRow(headers.map((header) => typeof row === 'object' ? row[header] : row)));
  sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + Math.min(headers.length, 26))}${Math.max(1, rows.length + 1)}` };
  headers.forEach((header, index) => { sheet.getColumn(index + 1).width = Math.min(42, Math.max(12, String(header).length + 4)); });
  return workbook.xlsx.writeBuffer();
};

const generateCsv = (title, content) => {
  const rows = rowsFor(content);
  if (!rows.length) return Buffer.from('content\r\n', 'utf8');
  const headers = typeof rows[0] === 'object' ? Object.keys(rows[0]) : ['content'];
  const records = rows.map((row) => headers.map((header) => typeof row === 'object' ? row[header] : row));
  return Buffer.from(stringify([headers, ...records]), 'utf8');
};

const generate = async ({ title, format, content }) => {
  const extension = String(format || '').toLowerCase().replace(/^\./, '');
  if (!TYPES[extension]) throw new Error(`Unsupported artifact format: ${extension}`);
  let buffer;
  if (extension === 'docx') buffer = await generateDocx(title, content);
  else if (extension === 'pdf') buffer = await generatePdf(title, content);
  else if (extension === 'pptx') buffer = await generatePptx(title, content);
  else if (extension === 'xlsx') buffer = Buffer.from(await generateXlsx(title, content));
  else buffer = generateCsv(title, content);
  if (!buffer || !buffer.length) throw new Error('Generated artifact is empty');
  return { buffer, extension, ...TYPES[extension] };
};

module.exports = { generate, TYPES };
