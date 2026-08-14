/* FBSimCity — machine room.
 *
 * Drives the real Firebird engine (Electric Firebird's WebAssembly build)
 * from this page, so the city's claims can be settled rather than believed.
 *
 * The engine is loaded from the Electric Firebird demo deployment. That is a
 * same-origin path on GitHub Pages, which is the only reason this can be an
 * embed at all: the engine is built with pthreads, so it needs
 * `SharedArrayBuffer`, which needs a cross-origin isolated page, which needs
 * COOP/COEP headers that GitHub Pages will not send — coi-serviceworker
 * synthesises those for this page, and same-origin subresources are allowed
 * under `require-corp` without any header of their own. A cross-origin CDN
 * copy would need CORP on every asset and is not worth the fragility.
 *
 * The cost is a real dependency on another project's published build. When it
 * moves, this page says so in plain words instead of showing an empty box.
 *
 * The engine module is imported dynamically rather than at the top, and that
 * is not a style choice: a static import that fails takes the whole module
 * down with it, so the sequences, the correspondence table and the honest
 * account of what this cannot do would all vanish along with the engine —
 * which is precisely when a reader most needs to see them.
 */
const ENGINE_BASE = '/electric-firebird/';
const DB_NAME = 'fbsimcity-machine';

const els = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  sql: document.getElementById('sql'),
  run: document.getElementById('run'),
  reset: document.getElementById('reset'),
  timing: document.getElementById('timing'),
  result: document.getElementById('result'),
  list: document.getElementById('sequence-list'),
  markers: document.getElementById('markers'),
  mapBody: document.getElementById('map-body'),
  isolation: document.getElementById('isolation-note'),
};

let db = null;
let busy = false;

/* ---- the sequences ---------------------------------------------------- *
 *
 * Every verdict is computed from what the engine actually returned. A
 * sequence that printed a conclusion regardless of the numbers would be the
 * same kind of decoration this page exists to replace.
 */
const SEQUENCES = [
  {
    id: 'txid',
    title: 'Every statement gets a transaction',
    blurb: 'The Transaction Hall stamps an id. So does the engine.',
    steps: [
      { sql: 'SELECT CURRENT_TRANSACTION AS TX FROM RDB$DATABASE', kind: 'query' },
      { sql: 'SELECT CURRENT_TRANSACTION AS TX FROM RDB$DATABASE', kind: 'query' },
    ],
    verdict(res) {
      const a = num(res[0], 'TX'), b = num(res[1], 'TX');
      if (a === null || b === null) return null;
      return {
        ok: b > a,
        text: b > a
          ? `Two identical statements, two ids: ${a} then ${b}. Nothing was ` +
            `shared between them. The city stamps a fresh id per query for ` +
            `the same reason — in Firebird a transaction is the unit that ` +
            `gets a number, and every statement here runs in its own.`
          : `Both statements reported ${a}. That is not what a fresh ` +
            `transaction per statement looks like — worth investigating.`,
      };
    },
  },
  {
    id: 'markers',
    title: 'OIT, OAT and Next are the engine\'s own words',
    blurb: 'The three markers the city draws, read from MON$DATABASE.',
    steps: [
      {
        sql: 'SELECT MON$OLDEST_TRANSACTION AS OIT,\n' +
             '       MON$OLDEST_ACTIVE AS OAT,\n' +
             '       MON$OLDEST_SNAPSHOT AS OST,\n' +
             '       MON$NEXT_TRANSACTION AS NEXT_TX\n' +
             '  FROM MON$DATABASE',
        kind: 'query',
      },
    ],
    verdict(res) {
      const r = row(res[0]);
      if (!r) return null;
      const oit = Number(r.OIT), next = Number(r.NEXT_TX);
      return {
        ok: next >= oit,
        text: `OIT ${r.OIT}, OAT ${r.OAT}, oldest snapshot ${r.OST}, next ` +
          `${r.NEXT_TX}. These are not FBSimCity's invention and not a ` +
          `simplification: they are columns in a monitoring table. The gap ` +
          `between OIT and next is ${next - oit} here, and in the city it is ` +
          `the distance garbage collection has to leave alone.`,
      };
    },
  },
  {
    id: 'mga',
    title: 'An UPDATE writes a version',
    blurb: 'Multi-generational architecture, counted by the engine.',
    steps: [
      { sql: 'RECREATE TABLE MGA_DEMO (ID INTEGER PRIMARY KEY, NAME VARCHAR(40))', kind: 'exec' },
      { sql: "INSERT INTO MGA_DEMO VALUES (1, 'first')", kind: 'exec' },
      { sql: "UPDATE MGA_DEMO SET NAME = 'second' WHERE ID = 1", kind: 'exec' },
      { sql: "UPDATE MGA_DEMO SET NAME = 'third' WHERE ID = 1", kind: 'exec' },
      { sql: 'SELECT NAME FROM MGA_DEMO WHERE ID = 1', kind: 'query' },
      {
        sql: 'SELECT r.MON$RECORD_INSERTS AS INSERTS,\n' +
             '       r.MON$RECORD_UPDATES AS UPDATES,\n' +
             '       r.MON$BACKVERSION_READS AS BACKVERSION_READS,\n' +
             '       r.MON$RECORD_PURGES AS PURGES\n' +
             '  FROM MON$DATABASE d\n' +
             '  JOIN MON$RECORD_STATS r ON r.MON$STAT_ID = d.MON$STAT_ID',
        kind: 'query',
      },
    ],
    verdict(res) {
      const r = row(res[5]);
      if (!r) return null;
      const back = Number(r.BACKVERSION_READS);
      // These counters are database-wide and cumulative — they include the
      // catalogue's own bookkeeping from the CREATE, so the totals are much
      // larger than the two updates just made. Say so, rather than letting
      // the reader assume two updates produced all of them.
      return {
        ok: back > 0,
        text: back > 0
          ? `Two updates to one row. The engine's counters — database-wide ` +
            `and cumulative, so they include the catalogue's own writes — now ` +
            `stand at ${r.UPDATES} updates, ${r.BACKVERSION_READS} ` +
            `back-version reads and ${r.PURGES} purges. The figure that ` +
            `settles it is the back-version reads: above zero means the ` +
            `engine had to walk past an older version of a row to reach the ` +
            `current one, because an update did not overwrite anything. That ` +
            `walk is what the city's towers draw as floors, and a purge is ` +
            `garbage collection removing a version nobody can reach.`
          : `${r.UPDATES} updates recorded and no back-version reads. The ` +
            `versions are written either way; whether the engine had to read ` +
            `past one depends on what garbage collection got to first. Run ` +
            `the sequence again.`,
      };
    },
  },
  {
    id: 'catalog',
    title: 'The catalogue is ordinary tables',
    blurb: 'RDB$ metadata you can select from, not a hidden format.',
    steps: [
      {
        sql: 'SELECT COUNT(*) AS SYSTEM_TABLES\n' +
             '  FROM RDB$RELATIONS WHERE RDB$SYSTEM_FLAG = 1',
        kind: 'query',
      },
      {
        sql: 'SELECT RDB$RELATION_NAME AS NAME\n' +
             '  FROM RDB$RELATIONS WHERE RDB$SYSTEM_FLAG = 1\n' +
             ' ORDER BY 1 ROWS 12',
        kind: 'query',
      },
    ],
    verdict(res) {
      const n = num(res[0], 'SYSTEM_TABLES');
      if (n === null) return null;
      return {
        ok: n > 0,
        text: `${n} system tables, queried with the same SELECT you would ` +
          `use on your own data. The city draws metadata as a district ` +
          `rather than a special region for exactly this reason: in Firebird ` +
          `the catalogue is not a separate mechanism, it is more rows.`,
      };
    },
  },
  {
    id: 'cache',
    title: 'A fetch is not a read',
    blurb: 'The page cache, in the engine\'s own counters.',
    steps: [
      {
        sql: 'SELECT i.MON$PAGE_FETCHES AS FETCHES,\n' +
             '       i.MON$PAGE_READS AS DISK_READS,\n' +
             '       i.MON$PAGE_WRITES AS DISK_WRITES,\n' +
             '       i.MON$PAGE_MARKS AS MARKS\n' +
             '  FROM MON$DATABASE d\n' +
             '  JOIN MON$IO_STATS i ON i.MON$STAT_ID = d.MON$STAT_ID',
        kind: 'query',
      },
    ],
    verdict(res) {
      const r = row(res[0]);
      if (!r) return null;
      const f = Number(r.FETCHES), rd = Number(r.DISK_READS);
      const ratio = f > 0 ? (1 - rd / f) * 100 : 0;
      return {
        ok: f > 0,
        text: `${f} fetches against ${rd} reads — a hit ratio of ` +
          `${ratio.toFixed(2)}%. A fetch is the engine asking for a page; a ` +
          `read is the storage having to supply it. The cache plaza in the ` +
          `city is this distinction and nothing else, and its ${r.MARKS} ` +
          `marks are pages dirtied, which is what makes an eviction cost a ` +
          `write instead of being free.`,
      };
    },
  },
  {
    id: 'nowal',
    title: 'No write-ahead log',
    blurb: 'What Firebird has instead, and the settings that govern it.',
    steps: [
      {
        sql: 'SELECT MON$FORCED_WRITES AS FORCED_WRITES,\n' +
             '       MON$PAGE_SIZE AS PAGE_SIZE,\n' +
             '       MON$PAGE_BUFFERS AS PAGE_BUFFERS,\n' +
             '       MON$SWEEP_INTERVAL AS SWEEP_INTERVAL\n' +
             '  FROM MON$DATABASE',
        kind: 'query',
      },
    ],
    verdict(res) {
      const r = row(res[0]);
      if (!r) return null;
      return {
        ok: true,
        text: `Page size ${r.PAGE_SIZE}, ${r.PAGE_BUFFERS} buffers, sweep ` +
          `interval ${r.SWEEP_INTERVAL}, forced writes ` +
          `${r.FORCED_WRITES}. There is no log setting in that list because ` +
          `there is no log: Firebird orders its page writes so the file on ` +
          `disk is always consistent, rather than writing intentions ahead ` +
          `and replaying them. Forced writes is the switch that decides ` +
          `whether those ordered writes wait for the storage to confirm ` +
          `them. Buffers and sweep interval are the same two knobs the ` +
          `city's control room exposes.`,
      };
    },
  },
];

/* City claim → the query that settles it. Rendered into the table so the two
 * lists cannot drift apart in the markup. */
const CORRESPONDENCE = [
  ['Transaction Hall stamps a new id per transaction',
   'SELECT CURRENT_TRANSACTION FROM RDB$DATABASE'],
  ['OIT / OAT / Next markers over the yard',
   'SELECT MON$OLDEST_TRANSACTION, MON$OLDEST_ACTIVE, MON$NEXT_TRANSACTION FROM MON$DATABASE'],
  ['Version towers grow a floor per UPDATE',
   'MON$RECORD_STATS: MON$RECORD_UPDATES, MON$BACKVERSION_READS'],
  ['Garbage collection removes unreachable versions',
   'MON$RECORD_STATS: MON$RECORD_PURGES, MON$RECORD_EXPUNGES'],
  ['The cache plaza hits and misses',
   'MON$IO_STATS: MON$PAGE_FETCHES against MON$PAGE_READS'],
  ['Dirty pages cost a write when evicted',
   'MON$IO_STATS: MON$PAGE_MARKS, MON$PAGE_WRITES'],
  ['Metadata is a district, not a special case',
   'SELECT RDB$RELATION_NAME FROM RDB$RELATIONS'],
  ['Sweep interval on the control room dial',
   'SELECT MON$SWEEP_INTERVAL FROM MON$DATABASE'],
];

// ---- helpers -------------------------------------------------------------

function row(res) {
  return res && res.rows && res.rows.length ? res.rows[0] : null;
}

function num(res, field) {
  const r = row(res);
  if (!r) return null;
  const v = Number(r[field]);
  return Number.isFinite(v) ? v : null;
}

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text;
}

function looksLikeQuery(sql) {
  return /^\s*(select|with|execute\s+block)/i.test(sql);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---- rendering -----------------------------------------------------------

function renderTable(into, res) {
  const fields = (res.fields && res.fields.length)
    ? res.fields.map((f) => f.name)
    : Object.keys(res.rows[0] || {});
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  fields.forEach((f) => hr.append(el('th', null, f)));
  thead.append(hr);
  table.append(thead);
  const tbody = el('tbody');
  res.rows.forEach((r) => {
    const tr = el('tr');
    fields.forEach((f) => {
      const v = r[f];
      tr.append(el('td', null, v === null || v === undefined ? 'NULL' : String(v)));
    });
    tbody.append(tr);
  });
  table.append(tbody);
  into.append(table);
  into.append(el('p', 'rows-note',
    `${res.rows.length} row${res.rows.length === 1 ? '' : 's'}`));
}

function renderStep(sql, res, err) {
  const box = el('div', 'step');
  box.append(el('pre', 'step-sql', sql));
  if (err) {
    box.append(el('div', 'err', err));
  } else if (res && res.rows) {
    if (res.rows.length) renderTable(box, res);
    else box.append(el('p', 'note', 'No rows.'));
  } else {
    box.append(el('p', 'note', 'Statement executed.'));
  }
  els.result.append(box);
}

// ---- running -------------------------------------------------------------

async function runOne(sql, kind) {
  const wantQuery = kind ? kind === 'query' : looksLikeQuery(sql);
  return wantQuery ? db.query(sql) : db.exec(sql);
}

async function refreshMarkers() {
  try {
    const res = await db.query(
      'SELECT MON$OLDEST_TRANSACTION AS OIT, MON$OLDEST_ACTIVE AS OAT,' +
      ' MON$OLDEST_SNAPSHOT AS OST, MON$NEXT_TRANSACTION AS NX,' +
      ' MON$PAGE_SIZE AS PS, MON$PAGE_BUFFERS AS PB FROM MON$DATABASE');
    const r = row(res);
    if (!r) return;
    els.markers.hidden = false;
    document.getElementById('mk-oit').textContent = r.OIT;
    document.getElementById('mk-oat').textContent = r.OAT;
    document.getElementById('mk-ost').textContent = r.OST;
    document.getElementById('mk-next').textContent = r.NX;
    document.getElementById('mk-page').textContent = r.PS;
    document.getElementById('mk-buf').textContent = r.PB;
  } catch (e) {
    // The markers are a courtesy readout; a failure here must not take the
    // workbench down with it.
  }
}

async function runWorkbench() {
  if (busy || !db) return;
  const sql = els.sql.value.trim();
  if (!sql) return;
  busy = true;
  els.run.disabled = true;
  setStatus('busy', 'Running…');
  els.result.replaceChildren();
  const started = performance.now();
  try {
    const res = await runOne(sql, null);
    renderStep(sql, res, null);
    els.timing.textContent = `${Math.round(performance.now() - started)} ms`;
  } catch (e) {
    renderStep(sql, null, String((e && e.message) || e));
    els.timing.textContent = `failed after ${Math.round(performance.now() - started)} ms`;
  }
  await refreshMarkers();
  setStatus('ready', 'Ready');
  els.run.disabled = false;
  busy = false;
}

async function runSequence(seq) {
  if (busy || !db) return;
  busy = true;
  els.run.disabled = true;
  setStatus('busy', `Running “${seq.title}”…`);
  els.result.replaceChildren();
  els.sql.value = seq.steps.map((s) => s.sql).join(';\n\n') + ';';
  const results = [];
  const started = performance.now();
  let failed = false;

  for (const step of seq.steps) {
    try {
      const res = await runOne(step.sql, step.kind);
      results.push(res);
      renderStep(step.sql, res, null);
    } catch (e) {
      results.push(null);
      renderStep(step.sql, null, String((e && e.message) || e));
      failed = true;
      break;
    }
  }

  els.timing.textContent = `${Math.round(performance.now() - started)} ms`;

  if (!failed) {
    const v = seq.verdict(results);
    if (v) {
      const box = el('div', v.ok ? 'verdict' : 'verdict miss');
      box.append(el('b', null, v.ok ? 'What that shows: ' : 'Not what was expected: '));
      box.append(document.createTextNode(v.text));
      els.result.append(box);
    }
  }

  await refreshMarkers();
  setStatus('ready', 'Ready');
  els.run.disabled = false;
  busy = false;
}

// ---- boot ----------------------------------------------------------------

function buildSequenceList() {
  SEQUENCES.forEach((seq) => {
    const li = el('li');
    const b = el('button', 'seq-btn');
    b.type = 'button';
    b.append(el('b', null, seq.title));
    b.append(el('span', null, seq.blurb));
    b.addEventListener('click', () => runSequence(seq));
    li.append(b);
    els.list.append(li);
  });
}

function buildCorrespondence() {
  CORRESPONDENCE.forEach(([claim, query]) => {
    const tr = el('tr');
    tr.append(el('td', null, claim));
    tr.append(el('td', null, query));
    els.mapBody.append(tr);
  });
}

function reportIsolation() {
  els.isolation.textContent = self.crossOriginIsolated
    ? 'This page is cross-origin isolated, so SharedArrayBuffer is available ' +
      'and the engine\'s threads can run. The service worker below is what ' +
      'made that true on a host that cannot send the headers itself.'
    : 'This page is not cross-origin isolated, so SharedArrayBuffer is not ' +
      'available. On the first visit the service worker installs and reloads ' +
      'the page; if this message persists, the page is probably being served ' +
      'over plain HTTP or from a file:// URL, where service workers do not run.';
}

function fail(message) {
  setStatus('error', 'Engine unavailable');
  els.result.replaceChildren();
  const box = el('div', 'err', message);
  els.result.append(box);
  const p = el('p', 'note');
  p.append(document.createTextNode('The sequences below still describe what to ask. You can run them on the '));
  const a = el('a', null, 'Electric Firebird demo');
  a.href = 'https://mariuz.github.io/electric-firebird/';
  p.append(a);
  p.append(document.createTextNode(' instead.'));
  els.result.append(p);
}

async function boot() {
  buildSequenceList();
  buildCorrespondence();
  reportIsolation();

  if (!self.crossOriginIsolated) {
    // First visit: the service worker has just installed and has not taken
    // control yet, so it will reload the page in a moment and the engine will
    // start on the way back. That is the normal path, not a failure, and
    // calling it "unavailable" would be alarming and wrong. Once a controller
    // exists and the page is still not isolated, something really is wrong.
    const firstVisit = 'serviceWorker' in navigator &&
      !navigator.serviceWorker.controller;
    if (firstVisit) {
      setStatus('busy', 'Preparing the engine…');
      els.result.replaceChildren();
      els.result.append(el('p', 'note',
        'First visit: the page is installing the service worker that supplies ' +
        'the cross-origin isolation headers GitHub Pages cannot send, and will ' +
        'reload itself once. The engine starts on the way back.'));
      return;
    }
    fail('This page is not cross-origin isolated, so SharedArrayBuffer is ' +
         'not available and the engine cannot start. That usually means the ' +
         'page is being served over plain HTTP or from a file:// URL, where ' +
         'service workers do not run.');
    return;
  }

  try {
    const mod = await import(ENGINE_BASE + 'firebird-browser.mjs');
    const worker = new Worker(new URL(ENGINE_BASE + 'firebird-engine-worker.js', location.origin));
    db = new mod.FirebirdBrowser(DB_NAME, { worker });
    const hello = await db.query(
      "SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS V FROM RDB$DATABASE");
    const v = row(hello);
    setStatus('ready', v ? `Firebird ${v.V} ready` : 'Ready');
    els.run.disabled = false;
    await refreshMarkers();
  } catch (e) {
    fail('Could not start the engine: ' + String((e && e.message) || e));
  }
}

els.run.addEventListener('click', runWorkbench);
els.sql.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runWorkbench(); }
});
els.reset.addEventListener('click', async () => {
  if (!db) return;
  try { await db.close(); } catch (e) { /* closing a dead handle is fine */ }
  indexedDB.deleteDatabase(DB_NAME);
  location.reload();
});
window.addEventListener('beforeunload', () => { if (db) { try { db.persist(); } catch (e) { } } });

boot();
