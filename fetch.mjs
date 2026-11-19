// TechPatraa - Cricket data fetcher (GitHub Actions)
// Runs every 5 min via workflow; this script decides by itself whether to call the API.
// Free mode: ~74 hits/day (limit 100).  Paid mode: scorecard + ball-by-ball for live matches.
import fs from 'node:fs';

const KEY  = process.env.CRIC_API_KEY;
const MODE = (process.env.CRIC_MODE || 'free').toLowerCase();
const FORCE = !!process.env.FORCE;
const OUT = 'cricket.json';

const CFG = MODE === 'paid'
  ? { minGapMin: 4,  upcomingEveryH: 1,  extras: true,  maxLive: 2, refreshMin: 5,  reserve: 60 }
  : { minGapMin: 19, upcomingEveryH: 12, extras: false, maxLive: 0, refreshMin: 20, reserve: 5 };

function readPrev() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return { matches: [] }; }
}

async function api(path, params = {}) {
  const u = new URL('https://api.cricapi.com/v1/' + path);
  u.searchParams.set('apikey', KEY);
  for (const k of Object.keys(params)) u.searchParams.set(k, params[k]);
  const r = await fetch(u);
  if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
  const j = await r.json();
  if (j.status !== 'success') throw new Error(path + ' -> ' + (j.reason || j.status));
  return j;
}

function inferType(m) {
  const t = String(m.matchType || '').toUpperCase();
  if (t) return t;
  const n = String(m.name || '');
  if (/\btest\b/i.test(n)) return 'TEST';
  if (/t20/i.test(n)) return 'T20';
  if (/\bodi\b/i.test(n)) return 'ODI';
  return '';
}

function norm(m) {
  const info = m.teamInfo || [];
  const names = (m.teams && m.teams.length) ? m.teams : info.map(t => t.name);
  const teams = names.map(n => {
    const ti = info.find(t => t.name === n) || {};
    const scores = (m.score || [])
      .filter(s => String(s.inning || '').toLowerCase().indexOf(String(n).toLowerCase()) === 0)
      .map(s => ({ r: s.r, w: s.w, o: s.o }));
    return { name: n, short: ti.shortname || String(n).slice(0, 3).toUpperCase(), img: ti.img || '', scores };
  });
  const started = !!m.matchStarted, ended = !!m.matchEnded;
  let iso = m.dateTimeGMT || null;
  if (iso && !/Z$/.test(iso)) iso += 'Z';
  const type = inferType(m);
  // API kabhi purane match ko "ended=false" chhod deti hai; aise purane match ko live na maanein
  const maxAge = type === 'TEST' ? 6 * 864e5 : 20 * 36e5;
  const stale = started && !ended && iso && (Date.now() - Date.parse(iso)) > maxAge;
  return {
    id: m.id, name: m.name || '', type,
    status: m.status || '', venue: m.venue || '', start: iso,
    started, ended, live: started && !ended && !stale, stale: !!stale, teams
  };
}

function normCard(j) {
  const sc = (j.data && j.data.scorecard) || [];
  return sc.map(i => ({
    inning: i.inning || '',
    batting: (i.batting || []).map(b => ({
      name: b.batsman && b.batsman.name, r: b.r, b: b.b, f: b['4s'], s: b['6s'], sr: b.sr,
      out: b['dismissal-text'] || b.dismissal || ''
    })),
    bowling: (i.bowling || []).map(b => ({
      name: b.bowler && b.bowler.name, o: b.o, m: b.m, r: b.r, w: b.w, eco: b.eco
    }))
  }));
}

function normBbb(j) {
  const arr = (j.data && (j.data.bbb || j.data.balls)) || [];
  return arr.slice(-15).reverse().map(b => ({
    over: (b.over !== undefined ? b.over : (b.ball !== undefined ? b.ball : '')),
    text: b.commentary || b.text || b.description || b.score || ''
  })).filter(x => x.text);
}

const prev = readPrev();
const now = Date.now();

if (!KEY) { console.log('CRIC_API_KEY set nahi hai - skip'); process.exit(0); }
if (!FORCE && prev.updated && (now - Date.parse(prev.updated)) / 60000 < CFG.minGapMin) {
  console.log('Abhi update ki zaroorat nahi - skip'); process.exit(0);
}

try {
  const cur = await api('currentMatches', { offset: 0 });
  let hitsToday = cur.info && cur.info.hitsToday, hitsLimit = cur.info && cur.info.hitsLimit;
  const budgetLeft = () => (hitsLimit && hitsToday != null) ? (hitsLimit - hitsToday) : 999;

  const list = (cur.data || []).map(norm);

  // Upcoming list (kam baar mangwate hain, hits bachane ke liye)
  let upcomingAt = prev.upcomingAt || null;
  let upcoming = [];
  const needUp = !upcomingAt || (now - Date.parse(upcomingAt)) / 3600000 >= CFG.upcomingEveryH;
  if (needUp && budgetLeft() > CFG.reserve) {
    try {
      const up = await api('matches', { offset: 0 });
      upcoming = (up.data || []).map(norm).filter(m => !m.started && m.start && Date.parse(m.start) > now);
      upcomingAt = new Date().toISOString();
      if (up.info) { hitsToday = up.info.hitsToday; }
    } catch (e) { console.log('upcoming fail:', e.message); }
  }
  if (!upcoming.length) {
    upcoming = (prev.matches || []).filter(m => !m.started && m.start && Date.parse(m.start) > now);
  }

  const seen = {};
  let all = [];
  list.concat(upcoming).forEach(m => { if (m.id && !seen[m.id] && !m.stale && m.teams.length >= 2 && !m.teams.some(t => /^\s*tbc\s*$/i.test(String(t.name)))) { seen[m.id] = 1; all.push(m); } });

  const live = all.filter(m => m.live).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const up   = all.filter(m => !m.started && !m.ended).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, 24);
  const done = all.filter(m => m.ended).sort((a, b) => Date.parse(b.start) - Date.parse(a.start)).slice(0, 10);

  // Paid mode: scorecard + ball-by-ball (live matches ke liye)
  if (CFG.extras) {
    for (const m of live.slice(0, CFG.maxLive)) {
      if (budgetLeft() <= CFG.reserve) break;
      try { m.card = normCard(await api('match_scorecard', { id: m.id })); } catch (e) { console.log('scorecard fail:', e.message); }
      if (budgetLeft() <= CFG.reserve) break;
      try { const b = normBbb(await api('match_bbb', { id: m.id })); if (b.length) m.bbb = b; } catch (e) { console.log('bbb fail:', e.message); }
    }
  }

  const out = {
    updated: new Date().toISOString(), upcomingAt, mode: MODE, refreshMin: CFG.refreshMin,
    matches: live.concat(up, done).map(m => { delete m.stale; return m; })
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('OK:', live.length, 'live,', up.length, 'upcoming,', done.length, 'done. mode=' + MODE);
} catch (e) {
  console.log('API error:', e.message, '- purana data rakha');
  process.exit(0);
}
