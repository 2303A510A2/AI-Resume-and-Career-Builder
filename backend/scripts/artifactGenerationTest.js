// Offline artifact generation checks. No MongoDB, network, or provider key.
/* eslint-disable no-console */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { generate } = require('../services/documentGenerator');
process.env.IMAGE_PROVIDER = 'selftest';
const imageService = require('../services/imageService');
const artifactService = require('../services/artifactService');

const content = {
  text: 'AI Resume & Career Builder\nGenerated artifact test',
  sections: [{ heading: 'Summary', body: 'This content must be present in generated files.' }],
  rows: [{ Name: 'Ada', Score: 98 }, { Name: 'Linus', Score: 95 }],
  slides: [{ title: 'Title', body: 'Editable presentation content.' }, { title: 'Conclusion', body: 'Complete.' }],
};

const signatures = {
  pdf: Buffer.from('%PDF-'),
  docx: Buffer.from('PK'),
  pptx: Buffer.from('PK'),
  xlsx: Buffer.from('PK'),
  csv: Buffer.from('Name,Score'),
};

const inspectZip = (buffer, expectedEntries) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
  const archive = path.join(root, 'artifact.zip');
  const output = path.join(root, 'out');
  fs.writeFileSync(archive, buffer);
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${output.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'ignore' });
    expectedEntries.forEach((entry) => assert(fs.existsSync(path.join(output, ...entry.split('/'))), `ZIP entry ${entry}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const main = async () => {
  let passed = 0;
  for (const format of Object.keys(signatures)) {
    const result = await generate({ title: 'Artifact test', format, content });
    assert(result.buffer.length > (format === 'csv' ? 10 : 100), `${format} should not be empty`);
    assert(result.buffer.subarray(0, signatures[format].length).equals(signatures[format]), `${format} signature`);
    assert(result.extension === format, `${format} extension`);
    passed += 3;
    console.log(`  OK   ${format} generated and has a valid container signature`);
  }
  const image = await imageService.generate({ prompt: 'A simple blue career roadmap diagram' });
  assert.deepStrictEqual(
    artifactService.formatsFromRequest('Create a Word document and PowerPoint presentation with images'),
    ['docx', 'pptx'],
  );
  assert.deepStrictEqual(
    artifactService.imagePromptsFromRequest('Create a 3-slide PowerPoint with 2 diagrams'),
    [
      'Professional original educational visual 1 for: 3-slide PowerPoint 2 diagrams',
      'Professional original educational visual 2 for: 3-slide PowerPoint 2 diagrams',
    ],
  );
  assert.strictEqual(artifactService.slideCountFromRequest('Create exactly 12 slides'), 12);
  passed += 3;
  console.log('  OK   Word/PowerPoint aliases, image count, and exact slide count are parsed');
  const visualBuffers = {};
  for (const format of ['docx', 'pptx']) {
    const result = await generate({
      title: 'Visual artifact test',
      format,
      content: {
        text: 'Visual explanation',
        slideCount: format === 'pptx' ? 4 : 0,
        images: [{ buffer: image.buffer, mimeType: image.mimeType, width: image.width, height: image.height, caption: 'Career roadmap' }],
      },
    });
    assert(result.buffer.length > 1000, `${format} with image should not be empty`);
    visualBuffers[format] = result.buffer;
    passed += 1;
    console.log(`  OK   ${format} embeds a real generated image`);
  }
  inspectZip(visualBuffers.docx, ['word/media/image1.png', 'word/footer1.xml']);
  console.log('  OK   DOCX contains an image part and footer');
  inspectZip(visualBuffers.pptx, ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml', 'ppt/slides/slide4.xml', 'ppt/media/image-1-1.png']);
  console.log('  OK   PPTX contains exactly 4 slides and an image part');
  passed += 2;

  const oldGenerate = imageService.generate;
  imageService.generate = async () => { throw Object.assign(new Error('provider unavailable'), { code: 'IMAGE_UNREACHABLE' }); };
  await assert.rejects(() => artifactService.generateArtifactImages(['must fail']), /provider unavailable/);
  imageService.generate = oldGenerate;
  console.log('  OK   image-provider failure is surfaced without fake output');
  passed += 1;
  console.log(`\nALL ${passed} ARTIFACT ASSERTIONS PASSED`);
};

main().catch((error) => {
  console.error(`\nARTIFACT TEST FAILED: ${error.message}`);
  process.exitCode = 1;
});
