'use strict';

const dcmjs = require('dcmjs');

const { DicomMetaDictionary } = dcmjs.data;

/**
 * DICOM tag lookup and value rendering.
 *
 * dcmjs hands back a "naturalised" dataset keyed by keyword — `PatientName`
 * rather than `(0010,0010)` — which is pleasant to work with and useless when
 * you need to tell someone which tag to look at. This module maps back to the
 * real tag numbers and value representations, and renders values in a form
 * that is safe to print.
 *
 * Safe to print matters more than it sounds. A naive dump will happily write
 * several megabytes of pixel data to a terminal, and DICOM sequences nest
 * arbitrarily deep. Both are handled explicitly rather than left to chance.
 */

/** Elements whose value is bulk binary and must never be dumped verbatim. */
const BULK_KEYWORDS = new Set([
  'PixelData',
  'FloatPixelData',
  'DoubleFloatPixelData',
  'EncapsulatedDocument',
  'SpectroscopyData',
  'WaveformData',
  'RedPaletteColorLookupTableData',
  'GreenPaletteColorLookupTableData',
  'BluePaletteColorLookupTableData',
  'OverlayData',
]);

/** dcmjs bookkeeping keys that are not real DICOM elements. */
const INTERNAL_KEYS = new Set(['_vrMap', '_meta']);

/**
 * Resolves a keyword to its tag and value representation.
 *
 * @param {string} keyword
 * @returns {{tag: string, vr: string, name: string, vm?: string}|undefined}
 */
function lookup(keyword) {
  const entry = DicomMetaDictionary.nameMap[keyword];
  if (!entry) return undefined;
  return { tag: entry.tag, vr: entry.vr, name: entry.name, vm: entry.vm };
}

/**
 * Describes a key found in a naturalised dataset.
 *
 * Unknown keys are the interesting case: dcmjs leaves anything it cannot name
 * as a raw eight-character hex string, which is exactly what private and
 * vendor-specific tags look like. Those are the ones that survive
 * de-identification, so they are labelled rather than skipped.
 *
 * @param {string} key
 * @returns {{tag: string, vr: string, keyword: string, private: boolean}}
 */
function describeKey(key) {
  const known = lookup(key);
  if (known) {
    return { tag: known.tag, vr: known.vr, keyword: key, private: false };
  }

  if (/^[0-9A-Fa-f]{8}$/.test(key)) {
    const group = key.slice(0, 4).toUpperCase();
    const element = key.slice(4).toUpperCase();
    // An odd group number is private by definition (PS3.5 section 7.8).
    const isPrivate = parseInt(group, 16) % 2 === 1;
    return {
      tag: `(${group},${element})`,
      vr: '??',
      keyword: isPrivate ? '(private tag)' : '(unknown tag)',
      private: true,
    };
  }

  return { tag: '(????,????)', vr: '??', keyword: key, private: false };
}

/**
 * True when a value is genuinely a nested sequence rather than a structured
 * scalar.
 *
 * The value representation decides this, not the shape of the value. dcmjs
 * represents a Person Name as `[{Alphabetic: 'DOE^JANE'}]` — an array holding
 * an object — which is indistinguishable by shape from a one-item sequence.
 * Guessing from the shape renders every patient name as "<sequence, 1 item>"
 * and then expands it into a phantom nested element.
 *
 * @param {*} value
 * @param {string} vr
 * @returns {boolean}
 */
function isSequence(value, vr) {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (vr === 'SQ') return true;
  // A known non-sequence VR is never a sequence, whatever the value looks like.
  if (vr && vr !== '??') return false;
  // Unknown VR (private tags): fall back to shape, excluding Person Name.
  const first = value[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    !isBinary(first) &&
    first.Alphabetic === undefined
  );
}

/**
 * Renders an element value as printable text.
 *
 * @param {string} keyword
 * @param {*} value
 * @param {{maxLength?: number, vr?: string}} [opts]
 * @returns {string}
 */
function renderValue(keyword, value, opts = {}) {
  const maxLength = opts.maxLength ?? 120;
  const vr = opts.vr ?? lookup(keyword)?.vr ?? '??';

  if (value === undefined || value === null) return '';

  // Bulk binary: report the size, never the bytes.
  if (BULK_KEYWORDS.has(keyword)) {
    const bytes = byteLength(value);
    // Metadata-only reads stop before the pixel data, so the element is
    // present but empty. Reporting that as "0 bytes" reads as "this image has
    // no pixels", which is a different and alarming claim.
    if (bytes === 0) return '<not read — metadata only>';
    return `<binary, ${bytes} byte${bytes === 1 ? '' : 's'}>`;
  }

  if (isSequence(value, vr)) {
    return `<sequence, ${value.length} item${value.length === 1 ? '' : 's'}>`;
  }

  if (Array.isArray(value)) {
    if (value.length && isBinary(value[0])) {
      const bytes = byteLength(value);
      return `<binary, ${bytes} byte${bytes === 1 ? '' : 's'}>`;
    }
    // Multi-valued elements are backslash-delimited in DICOM, and a Person
    // Name arrives as a one-element array of its component groups.
    return truncate(value.map((v) => renderScalar(v)).join('\\'), maxLength);
  }

  if (isBinary(value)) {
    const bytes = byteLength(value);
    return `<binary, ${bytes} byte${bytes === 1 ? '' : 's'}>`;
  }

  return truncate(renderScalar(value), maxLength);
}

function renderScalar(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    // Person Name arrives as { Alphabetic: 'DOE^JANE' }.
    if (value.Alphabetic !== undefined) return String(value.Alphabetic);
    return JSON.stringify(value);
  }
  return String(value);
}

function isBinary(value) {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  );
}

function byteLength(value) {
  if (Array.isArray(value)) return value.reduce((n, v) => n + byteLength(v), 0);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return value.length;
  return 0;
}

function truncate(text, maxLength) {
  const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}… (${clean.length} chars)`;
}

/**
 * Flattens a naturalised dataset into a printable, sorted list of elements.
 *
 * Sequences are walked to `depth` levels so nested identifiers are visible
 * rather than hidden behind "<sequence>" — those nested items are exactly
 * where identifiers survive a careless de-identification.
 *
 * @param {Record<string, unknown>} elements
 * @param {{depth?: number, level?: number}} [opts]
 * @returns {Array<{tag: string, vr: string, keyword: string, value: string, private: boolean, level: number}>}
 */
function flatten(elements, opts = {}) {
  const depth = opts.depth ?? 2;
  const level = opts.level ?? 0;
  const out = [];

  const keys = Object.keys(elements).filter((k) => !INTERNAL_KEYS.has(k));

  // Sort by tag number so the output reads like every other DICOM dumper,
  // rather than in whatever order the parser happened to produce.
  const described = keys.map((key) => ({ key, ...describeKey(key) }));
  described.sort((a, b) => a.tag.localeCompare(b.tag));

  for (const item of described) {
    const value = elements[item.key];
    out.push({
      tag: item.tag,
      vr: item.vr,
      keyword: item.keyword === '(private tag)' || item.keyword === '(unknown tag)'
        ? item.keyword
        : item.key,
      value: renderValue(item.key, value, { vr: item.vr }),
      private: item.private,
      level,
    });

    if (isSequence(value, item.vr) && level < depth) {
      value.forEach((sequenceItem, index) => {
        out.push({
          tag: '', vr: '', keyword: `item ${index + 1}`, value: '', private: false, level: level + 1,
        });
        out.push(...flatten(sequenceItem, { depth, level: level + 2 }));
      });
    }
  }

  return out;
}

/**
 * Resolves a user-supplied tag reference to a dataset key.
 *
 * Accepts a keyword (`PatientName`), a punctuated tag (`(0010,0010)`) or a
 * bare hex tag (`00100010`), because people copy tags from all three.
 *
 * @param {string} reference
 * @returns {{key: string, tag: string, vr: string, keyword: string}|undefined}
 */
function resolveReference(reference) {
  const trimmed = String(reference).trim();

  const known = lookup(trimmed);
  if (known) {
    return { key: trimmed, tag: known.tag, vr: known.vr, keyword: trimmed };
  }

  const hex = trimmed.replace(/[(),\s]/g, '').toUpperCase();
  if (/^[0-9A-F]{8}$/.test(hex)) {
    const punctuated = `(${hex.slice(0, 4)},${hex.slice(4)})`;
    // Map back to a keyword when the tag is a standard one, so the edit lands
    // on the key dcmjs actually uses in the naturalised dataset.
    for (const [name, entry] of Object.entries(DicomMetaDictionary.nameMap)) {
      if (entry.tag === punctuated) {
        return { key: name, tag: punctuated, vr: entry.vr, keyword: name };
      }
    }
    return { key: hex, tag: punctuated, vr: '??', keyword: '(private tag)' };
  }

  return undefined;
}

module.exports = {
  lookup,
  describeKey,
  renderValue,
  flatten,
  resolveReference,
  BULK_KEYWORDS,
  INTERNAL_KEYS,
};
