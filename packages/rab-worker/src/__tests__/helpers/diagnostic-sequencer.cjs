// TEMPORARY CI DIAGNOSTIC (revert): run the PDF suites first so their results fall inside nx's captured output head.
const Sequencer = require('@jest/test-sequencer').default;
const FIRST = /(render-pdf-switch|native-pdf|final-timesheet-renderer-parity|render-pdf\.util|render-pdf-|attendance-lifecycle-42|report-)/;
class PdfFirst extends Sequencer {
  sort(tests) {
    const sorted = super.sort(tests);
    return [...sorted.filter((t) => FIRST.test(t.path)), ...sorted.filter((t) => !FIRST.test(t.path))];
  }
}
module.exports = PdfFirst;
