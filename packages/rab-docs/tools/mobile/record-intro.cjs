#!/usr/bin/env node
// Native Flutter recordings for the introduction film (real debug app on the Pixel_5 emulator → mobile-fixture-server.cjs).
//
//   node tools/mobile/record-intro.cjs <scene> --out <dir>      scenes: request | offer
//
// Each scene: pins the device clock to the story moment, loads the fixture scene, signs in OFF-camera (credentials are
// never recorded), navigates to the start screen, then records with the emulator's host-side screen recorder while
// driving the app by its semantics labels. Writes <dir>/<scene>.webm and <scene>.marks.json (seconds from record start).
// Nothing in the app is patched; the demo backend is synthetic and fictional.
'use strict';
const fs = require('fs');
const path = require('path');
const d = require('./drive.cjs');

const scene = process.argv[2];
const out = path.resolve(process.argv[process.argv.indexOf('--out') + 1] || '.');
fs.mkdirSync(out, { recursive: true });
const pause = (s) => d.sleep(s * 1000);

const SCENES = {
  // Tuesday 10:15 — Riley requests four Waiting staff for Friday; one availability warning; submit for approval.
  async request() {
    d.setDeviceTime('2026-10-20T09:15:00Z', '1015');
    await d.fixture('/__fixture/scene', { scene: 'request' });
    await d.freshApp();
    await d.tap('Get Started', { after: 1500 });
    await d.login('riley.chen@example.test');
    await d.tap('My Space', { after: 1500 });
    await d.tap('Staffing requests', { after: 2500 });
    d.rec.start(path.join(out, 'request.webm'));
    await pause(1.2);
    d.rec.mark('sent-empty');
    await d.tapXY(970, 218, 'Send Shift', 2200);
    d.rec.mark('form');
    await d.tap('Select venue', { after: 900 });
    await d.tap('Riverside House', { after: 900 });
    await d.tap('Select role', { after: 900 });
    await d.tap('Waiting staff', { after: 900 });
    await d.tap(/^Date/, { after: 1200 });
    await d.tap('23, Friday', { after: 700 });
    await d.tap(/^OK$/, { after: 900 });
    for (const [field, hh] of [[/^09:00$/, '12'], [/^17:00$/, '6']]) {
      await d.tap(field, { after: 1100 });
      if (d.find('Switch to text input mode')) await d.tap('Switch to text input mode', { after: 800 });
      await d.tapXY(287, 1117, 'hours', 400);
      d.shell('input keyevent KEYCODE_MOVE_END'); d.shell('input keyevent KEYCODE_DEL'); d.shell('input keyevent KEYCODE_DEL');
      await d.typeText(hh, { charDelay: 120 });
      await d.tap(/^PM$/, { after: 400 });
      await d.tap(/^OK$/, { after: 900 });
    }
    await d.tapXY(540, 1140, 'Break', 600);
    await d.typeText('30', { charDelay: 150 });
    d.back(); await pause(0.8);
    d.rec.mark('form-filled');
    await d.tap('Select staff', { after: 2000 });
    d.rec.mark('picker', { bbox: await d.box('Maya Lindqvist') });
    await pause(1.0);
    for (const n of ['Priya Shah', 'Grace Kim', 'Leah Fischer', 'Isla Moore']) await d.tap(n, { after: 650 });
    d.rec.mark('picked');
    await pause(0.8);
    await d.tap(/^Done$/, { after: 1800 });
    d.rec.mark('four-selected');
    await pause(1.0);
    await d.tap('Send Shift Offer', { after: 2200 });
    d.rec.mark('warning', { bbox: await d.box('Staff availability warning') });
    await pause(2.6);
    await d.tap('Submit anyway', { after: 2200 });
    d.rec.mark('submitted', { bbox: await d.box('Shift submitted successfully') });
    await pause(2.6);
    await d.tap(/^Done$/, { after: 2000 });
    d.rec.mark('pending', { bbox: await d.box('Pending approval') });
    await pause(3.0);
  },
  // Tuesday 11:40 — Priya opens her offer and accepts; the approved request books her straight away.
  async offer() {
    d.setDeviceTime('2026-10-20T10:40:00Z', '1140');
    await d.fixture('/__fixture/scene', { scene: 'offer' });
    await d.freshApp();
    await d.tap('Get Started', { after: 1500 });
    await d.login('priya.shah@example.test');
    await pause(1.5);
    d.rec.start(path.join(out, 'offer.webm'));
    await pause(1.5);
    d.rec.mark('home');
    await d.tapXY(806, 1000, 'Open Shift Offers', 2200);
    d.rec.mark('offers', { bbox: await d.box('estimated pay') });
    await pause(2.4);
    await d.tap('Open Waiting staff', { after: 2200 });
    d.rec.mark('details', { bbox: await d.box('Shift status') });
    await pause(2.2);
    await d.tap(/^Accept$/, { after: 2500 });
    d.rec.mark('confirmed', { bbox: await d.box('Shift status: Confirmed') });
    await pause(3.2);
  },
  // Friday 11:47 — Priya's confirmed shift; clock-in screen, location consent, the real scanner (simulated camera).
  // The emulator camera cannot see a QR, so the clock-in is posted to the demo server's clock-in endpoint as a stand-in
  // for the scan (disclosed in the film and the report); the app then shows its own LIVE SHIFT state.
  async shiftday() {
    d.setDeviceTime('2026-10-23T10:47:00Z', '1147');
    await d.fixture('/__fixture/scene', { scene: 'shiftday', now: '2026-10-23T11:47:00+01:00' });
    await d.freshApp();
    await d.tap('Get Started', { after: 1500 });
    await d.login('priya.shah@example.test');
    await pause(1.5);
    d.rec.start(path.join(out, 'shiftday.webm'));
    await pause(1.5);
    d.rec.mark('home', { bbox: await d.box("Today's Shift") });
    await pause(2.0);
    await d.tap(/^Clock in$/, { after: 2400 });
    d.rec.mark('clock', { bbox: await d.box('STARTS IN') });
    await pause(2.0);
    await d.tapXY(540, 2181, 'Clock in', 1800);
    d.rec.mark('location', { bbox: await d.box("Confirm you're on site") });
    await pause(2.0);
    await d.tap('Continue', { after: 1500 });
    await d.tap('While using the app', { after: 2500 });
    d.rec.mark('scanner', { bbox: await d.box('Scan venue QR') });
    await pause(2.5);
    const api = await d.apiAs('priya.shah@example.test');
    const offers = await api.call('GET', '/offers/mine');
    const shiftId = (offers.data || offers).find((o) => o.status === 'manager_confirmed').shiftId;
    d.rec.mark('standin-clock-in');
    await api.call('POST', '/attendance/clock-in', { shiftId, qrToken: 'film-stand-in-for-camera-scan' });
    await d.tap('Cancel scan', { after: 2200 });
    d.rec.mark('live', { bbox: await d.box('LIVE SHIFT') });
    await pause(7.0);
  },
  // Friday 18:02 — Priya ends her shift; the same stand-in records the clock-out scan; the app shows Clocked Out.
  async clockout() {
    d.setDeviceTime('2026-10-23T17:02:00Z', '1802');
    await d.fixture('/__fixture/scene', { scene: 'clockout' });
    await d.freshApp();
    await d.tap('Get Started', { after: 1500 });
    await d.login('priya.shah@example.test');
    await pause(1.5);
    d.rec.start(path.join(out, 'clockout.webm'));
    await pause(1.2);
    await d.tap(/^Clock out$/, { after: 2400 });
    d.rec.mark('live', { bbox: await d.box('LIVE SHIFT') });
    await pause(3.0);
    await d.tapXY(540, 2181, 'Clock out', 1800);
    d.rec.mark('end', { bbox: await d.box('End your shift?') });
    await pause(1.8);
    await d.tapXY(540, 2010, 'Clock out (confirm)', 2000);
    if (d.find("Confirm you're on site")) { await d.tap('Continue', { after: 1500 }); if (d.find('While using the app')) await d.tap('While using the app', { after: 2500 }); }
    d.rec.mark('scanner', { bbox: await d.box('Scan venue QR') });
    await pause(2.0);
    const api = await d.apiAs('priya.shah@example.test');
    d.rec.mark('standin-clock-out');
    await api.call('POST', '/attendance/clock-out', { qrToken: 'film-stand-in-for-camera-scan' });
    await d.tap('Cancel scan', { after: 1500 });
    d.back(); await pause(1.5);
    await d.swipe(540, 700, 540, 1500, 500);
    await pause(2.0);
    d.rec.mark('clocked-out', { bbox: await d.box('Clocked Out') });
    await pause(3.5);
  },
  // Friday 18:40 — Riley reviews the hours: corrects Isla's missing clock-out (with a reason), marks each person
  // reviewed, looks at the optional rating tab, signs off and sends; the delivery state moves on; the real PDF opens.
  // Run the fixture with FIXTURE_PDF_MIN_SECONDS=4 FIXTURE_DELIVERY_SECONDS=7 so the states change on camera.
  async review() {
    d.setDeviceTime('2026-10-23T17:40:00Z', '1840');
    await d.fixture('/__fixture/scene', { scene: 'review' });
    await d.freshApp();
    await d.tap('Get Started', { after: 1500 });
    await d.login('riley.chen@example.test');
    await d.tap('My Space', { after: 1500 });
    await d.tap(/^Reports/, { after: 2500 });
    d.rec.start(path.join(out, 'review.webm'));
    await pause(1.5);
    d.rec.mark('reports', { bbox: await d.box('Needs attendance review') });
    await pause(1.2);
    await d.tapXY(540, 965, 'report', 2200);
    d.rec.mark('report', { bbox: await d.box('clock-out time needs checking') });
    await pause(2.2);
    await d.swipe(540, 1700, 540, 1000, 700);
    d.rec.mark('missing', { bbox: await d.box('Isla Moore') });
    await pause(2.4);
    const islaBtn = d.nodes().filter((n) => /^Review hours$/.test(n.desc || n.text) && n.y1 > d.find('Isla Moore').y1)[0];
    await d.tapXY(540, Math.round((islaBtn.y1 + islaBtn.y2) / 2), 'Review hours (Isla)', 2200);
    await d.tap(/^Clock out$/, { after: 1000 });
    await d.swipe(540, 1700, 540, 1000, 700);
    await d.tap('Select time', { after: 1300 });
    await d.tap(/^OK$/, { after: 1000 });
    await d.swipe(540, 1700, 540, 1100, 600);
    d.rec.mark('correction', { bbox: await d.box('Reason for correction') });
    await d.tapXY(540, 1710, 'reason', 700);
    await d.typeText('Left at 18:00 after handover, forgot to scan out', { charDelay: 40 });
    d.back(); await pause(0.8);
    await d.tap('Save correction', { after: 2200 });
    d.rec.mark('corrected', { bbox: await d.box('Corrected') });
    await pause(2.4);
    await d.tap(/^Mark reviewed$/, { after: 2200 });
    d.rec.mark('isla-reviewed', { bbox: await d.box('Isla Moore') });
    await pause(1.4);
    // Grace: show the separate, optional rating tab, then mark her hours reviewed.
    await d.swipe(540, 700, 540, 1700, 500);
    const graceBtn = d.nodes().filter((n) => /^Review hours$/.test(n.desc || n.text))[0];
    await d.tapXY(540, Math.round((graceBtn.y1 + graceBtn.y2) / 2), 'Review hours (Grace)', 2200);
    await d.tap(/^Staff review$/, { after: 1800 });
    d.rec.mark('rating', { bbox: await d.box('Staff performance') });
    await pause(2.2);
    await d.tap(/^Attendance$/, { after: 1200 });
    await d.tap(/^Mark reviewed$/, { after: 2200 });
    for (const who of ['Leah Fischer', 'Priya Shah']) {
      for (let i = 0; i < 4 && !(d.find(who) && d.find(who).y2 < 1900); i++) await d.swipe(540, 1700, 540, 1100, 450);
      const card = d.find(who);
      const btn = d.nodes().filter((n) => /^Review hours$/.test(n.desc || n.text) && n.y1 > card.y1)[0];
      await d.tapXY(540, Math.round((btn.y1 + btn.y2) / 2), `Review hours (${who})`, 2000);
      await d.tap(/^Mark reviewed$/, { after: 2000 });
    }
    for (let i = 0; i < 3; i++) await d.swipe(540, 1700, 540, 900, 400);
    d.rec.mark('all-reviewed', { bbox: await d.box('Finalise & send') });
    await pause(2.0);
    split('review', 'finalise');   // the emulator recorder stops at 180 s — continue in a second file
    await pause(1.0);
    d.rec.mark('all-reviewed', { bbox: await d.box('Finalise & send') });
    await d.tap('Finalise & send', { after: 1800 });
    d.rec.mark('signoff', { bbox: await d.box('Sign off the timesheet') });
    await pause(1.6);
    await d.tapXY(540, 1366, 'confirm breaks', 900);
    await d.tapXY(540, 1660, 'name', 700);
    await d.typeText('Riley Chen', { charDelay: 90 });
    d.back(); await pause(1.0);
    await d.tap('Sign & send', { after: 1500 });
    d.rec.mark('finalised');
    for (let i = 0; i < 5; i++) await d.swipe(540, 700, 540, 1700, 350);
    for (let k = 0; k < 8; k++) {           // the app's own delivery labels, refreshed by pulling down
      const b = d.find(/Generating PDF|Queued for delivery/);
      if (b) d.rec.mark(`state:${(b.text || b.desc).split(' The')[0]}`, { bbox: { x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 } });
      else break;
      await pause(2.0);
      await d.swipe(540, 700, 540, 1500, 400);
    }
    d.back(); await pause(2.0);
    d.rec.mark('sent', { bbox: await d.box(/^Sent/) });
    await pause(2.2);
    await d.tapXY(540, 925, 'report', 2000);
    await d.tap('Time-sheet', { after: 4500 });
    d.rec.mark('pdf', { bbox: await d.box('Final timesheet') });
    await pause(5.0);
  },
  // Saturday 09:10 — the finished shift is in Riley's History.
  async history() {
    d.setDeviceTime('2026-10-24T08:10:00Z', '0910');
    await d.fixture('/__fixture/scene', { scene: 'history' });
    await d.freshApp();
    await d.tap('Get Started', { after: 1500 });
    await d.login('riley.chen@example.test');
    await d.tap('My Space', { after: 1500 });
    d.rec.start(path.join(out, 'history.webm'));
    await pause(1.5);
    await d.tap(/^History/, { after: 2500 });
    d.rec.mark('history', { bbox: await d.box('Riverside House') });
    await pause(4.0);
  },
};

function writeMarks(name, r) {
  fs.writeFileSync(path.join(out, `${name}.marks.json`), JSON.stringify({ scene: name, recordedAt: new Date().toISOString(), device: 'Pixel_5 emulator 1080x2340', fixture: 'tools/mobile-fixture-server.cjs (synthetic, fictional)', marks: r.marks, taps: r.taps }, null, 2));
  console.log(`✓ ${name}: ${r.marks.length} marks, ${r.taps.length} taps → ${r.file}`);
}
let current = scene;
function split(from, to) { const r = d.rec.stop(); writeMarks(from, r); d.rec.start(path.join(out, `${to}.webm`)); current = to; }

(async () => {
  if (!SCENES[scene]) throw new Error(`unknown scene ${scene}; known: ${Object.keys(SCENES).join(', ')}`);
  try { await SCENES[scene](); } finally {
    if (d.rec.t0) {
      const r = d.rec.stop();
      await d.sleep(2500);
      writeMarks(current, r);
    }
  }
})().catch((e) => { console.error(`✗ ${scene}: ${e.message}`); process.exitCode = 1; });
