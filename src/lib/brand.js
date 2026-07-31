'use strict';

const log = require('./log');

/**
 * Branding, kept in one file on purpose.
 *
 * Everything visual — wordmark, accent colour, banner shape — lives here so the
 * theme can be changed in one place rather than hunted through command output.
 * Nothing else in the codebase should hard-code a brand colour.
 *
 * The accent is a plain ANSI colour rather than a 256-colour or truecolor
 * escape, so it survives PuTTY, older cmd.exe, CI logs and anything else that
 * only understands the basic sixteen. It degrades to plain text automatically
 * when output is redirected or NO_COLOR is set, because a banner full of escape
 * sequences in a log file helps nobody.
 */

const PRODUCT = 'NewLumen';
const TOOL = 'DICOM CLI Agent';
const TAGLINE = 'DICOM network operations for folders of DICOM files';

/** Accent used for the wordmark, rules and prompts. */
const accent = (text) => log.color.cyan(text);
const accentBold = (text) => log.color.bold(log.color.cyan(text));

/** True when we can reasonably draw box characters and colour. */
function decorated() {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

/**
 * The compact product banner.
 *
 * Deliberately small. A full-screen ASCII logo above every invocation is
 * something people learn to scroll past, and it wrecks piped output.
 *
 * @param {string} version
 * @returns {string}
 */
function banner(version) {
  if (!decorated()) {
    return `${PRODUCT} ${TOOL} v${version}`;
  }

  const WIDTH = 58;

  // Padding must be measured on the plain text. Colouring first and then
  // padding counts the ANSI escape bytes as visible characters, which is why
  // hand-tuned banner widths drift the moment the version string changes.
  const wordmark = '  ◈ N E W L U M E N';
  const subtitle = `  ${TOOL} · v${version}`;

  const row = (plain, paint) =>
    `${accent('│')}${paint(plain)}${' '.repeat(Math.max(0, WIDTH - plain.length))}${accent('│')}`;

  return [
    accent(`┌${'─'.repeat(WIDTH)}┐`),
    row(wordmark, accentBold),
    row(subtitle, log.color.dim),
    accent(`└${'─'.repeat(WIDTH)}┘`),
  ].join('\n');
}

/** A horizontal rule in the accent colour. */
function rule(width = 72) {
  return accent('─'.repeat(width));
}

/** A section heading. */
function heading(text) {
  return accentBold(text);
}

module.exports = {
  PRODUCT,
  TOOL,
  TAGLINE,
  accent,
  accentBold,
  banner,
  rule,
  heading,
  decorated,
};
