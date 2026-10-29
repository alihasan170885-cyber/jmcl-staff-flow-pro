'use strict';

/** Round to 2 decimals, avoiding binary floating point drift (e.g. 1.005). */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const fmtMoney = (n, currency = '') =>
  `${currency ? currency + ' ' : ''}${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

module.exports = { round2, fmtMoney };
