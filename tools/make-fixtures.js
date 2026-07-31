'use strict';

/**
 * Synthetic DICOM fixture generator.
 *
 * Real studies are never committed to this repository, so everything the tests
 * run against is generated here. The output is valid DICOM Part 10 — a real
 * preamble, a real meta header, and a real (if boring) pixel array — so it
 * exercises the same parse and transfer paths as clinical data without being
 * clinical data.
 *
 * Usage:
 *   node tools/make-fixtures.js [outDir] [--instances N] [--studies N] [--corrupt]
 */

const fs = require('fs');
const path = require('path');

const dcmjsDimse = require('dcmjs-dimse');
const { Dataset } = dcmjsDimse;
const { TransferSyntax, StorageClass } = dcmjsDimse.constants;

/**
 * Deterministic UID builder, so regenerating fixtures produces identical UIDs
 * and a test can assert on them.
 */
const ROOT = '1.2.826.0.1.3680043.10.1337';

function uid(...parts) {
  return [ROOT, ...parts].join('.');
}

/** Small, cheap pixel array. Content is irrelevant; size and validity are not. */
function makePixels(rows, cols, seed) {
  const buffer = Buffer.alloc(rows * cols * 2);
  for (let i = 0; i < rows * cols; i++) {
    buffer.writeUInt16LE((i * 7 + seed * 13) % 4096, i * 2);
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
}

/**
 * Writes one synthetic instance.
 *
 * @returns {Promise<string>} The path written.
 */
function writeInstance(spec) {
  const {
    filePath, studyUid, seriesUid, sopUid, modality, sopClassUid,
    seriesNumber, instanceNumber, rows, cols, patientName, patientId,
    studyDescription, seriesDescription, transferSyntaxUid,
  } = spec;

  const elements = {
    // Declaring the VR keeps dcmjs from warning about the ambiguous OB/OW of
    // PixelData when writing.
    _vrMap: { PixelData: 'OW' },

    SOPClassUID: sopClassUid,
    SOPInstanceUID: sopUid,
    StudyInstanceUID: studyUid,
    SeriesInstanceUID: seriesUid,

    PatientName: patientName,
    PatientID: patientId,
    PatientBirthDate: '19700101',
    PatientSex: 'O',

    StudyDate: '20260115',
    StudyTime: '101500',
    AccessionNumber: 'ACC0000001',
    StudyID: 'STUDY1',
    StudyDescription: studyDescription,
    SeriesDescription: seriesDescription,
    ReferringPhysicianName: 'REFERRER^TEST',
    InstitutionName: 'SYNTHETIC HOSPITAL',

    Modality: modality,
    SeriesNumber: seriesNumber,
    InstanceNumber: instanceNumber,

    Rows: rows,
    Columns: cols,
    BitsAllocated: 16,
    BitsStored: 16,
    HighBit: 15,
    PixelRepresentation: 0,
    SamplesPerPixel: 1,
    PhotometricInterpretation: 'MONOCHROME2',
    PixelSpacing: [1.0, 1.0],
    PixelData: [makePixels(rows, cols, instanceNumber)],
  };

  const dataset = new Dataset(elements, transferSyntaxUid);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return new Promise((resolve, reject) => {
    dataset.toFile(filePath, (err) => (err ? reject(err) : resolve(filePath)));
  });
}

/**
 * Generates a fixture tree.
 *
 * @param {object} opts
 * @returns {Promise<object>} Description of what was written.
 */
async function generate(opts = {}) {
  const {
    outDir = path.join(__dirname, '..', 'fixtures'),
    studies = 1,
    instancesPerSeries = 5,
    seriesPerStudy = 2,
    rows = 32,
    cols = 32,
    corrupt = false,
    collidingSeriesUids = false,
    quiet = false,
  } = opts;

  const say = (msg) => {
    if (!quiet) process.stdout.write(`${msg}\n`);
  };

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const written = [];
  const manifest = { outDir, studies: [], corruptFiles: [], nonDicomFiles: [] };

  for (let s = 1; s <= studies; s++) {
    const studyUid = uid(s);
    const studyDir = path.join(outDir, `study-${s}`);
    const studyRecord = { studyInstanceUid: studyUid, series: [], instanceCount: 0 };

    for (let se = 1; se <= seriesPerStudy; se++) {
      // Optionally emit the same Series UID for two different series — the
      // exact source-system defect that --rewrite-series-uid exists to repair.
      const seriesUid = collidingSeriesUids ? uid(s, 1) : uid(s, se);
      const modality = se % 2 === 1 ? 'CT' : 'MR';
      const sopClassUid =
        modality === 'CT' ? StorageClass.CtImageStorage : StorageClass.MrImageStorage;

      const seriesRecord = {
        seriesInstanceUid: seriesUid,
        modality,
        seriesNumber: se,
        instances: [],
      };

      for (let i = 1; i <= instancesPerSeries; i++) {
        const sopUid = uid(s, se, i);
        const filePath = path.join(studyDir, `series-${se}`, `instance-${i}.dcm`);
        await writeInstance({
          filePath,
          studyUid,
          seriesUid,
          sopUid,
          modality,
          sopClassUid,
          seriesNumber: se,
          instanceNumber: i,
          rows,
          cols,
          patientName: `SYNTHETIC^PATIENT${s}`,
          patientId: `SYNTH${String(s).padStart(4, '0')}`,
          studyDescription: `SYNTHETIC STUDY ${s}`,
          seriesDescription: `${modality} SERIES ${se}`,
          transferSyntaxUid: TransferSyntax.ExplicitVRLittleEndian,
        });
        written.push(filePath);
        seriesRecord.instances.push({ sopInstanceUid: sopUid, path: filePath });
        studyRecord.instanceCount += 1;
      }

      studyRecord.series.push(seriesRecord);
    }

    manifest.studies.push(studyRecord);
  }

  // A file that looks like DICOM and is not. The scanner must count this as a
  // read error rather than skipping it, or a lossy run could look clean.
  if (corrupt) {
    const corruptPath = path.join(outDir, 'study-1', 'truncated.dcm');
    const header = Buffer.alloc(132);
    header.write('DICM', 128, 'ascii');
    fs.writeFileSync(corruptPath, Buffer.concat([header, Buffer.from('not a valid dataset')]));
    manifest.corruptFiles.push(corruptPath);
    say(`wrote corrupt fixture: ${path.relative(outDir, corruptPath)}`);
  }

  // Plain non-DICOM noise, which should be ignored rather than counted.
  const readmePath = path.join(outDir, 'README.txt');
  fs.writeFileSync(readmePath, 'Synthetic fixtures. Not real patient data.\n');
  manifest.nonDicomFiles.push(readmePath);

  const totalInstances = manifest.studies.reduce((n, s) => n + s.instanceCount, 0);
  say(`wrote ${totalInstances} synthetic instance(s) across ${studies} stud${studies === 1 ? 'y' : 'ies'} to ${outDir}`);

  manifest.totalInstances = totalInstances;
  return manifest;
}

/** CLI entry. */
async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? Number(next) : true;
  };

  await generate({
    outDir: positional[0] ? path.resolve(positional[0]) : undefined,
    studies: flag('studies', 1),
    instancesPerSeries: flag('instances', 5),
    seriesPerStudy: flag('series', 2),
    corrupt: argv.includes('--corrupt'),
    collidingSeriesUids: argv.includes('--colliding-series'),
  });
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err}\n`);
    process.exit(1);
  });
}

module.exports = { generate, writeInstance, uid };
