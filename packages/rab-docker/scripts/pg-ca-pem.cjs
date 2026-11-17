'use strict';
/**
 * The database CA validation of packages/rab-server/src/database/postgres/pg-tls.ts (validatePgCaPem / readPgCaFile),
 * ported to dependency-free CommonJS for the operator tools that cannot load the TypeScript: the env-file lint
 * (compose-owner-login.cjs, PG_SSL_CA_CERT in database.env) and the --environment preflight
 * (staging/verify-image-compose.cjs, the CREWFLOW_PG_CA_FILE mounted as PG_SSL_CA_CERT_PATH). Same rules, same order:
 *   - at most 256 KiB;
 *   - `\n` escapes become newlines, CRLF becomes LF;
 *   - BEGIN/END markers balanced (counted before any block is matched);
 *   - no base64 run of 64+ characters outside the PEM blocks (key material without its armour);
 *   - every block's BEGIN and END labels equal, every block a CERTIFICATE (a PRIVATE KEY is called out), valid base64 that
 *     X509Certificate parses; at least one block.
 * rab-server's pg-ca-pem-parity.spec.ts runs this port and the TypeScript over one corpus and requires the same verdict and
 * the same normalised output, so the two cannot drift silently. Messages name the label only, never the text.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');

const PG_CA_PEM_MAX_BYTES = 256 * 1024;
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END ([A-Z0-9 ]+)-----/g;

/** The validated, normalised PEM (certificates only), or throws an Error whose message names `label` only. */
function validatePgCaPem(raw, label) {
  const refuse = (why) => {
    throw new Error(`${label} ${why}`);
  };
  const input = String(raw);
  if (Buffer.byteLength(input, 'utf8') > PG_CA_PEM_MAX_BYTES) refuse(`is larger than ${PG_CA_PEM_MAX_BYTES / 1024} KiB; use your provider's regional CA bundle.`);
  const text = input.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n?/g, '\n');
  const begins = text.split('-----BEGIN ').length - 1;
  const ends = text.split('-----END ').length - 1;
  if (begins !== ends) refuse('contains an incomplete PEM block (a BEGIN line without its END line, or the reverse).');
  if (/[A-Za-z0-9+/=]{64,}/.test(text.replace(PEM_BLOCK, ''))) {
    refuse('holds a long base64 run outside the PEM blocks, which looks like key material. It must hold only CA certificate(s).');
  }
  const certificates = [];
  for (const [, beginLabel, body, endLabel] of text.matchAll(PEM_BLOCK)) {
    if (beginLabel !== endLabel) refuse('contains a PEM block whose BEGIN and END labels differ.');
    if (beginLabel !== 'CERTIFICATE') {
      refuse(
        /PRIVATE KEY/.test(beginLabel)
          ? 'contains a PRIVATE KEY block. It must hold only CA certificate(s): remove the key, and treat that key as exposed.'
          : `contains a "${beginLabel}" PEM block; only CERTIFICATE blocks are accepted.`,
      );
    }
    const base64 = body.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) refuse(`certificate ${certificates.length + 1} is not valid base64.`);
    const pem = `-----BEGIN CERTIFICATE-----\n${base64.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
    try {
      new crypto.X509Certificate(pem);
    } catch {
      refuse(`certificate ${certificates.length + 1} is not a parseable X.509 certificate.`);
    }
    certificates.push(pem);
  }
  if (certificates.length === 0) refuse('does not contain a PEM certificate (-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----).');
  if (begins !== certificates.length) refuse('contains an incomplete PEM block (a BEGIN line without its END line, or the reverse).');
  return certificates.join('');
}

/** null when the text is a valid CA, else the problem (label only, never the text). */
function pgCaPemProblem(raw, label) {
  try {
    validatePgCaPem(raw, label);
    return null;
  } catch (error) {
    return error.message;
  }
}

/**
 * A CA FILE as the app reads it (pg-tls.ts readPgCaFile): opened read-only and non-blocking, fstat-checked before reading
 * (a regular file of at most 256 KiB), then validated. null when it is fine, else the problem. Never prints the path's
 * contents; `label` names it.
 */
function pgCaFileProblem(file, label) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return `${label} cannot be read.`;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return `${label} is not a regular file.`;
    if (stat.size > PG_CA_PEM_MAX_BYTES) return `${label} is larger than ${PG_CA_PEM_MAX_BYTES / 1024} KiB; use your provider's regional CA bundle.`;
    return pgCaPemProblem(fs.readFileSync(fd, 'utf8'), label);
  } catch {
    return `${label} cannot be read.`;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { PG_CA_PEM_MAX_BYTES, validatePgCaPem, pgCaPemProblem, pgCaFileProblem };
