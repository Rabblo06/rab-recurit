// Uploads deterministic synthetic images through the REAL API (same counts as the 2026-10-26 audit): an avatar
// (~100 KB PNG) for 4 staff (mobile) + the workspace-owner manager (web) per org, and one venue photo (~500 KB) per org.
const { loginWeb, loginMobile, call, psql, noisePng, writeJson } = require('./lib');

(async () => {
  const orgs = Number(process.env.ORGS || 20);
  const out = { avatars: [], venuePhotos: [] };
  let seed = 1;
  const upload = async (auth, url, bytes) => {
    const fd = new FormData();
    fd.append('file', new Blob([noisePng(bytes, seed++)], { type: 'image/png' }), bytes > 200_000 ? 'venue.png' : 'avatar.png');
    return call(auth, 'POST', url, fd);
  };
  for (let o = 1; o <= orgs; o++) {
    const dom = `org${String(o).padStart(2, '0')}.example.test`;
    for (let s = 1; s <= 4; s++) {
      const r = await upload(await loginMobile(`staff${String(s).padStart(2, '0')}@${dom}`), '/rest/v1/profile/avatar', 100 * 1024);
      out.avatars.push({ org: o, staff: s, status: r.status, bytes: r.bytes });
    }
    const mgr = await loginWeb(`manager1@${dom}`);
    const ra = await upload(mgr, '/rest/v1/profile/avatar', 100 * 1024);
    out.avatars.push({ org: o, manager: 1, status: ra.status });
    const venueId = psql(`select v.id from core.venue v join core.organisation g on g.id=v.organisation_id where g.slug='costaudit-${String(o).padStart(2, '0')}' order by v.name limit 1`);
    const rv = await upload(mgr, `/rest/v1/venues/${venueId}/photo`, 500 * 1024);
    out.venuePhotos.push({ org: o, venueId, status: rv.status, err: rv.status >= 300 ? rv.body.toString().slice(0, 200) : undefined });
  }
  const bad = [...out.avatars, ...out.venuePhotos].filter((x) => x.status >= 300);
  out.summary = { avatars: out.avatars.length, venuePhotos: out.venuePhotos.length, failures: bad.length };
  writeJson('files-upload.json', out);
  console.log(JSON.stringify(out.summary));
  if (bad.length) { console.error('upload failures', JSON.stringify(bad.slice(0, 3))); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
