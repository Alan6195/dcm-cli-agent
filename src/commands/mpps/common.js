'use strict';

/**
 * Flag resolution and result rendering shared by the mpps verbs.
 *
 * Not a verb. `start` and `perform` take the same twenty-odd attribute flags
 * and the same connection, and `complete`, `discontinue` and `perform` all
 * have to explain the same four ways an N-service round trip can go wrong.
 * Keeping one copy of each is what stops the three verbs drifting into three
 * slightly different accounts of the same protocol.
 */

const log = require('../../lib/log');
const args = require('../../lib/args');
const statusLib = require('../../lib/status');
const { resolveTimeouts } = require('../../lib/dimse');
const { formatOutcome } = require('../../lib/reject');
const mpps = require('../../lib/mpps');

/** Connection flags every verb accepts. */
const CONNECTION_FLAGS = [
  'host', 'port', 'called-ae', 'calling-ae',
  'timeout', 'connect-timeout', 'association-timeout',
];

/** Scheduled- and performed-step attribute flags, shared by start and perform. */
const ATTRIBUTE_FLAGS = [
  'from-worklist',
  'study-uid', 'accession', 'patient-id', 'patient-name', 'patient-birth-date',
  'patient-sex', 'modality', 'requested-procedure-id',
  'requested-procedure-description', 'scheduled-step-id', 'step-id',
  'step-description', 'station-name', 'station-ae', 'location',
  'start-date', 'start-time', 'mpps-uid',
];

/**
 * Resolves the MPPS peer.
 *
 * @param {Map} flags
 * @returns {{host: string, port: number, calledAe: string, callingAe: string}}
 */
function resolveConnection(flags) {
  const host = args.resolve(flags, {
    name: 'host', env: 'DCM_HOST', required: true, describe: 'the MPPS peer hostname',
  });
  const port = args.validatePort(
    args.resolve(flags, { name: 'port', env: 'DCM_PORT', required: true, type: 'number' }),
    'port'
  );
  const calledAe = args.validateAeTitle(
    args.resolve(flags, { name: 'called-ae', env: 'DCM_CALLED_AE', required: true }),
    'called-ae'
  );
  const callingAe = args.validateAeTitle(
    args.resolve(flags, { name: 'calling-ae', env: 'DCM_CALLING_AE', fallback: 'DCM-CLI' }),
    'calling-ae'
  );
  return { host, port, calledAe, callingAe };
}

/**
 * Resolves the storage peer for `mpps perform`.
 *
 * The images and the procedure step very often go to different systems — the
 * archive takes the images, the RIS or a broker takes the MPPS. Each --store-*
 * flag therefore falls back to the corresponding MPPS value, and the caller is
 * expected to print which of the two it ended up using: a default that is
 * invisible is a default nobody can check.
 *
 * @param {Map} flags
 * @param {object} mppsConnection
 * @returns {{host: string, port: number, calledAe: string, callingAe: string, inherited: string[]}}
 */
function resolveStoreConnection(flags, mppsConnection) {
  const inherited = [];

  let host = args.resolve(flags, { name: 'store-host' });
  if (host === undefined) { host = mppsConnection.host; inherited.push('--store-host'); }

  let port = args.resolve(flags, { name: 'store-port', type: 'number' });
  if (port === undefined) { port = mppsConnection.port; inherited.push('--store-port'); }
  else port = args.validatePort(port, 'store-port');

  let calledAe = args.resolve(flags, { name: 'store-called-ae' });
  if (calledAe === undefined) { calledAe = mppsConnection.calledAe; inherited.push('--store-called-ae'); }
  else calledAe = args.validateAeTitle(calledAe, 'store-called-ae');

  return { host, port, calledAe, callingAe: mppsConnection.callingAe, inherited };
}

/**
 * @param {Map} flags
 * @returns {object}
 */
function timeoutsFrom(flags) {
  return resolveTimeouts({
    timeout: args.resolve(flags, { name: 'timeout', type: 'number' }),
    connectTimeout: args.resolve(flags, { name: 'connect-timeout', type: 'number' }),
    associationTimeout: args.resolve(flags, { name: 'association-timeout', type: 'number' }),
  });
}

/**
 * Resolves the procedure-step attributes from a worklist file and explicit
 * flags, with the flags winning.
 *
 * That precedence is the useful one: the worklist supplies the twelve
 * attributes nobody wants to retype, and a flag corrects the one the worklist
 * got wrong or the operator changed at the console.
 *
 * @param {Map} flags
 * @param {{callingAe: string}} connection
 * @param {Date} [now]
 * @returns {{attrs: object, source: {worklist?: string, worklistItems?: number}}}
 */
function resolveAttributes(flags, connection, now = new Date()) {
  const flagValue = (name) => args.resolve(flags, { name });

  const studyUidFlag = flagValue('study-uid');
  const accessionFlag = flagValue('accession');

  let fromWorklist = {};
  const source = {};
  const worklistFile = flagValue('from-worklist');
  if (worklistFile !== undefined) {
    const loaded = mpps.readWorklistFile(worklistFile, {
      studyUid: studyUidFlag,
      accession: accessionFlag,
    });
    fromWorklist = mpps.worklistToAttributes(loaded.item);
    source.worklist = loaded.file;
    source.worklistItems = loaded.count;
  }

  const pick = (flagName, key) => {
    const v = flagValue(flagName);
    return v !== undefined ? v : (fromWorklist[key] ?? '');
  };

  const attrs = {
    studyInstanceUid: pick('study-uid', 'studyInstanceUid'),
    accessionNumber: pick('accession', 'accessionNumber'),
    patientId: pick('patient-id', 'patientId'),
    patientName: pick('patient-name', 'patientName'),
    patientBirthDate: pick('patient-birth-date', 'patientBirthDate'),
    patientSex: pick('patient-sex', 'patientSex'),
    modality: pick('modality', 'modality'),
    requestedProcedureId: pick('requested-procedure-id', 'requestedProcedureId'),
    requestedProcedureDescription: pick(
      'requested-procedure-description', 'requestedProcedureDescription'
    ),
    scheduledProcedureStepId: pick('scheduled-step-id', 'scheduledProcedureStepId'),
    scheduledProcedureStepDescription: fromWorklist.scheduledProcedureStepDescription ?? '',
    performedProcedureStepDescription: pick(
      'step-description', 'performedProcedureStepDescription'
    ),
    performedStationName: flagValue('station-name') ?? '',
    performedLocation: flagValue('location') ?? '',
    referencedStudySequence: fromWorklist.referencedStudySequence ?? [],
    scheduledProtocolCodeSequence: fromWorklist.scheduledProtocolCodeSequence ?? [],
    procedureCodeSequence: fromWorklist.procedureCodeSequence ?? [],
    referencedPatientSequence: fromWorklist.referencedPatientSequence ?? [],
    startDate: flagValue('start-date') ?? mpps.dicomDate(now),
    startTime: flagValue('start-time') ?? mpps.dicomTime(now),
  };

  // PerformedStationAETitle is Type 1 and is what the archive matches the
  // incoming images against, so it defaults to the AE Title we are actually
  // associating under rather than to nothing.
  const stationAe = flagValue('station-ae');
  attrs.performedStationAeTitle = stationAe !== undefined
    ? args.validateAeTitle(stationAe, 'station-ae')
    : connection.callingAe;

  // PerformedProcedureStepID is Type 1 too. Falling back to the scheduled step
  // ID is what most modalities do and it keeps the two IDs correlatable; when
  // there is no scheduled step either, it stays empty and the Type 1 check
  // refuses rather than inventing one.
  const stepId = flagValue('step-id');
  attrs.performedProcedureStepId = stepId !== undefined
    ? stepId
    : (attrs.scheduledProcedureStepId || '');

  return { attrs, source };
}

/**
 * Turns an N-service round trip into a verdict.
 *
 * Four outcomes have to be told apart, because they have four different fixes:
 * the association never completed; the peer accepted the association but
 * refused the MPPS presentation context; the context was accepted but no
 * response arrived; and a response arrived carrying a status.
 *
 * @param {object} result From mpps.sendNRequest().
 * @param {string} verb  'N-CREATE' or 'N-SET'.
 * @returns {{ok: boolean, reason: string, lines: string[], status?: object}}
 */
function describeNResult(result, verb) {
  const { outcome, status, comment, contextAccepted } = result;

  if (outcome.kind !== 'completed') {
    return { ok: false, reason: 'association', lines: formatOutcome(outcome) };
  }

  if (!contextAccepted) {
    return {
      ok: false,
      reason: 'no-mpps-context',
      lines: [
        'This peer does not support MPPS.',
        '',
        'It accepted the association and then refused the presentation context for the',
        `Modality Performed Procedure Step SOP Class (${mpps.MPPS_SOP_CLASS}), so the`,
        `${verb} was never carried. Nothing was sent and nothing changed on the far end.`,
        '',
        'MPPS is frequently handled by a different system from the one that stores images —',
        'a RIS or a broker rather than the archive. Check which host and AE Title the site',
        'expects MPPS on. Run again with --verbose to see the refused context.',
      ],
    };
  }

  if (status === undefined) {
    return {
      ok: false,
      reason: 'no-response',
      lines: [
        `The association was established and released, but the peer never answered the ${verb}.`,
        'The MPPS presentation context was accepted, so this is not a negotiation problem —',
        'the peer took the request and said nothing. Check its logs for the matching',
        'timestamp; nothing here can tell whether it acted on the request or dropped it.',
      ],
    };
  }

  const described = statusLib.describe(status, comment);
  if (described.class === statusLib.Class.SUCCESS) {
    return { ok: true, reason: 'success', lines: [], status: described };
  }

  const lines = [`${described.code} ${described.label}`, described.plain];
  if (described.hint) lines.push(`  ${described.hint}`);
  if (described.peerComment) lines.push(`  peer said: ${described.peerComment}`);
  return {
    ok: false,
    reason: described.class === statusLib.Class.WARNING ? 'warning' : 'refused',
    lines,
    status: described,
  };
}

/**
 * Prints a describeNResult() verdict.
 *
 * @param {object} verdict
 */
function reportNResult(verdict) {
  for (const line of verdict.lines) log.out(line);
}

/**
 * Renders a dataset for `--dry-run`, so what would go on the wire can be read
 * before it does.
 *
 * @param {Record<string, unknown>} dataset
 * @returns {string}
 */
function formatDataset(dataset) {
  return JSON.stringify(dataset, null, 2);
}

module.exports = {
  CONNECTION_FLAGS,
  ATTRIBUTE_FLAGS,
  resolveConnection,
  resolveStoreConnection,
  timeoutsFrom,
  resolveAttributes,
  describeNResult,
  reportNResult,
  formatDataset,
};
