/* FBSimCity — machine room.
 *
 * Drives the real Firebird engine (Electric Firebird's WebAssembly build)
 * from this page, so the city's claims can be settled rather than believed.
 *
 * The engine is loaded from the Electric Firebird demo deployment at the same
 * origin on GitHub Pages. That deployment ships both the pthread build
 * (`firebird-embedded`, used when the page is cross-origin isolated and has
 * `SharedArrayBuffer`) and the single-threaded build (`firebird-embedded-st`),
 * which needs neither `SharedArrayBuffer` nor COOP/COEP headers. On GitHub
 * Pages the worker picks `firebird-embedded-st` automatically, so the engine
 * starts on the first visit without a service-worker reload.
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
// A second, independent database used as the replication target. It gets its
// own worker and its own IndexedDB store, so "replica" means a separate
// database, not a second table in the same file.
const REPLICA_DB_NAME = 'fbsimcity-machine-replica';

const els = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  sql: document.getElementById('sql'),
  run: document.getElementById('run'),
  explain: document.getElementById('explain'),
  sweep: document.getElementById('sweep'),
  introspect: document.getElementById('introspect'),
  replicate: document.getElementById('replicate'),
  promote: document.getElementById('promote'),
  rewind: document.getElementById('rewind'),
  reset: document.getElementById('reset'),
  timing: document.getElementById('timing'),
  result: document.getElementById('result'),
  list: document.getElementById('sequence-list'),
  markers: document.getElementById('markers'),
  mapBody: document.getElementById('map-body'),
  isolation: document.getElementById('isolation-note'),
};

let db = null;
let engineMod = null;
let replicaDb = null;
let replicator = null;
let busy = false;
const telemetryChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('fbsimcity-telemetry')
  : null;

function broadcastTelemetry(payload) {
  try {
    if (telemetryChannel) telemetryChannel.postMessage(payload);
  } catch (e) { /* ignore cross-tab broadcast errors */ }
}

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
          `simplification: they are columns in a monitoring table (and in ` +
          `IAttachment::getInfo, which feeds the bar above). The gap ` +
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
    id: 'plan',
    title: 'An index walk or a sort, in the optimizer\'s own words',
    blurb: 'B-Tree Gardens versus the Sort Yard, via db.explain().',
    steps: [
      { sql: 'RECREATE TABLE PLAN_DEMO (ID INTEGER PRIMARY KEY, NAME VARCHAR(40))', kind: 'exec' },
      { sql: 'SELECT NAME FROM PLAN_DEMO WHERE ID = 1', kind: 'explain' },
      { sql: 'SELECT NAME FROM PLAN_DEMO ORDER BY NAME', kind: 'explain' },
    ],
    verdict(res) {
      const p1 = res[1] && res[1].plan ? res[1].plan : '';
      const p2 = res[2] && res[2].plan ? res[2].plan : '';
      if (!p1 || !p2) return null;
      const indexed = /INDEX/i.test(p1);
      const sorted = /SORT/i.test(p2);
      return {
        ok: indexed && sorted,
        text: indexed && sorted
          ? `Filtering on the primary key planned “${p1}” — a trip through ` +
            `the B-Tree Gardens. Ordering by an unindexed column planned ` +
            `“${p2}” — a full table scan sent to the Sort Yard. Neither ` +
            `SELECT was executed: db.explain() calls IStatement::getPlan, ` +
            `which is the execution tree the Compiler & Optimizer builds ` +
            `before Execution Hall ever touches a row.`
          : `The optimizer returned “${p1}” and “${p2}” — expected an INDEX ` +
            `plan for the primary-key filter and a SORT plan for the ` +
            `unindexed ORDER BY.`,
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
   'db.databaseInfo() or SELECT MON$OLDEST_TRANSACTION, MON$OLDEST_ACTIVE, MON$NEXT_TRANSACTION FROM MON$DATABASE'],
  ['Compiler & Optimizer chooses index retrieval or sort',
   'db.explain(sql, { detailed: true }) — IStatement::getPlan (INDEX vs SORT)'],
  ['Version towers grow a floor per UPDATE',
   'MON$RECORD_STATS: MON$RECORD_UPDATES, MON$BACKVERSION_READS'],
  ['Garbage collection removes unreachable versions',
   'MON$RECORD_STATS: MON$RECORD_PURGES, MON$RECORD_EXPUNGES'],
  ['The cache plaza hits and misses',
   'MON$IO_STATS: MON$PAGE_FETCHES against MON$PAGE_READS'],
  ['Dirty pages cost a write when evicted',
   'MON$IO_STATS: MON$PAGE_MARKS, MON$PAGE_WRITES'],
  ['Metadata is a district, not a special case',
   'db.introspect() or SELECT RDB$RELATION_NAME FROM RDB$RELATIONS'],
  ['Sweep interval on the control room dial & manual Sweep',
   'db.sweep() (isc_dpb_sweep) or SELECT MON$SWEEP_INTERVAL FROM MON$DATABASE'],
  ['Sort memory (TempCacheLimit) and cooperative GC policy',
   "SELECT RDB$CONFIG_NAME, RDB$CONFIG_VALUE FROM RDB$CONFIG WHERE RDB$CONFIG_NAME IN ('TempCacheLimit', 'GCPolicy')"],
  ['Journal Yard: committed changes journalled in order, replica lag',
   'Replicate — replicateDatabases() + FB_REPL_JOURNAL$ LSNs, replicator.stats().lagEntries (firebird-wasm logical replication)'],
  ['Replication slots hold back journal pruning',
   'publication.listSlots() / pruneAcked() against FB_REPL_SLOTS$ confirmedFlushLsn'],
  ['Failover: the replica becomes the primary',
   'Promote — promoteReplica() resets FB_REPL_ROLE to PRIMARY after draining lag'],
  ['Undoing history from the journal',
   'Rewind — rewindToLsn() replays BEFORE_JSON images in reverse LSN order'],
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

function setButtonsDisabled(disabled) {
  els.run.disabled = disabled;
  if (els.explain) els.explain.disabled = disabled;
  if (els.sweep) els.sweep.disabled = disabled;
  if (els.introspect) els.introspect.disabled = disabled;
  if (els.replicate) els.replicate.disabled = disabled;
  // promote / rewind only make sense once a replication pair exists
  if (els.promote) els.promote.disabled = disabled || !replicator;
  if (els.rewind) els.rewind.disabled = disabled || !replicator;
}

function looksLikeQuery(sql) {
  const text = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '').trim();
  if (/^(select|with)\b/i.test(text)) return true;
  if (/^execute\s+block\b/i.test(text) && /\breturns\b/i.test(text)) return true;
  return false;
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
  } else if (res && typeof res.plan === 'string') {
    if (res.plan) {
      box.append(el('pre', 'plan', res.plan));
      if (res.detailed) {
        box.append(el('pre', 'plan plan-detailed', res.detailed));
      }
    } else {
      box.append(el('p', 'note', 'Statement carries no execution plan (DDL).'));
    }
  } else if (res && res.rows) {
    if (res.rows.length) renderTable(box, res);
    else box.append(el('p', 'note', 'No rows.'));
  } else {
    box.append(el('p', 'note', 'Statement executed.'));
  }
  els.result.append(box);
}

// ---- running -------------------------------------------------------------

async function explainOne(sql) {
  if (typeof db.explain !== 'function') {
    throw new Error('This engine build does not expose db.explain().');
  }
  const [plan, detailed] = await Promise.all([
    db.explain(sql),
    db.explain(sql, { detailed: true }),
  ]);
  broadcastTelemetry({ sql, planText: detailed || plan || '' });
  return { plan, detailed };
}

async function runOne(sql, kind) {
  if (kind === 'explain') return explainOne(sql);
  const wantQuery = kind ? kind === 'query' : looksLikeQuery(sql);
  let planText = '';
  try {
    if (typeof db.explain === 'function') {
      planText = (await db.explain(sql, { detailed: true })) || '';
    }
  } catch (e) { /* DDL statements carry no execution plan */ }
  const res = await (wantQuery ? db.query(sql) : db.exec(sql));
  broadcastTelemetry({ sql, planText });
  return res;
}

async function refreshMarkers() {
  try {
    if (typeof db.databaseInfo === 'function') {
      const info = await db.databaseInfo();
      if (!info) return;
      els.markers.hidden = false;
      document.getElementById('mk-oit').textContent = info.oldestTransaction;
      document.getElementById('mk-oat').textContent = info.oldestActive;
      document.getElementById('mk-ost').textContent = info.oldestSnapshot;
      document.getElementById('mk-next').textContent = info.nextTransaction;
      document.getElementById('mk-page').textContent = info.pageSize;
      document.getElementById('mk-buf').textContent = info.pageBuffers;
      broadcastTelemetry({ info });
      return;
    }
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
  setButtonsDisabled(true);
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
  setButtonsDisabled(false);
  busy = false;
}

async function runExplain() {
  if (busy || !db) return;
  const sql = els.sql.value.trim();
  if (!sql) return;
  busy = true;
  setButtonsDisabled(true);
  setStatus('busy', 'Explaining…');
  els.result.replaceChildren();
  const started = performance.now();
  try {
    const res = await explainOne(sql);
    renderStep(sql, res, null);
    els.timing.textContent = `${Math.round(performance.now() - started)} ms`;
  } catch (e) {
    renderStep(sql, null, String((e && e.message) || e));
    els.timing.textContent = `failed after ${Math.round(performance.now() - started)} ms`;
  }
  await refreshMarkers();
  setStatus('ready', 'Ready');
  setButtonsDisabled(false);
  busy = false;
}

async function runSequence(seq) {
  if (busy || !db) return;
  busy = true;
  setButtonsDisabled(true);
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
  setButtonsDisabled(false);
  busy = false;
}

async function runSweep() {
  if (busy || !db) return;
  busy = true;
  setButtonsDisabled(true);
  setStatus('busy', 'Sweeping…');
  els.result.replaceChildren();
  const started = performance.now();
  try {
    if (typeof db.sweep !== 'function') {
      throw new Error('This engine build does not expose db.sweep().');
    }
    await db.sweep();
    broadcastTelemetry({ sweep: true });
    renderStep('-- db.sweep() (isc_dpb_sweep)', { rows: [] }, null);
    els.timing.textContent = `${Math.round(performance.now() - started)} ms`;
  } catch (e) {
    renderStep('-- db.sweep()', null, String((e && e.message) || e));
    els.timing.textContent = `failed after ${Math.round(performance.now() - started)} ms`;
  }
  await refreshMarkers();
  setStatus('ready', 'Ready');
  setButtonsDisabled(false);
  busy = false;
}

async function runIntrospect() {
  if (busy || !db) return;
  busy = true;
  setButtonsDisabled(true);
  setStatus('busy', 'Introspecting catalog…');
  els.result.replaceChildren();
  const started = performance.now();
  try {
    if (typeof db.introspect !== 'function') {
      throw new Error('This engine build does not expose db.introspect().');
    }
    const schema = await db.introspect();
    broadcastTelemetry({ schema });
    const rows = (schema && Array.isArray(schema.tables))
      ? schema.tables.map((tb) => ({
          TABLE_NAME: tb.name,
          COLUMNS: Array.isArray(tb.columns) ? tb.columns.length : 0,
          INDEXES: Array.isArray(tb.indexes) ? tb.indexes.length : 0,
          PRIMARY_KEY: Array.isArray(tb.primaryKey) ? tb.primaryKey.join(', ') : '',
        }))
      : [];
    renderStep('-- db.introspect() (RDB$RELATIONS / RDB$RELATION_FIELDS / RDB$INDICES)', { rows }, null);
    els.timing.textContent = `${Math.round(performance.now() - started)} ms`;
  } catch (e) {
    renderStep('-- db.introspect()', null, String((e && e.message) || e));
    els.timing.textContent = `failed after ${Math.round(performance.now() - started)} ms`;
  }
  await refreshMarkers();
  setStatus('ready', 'Ready');
  setButtonsDisabled(false);
  busy = false;
}

// ---- replication (firebird-wasm 0.20 logical replication) ------------------
//
// What this is, stated plainly: firebird-wasm's replication is a library-level
// logical replication layer. Changes are captured into an ordinary table,
// FB_REPL_JOURNAL$, each stamped with an LSN (here by captureTableChanges(),
// which diffs the table against a mirror; PSQL triggers are the other capture
// path); a subscriber pulls entries past its watermark (FB_REPL_WATERMARKS$)
// and applies them to a second database. It is NOT the engine's own Firebird
// 4+ replication (replication.conf, src/jrd/replication/Publisher.cpp), which
// ships journal segments below SQL. Both are real; they are different
// mechanisms, and the city's Journal Yard draws the engine one.

const REPL_TABLE = 'REPL_DEMO';
const REPL_TABLES = [{ table: REPL_TABLE, primaryKey: 'ID', columns: ['ID', 'NAME'] }];
let replPromoted = false;
let replCheckpointLsn = null;

function replicationApi(name) {
  if (!engineMod || typeof engineMod[name] !== 'function') {
    throw new Error(`This engine build does not expose ${name}() — ` +
      'it needs firebird-wasm 0.20 or newer.');
  }
  return engineMod[name];
}

/* Workaround for firebird-wasm 0.20.1: its replication tables use a column
 * named PUBLICATION, which has been a reserved word since Firebird 4.0
 * (ALTER DATABASE ENABLE PUBLICATION), so the real engine rejects the DDL
 * with "Token unknown - PUBLICATION". The library's own simulator runs on
 * in-memory nodes and never reaches the engine, which is how it shipped.
 *
 * The fix here is the smallest one that is still correct SQL: quote the
 * identifier in statements that touch the FB_REPL_* tables. "PUBLICATION"
 * names the same column as an unquoted PUBLICATION would have, so rows still
 * come back keyed PUBLICATION and the library reads them unchanged. Remove
 * this once upstream quotes or renames the column. */
const RESERVED_REPL_COLUMNS = /(^|[^"\w$])(PUBLICATION)(?![\w$"])/g;

function quoteReservedReplColumns(sql) {
  if (typeof sql !== 'string' || !/FB_REPL_/i.test(sql)) return sql;
  return sql.replace(RESERVED_REPL_COLUMNS, '$1"$2"');
}

/* Second workaround, same release: FirebirdBrowser.exec() splits its input on
 * ';' the way isql does, but the library passes PSQL trigger bodies to it
 * without a SET TERM, so the CREATE TRIGGER is cut off at its first DECLARE.
 * Wrapping PSQL DDL in SET TERM is exactly what a person would type in isql. */
const PSQL_DDL = /^\s*(CREATE(\s+OR\s+ALTER)?|RECREATE|ALTER)\s+(TRIGGER|PROCEDURE|FUNCTION|PACKAGE)\b|^\s*EXECUTE\s+BLOCK\b/i;

function wrapPsqlTerm(sql, params) {
  if (typeof sql !== 'string' || !PSQL_DDL.test(sql) || !sql.includes(';')) return sql;
  if (params && params.length) return sql;
  if (/^\s*SET\s+TERM\b/i.test(sql)) return sql;
  return `SET TERM ^ ;\n${sql.replace(/;\s*$/, '')}^\nSET TERM ; ^`;
}

function firebirdSafe(handle) {
  const wrapExec = (target, isTx) => new Proxy(target, {
    get(t, prop) {
      const v = t[prop];
      if (typeof v !== 'function') return v;
      if (prop === 'exec' && !isTx) {
        // only the top-level exec splits scripts; a transaction's exec does not
        return (sql, ...rest) =>
          v.call(t, wrapPsqlTerm(quoteReservedReplColumns(sql), rest[0]), ...rest);
      }
      if (prop === 'query' || prop === 'exec' || prop === 'execute') {
        return (sql, ...rest) => v.call(t, quoteReservedReplColumns(sql), ...rest);
      }
      if (prop === 'transaction') {
        return (fn, ...rest) => v.call(t, (tx) => fn(wrapExec(tx, true)), ...rest);
      }
      return v.bind(t);
    },
  });
  return wrapExec(handle, false);
}

async function ensureReplicaDb() {
  if (replicaDb) return replicaDb;
  const worker = new Worker(new URL(ENGINE_BASE + 'firebird-engine-worker.js', location.origin));
  replicaDb = new engineMod.FirebirdBrowser(REPLICA_DB_NAME, { worker });
  await replicaDb.query('SELECT 1 AS ONE FROM RDB$DATABASE');
  return replicaDb;
}

async function tableExists(handle, name) {
  // name is a constant identifier from this file, never user input
  const res = await handle.query(
    `SELECT COUNT(*) AS N FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = '${name}'`);
  return num(res, 'N') > 0;
}

async function rowsOf(handle) {
  const res = await handle.query(`SELECT ID, NAME FROM ${REPL_TABLE} ORDER BY ID`);
  return (res && res.rows) || [];
}

function sameRows(a, b) {
  return JSON.stringify(a.map((r) => [Number(r.ID), String(r.NAME)])) ===
         JSON.stringify(b.map((r) => [Number(r.ID), String(r.NAME)]));
}

function entryRows(entries) {
  return (entries || []).map((e) => ({
    LSN: e.lsn,
    OPERATION: e.operation,
    TABLE: e.table,
    KEY: JSON.stringify(e.key || {}),
    ORIGIN: e.origin,
  }));
}

async function withBusy(label, fn) {
  if (busy || !db) return;
  busy = true;
  setButtonsDisabled(true);
  setStatus('busy', label);
  els.result.replaceChildren();
  const started = performance.now();
  try {
    await fn();
    els.timing.textContent = `${Math.round(performance.now() - started)} ms`;
  } catch (e) {
    renderStep('-- ' + label, null, String((e && e.message) || e));
    els.timing.textContent = `failed after ${Math.round(performance.now() - started)} ms`;
  }
  await refreshMarkers();
  setStatus('ready', 'Ready');
  busy = false;
  setButtonsDisabled(false);
  if (els.replicate && replPromoted) els.replicate.disabled = true;
}

function verdictBox(ok, text) {
  const box = el('div', ok ? 'verdict' : 'verdict miss');
  box.append(el('b', null, ok ? 'What that shows: ' : 'Not what was expected: '));
  box.append(document.createTextNode(text));
  els.result.append(box);
}

async function runReplicate() {
  await withBusy('Replicating…', async () => {
    if (replPromoted) {
      throw new Error('The replica was promoted to primary. Delete the database to start a fresh pair.');
    }
    const replicateDatabases = replicationApi('replicateDatabases');
    const replica = await ensureReplicaDb();

    // 1. the same table on two separate databases
    const ddl = `CREATE TABLE ${REPL_TABLE} (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(40))`;
    for (const [label, handle] of [['primary', db], ['replica', replica]]) {
      if (!(await tableExists(handle, REPL_TABLE))) {
        await handle.exec(ddl);
        renderStep(`-- on the ${label}\n${ddl}`, null, null);
      }
    }

    // 2. pair them: publication on the primary, subscription on the replica.
    // On firebird-wasm >= 0.20.2, PSQL capture triggers (FB_REPL_TRG_REPL_DEMO$)
    // and captureTableChanges() share FB_REPL_LSN_GEN$ and deduplicate keys;
    // on 0.20.1, captureTableChanges() assigns MAX(LSN)+1 without advancing
    // FB_REPL_LSN_GEN$, so we enable triggers automatically from 0.20.2 onward.
    const engVer = String((engineMod && engineMod.VERSION) || '');
    const useTriggers = engVer >= '0.20.2';
    if (!replicator) {
      replicator = await replicateDatabases({
        primary: firebirdSafe(db),
        replica: firebirdSafe(replica),
        tables: REPL_TABLES,
        direction: 'one-way',
        installTriggers: useTriggers,
        primaryNodeId: 'machine-primary',
        replicaNodeId: 'machine-replica',
      });
      renderStep(`-- replicateDatabases({ direction: 'one-way', installTriggers: ${useTriggers} })\n` +
        '-- creates FB_REPL_JOURNAL$, FB_REPL_MIRROR$, FB_REPL_WATERMARKS$, FB_REPL_SLOTS$' +
        (useTriggers ? ', FB_REPL_TRG_REPL_DEMO$' : ''),
        null, null);
    }
    const pub = replicator.primaryPublication;

    // 3. write on the primary only
    replCheckpointLsn = await pub.currentLsn();
    const base = num(await db.query(`SELECT COALESCE(MAX(ID), 0) AS M FROM ${REPL_TABLE}`), 'M') || 0;
    const writes = [
      `INSERT INTO ${REPL_TABLE} (ID, NAME) VALUES (${base + 1}, 'alpha')`,
      `INSERT INTO ${REPL_TABLE} (ID, NAME) VALUES (${base + 2}, 'beta')`,
      `INSERT INTO ${REPL_TABLE} (ID, NAME) VALUES (${base + 3}, 'gamma')`,
      `UPDATE ${REPL_TABLE} SET NAME = 'beta-2' WHERE ID = ${base + 2}`,
    ];
    for (const sql of writes) await db.exec(sql);
    renderStep('-- on the primary\n' + writes.join(';\n') + ';', null, null);

    // 4. capture into the journal (via trigger on >= 0.20.2, or mirror diff on 0.20.1)
    if (!useTriggers) await pub.captureTableChanges();
    const entries = await pub.fetchChangesSince(replCheckpointLsn);
    renderStep(`-- primaryPublication.${useTriggers ? '' : 'captureTableChanges(); '}fetchChangesSince(${replCheckpointLsn})  (FB_REPL_JOURNAL$)`,
      { rows: entryRows(entries) }, null);
    const before = await replicator.stats();

    // 5. one replication cycle, then compare both databases
    const cycle = await replicator.sync();
    const after = await replicator.stats();
    const p2r = cycle && cycle.primaryToReplica ? cycle.primaryToReplica : {};
    renderStep('-- replicator.sync() + replicator.stats()', {
      rows: [
        { WHEN: 'before sync', PRIMARY_LSN: before.primaryLsn, REPLICA_WATERMARK: before.replicaWatermark, LAG_ENTRIES: before.lagEntries },
        { WHEN: 'after sync', PRIMARY_LSN: after.primaryLsn, REPLICA_WATERMARK: after.replicaWatermark, LAG_ENTRIES: after.lagEntries },
      ],
    }, null);

    const primaryRows = await rowsOf(db);
    const replicaRows = await rowsOf(replica);
    renderStep(`-- on the replica\nSELECT ID, NAME FROM ${REPL_TABLE} ORDER BY ID`, { rows: replicaRows }, null);

    // 6. slots hold back pruning. Report what pruneAcked() could reclaim
    // rather than calling it: pruning deletes exactly the history Rewind needs.
    let slots = [];
    let safeLsn = null;
    let retainedFrom = null;
    try {
      slots = await pub.listSlots();
      retainedFrom = await pub.minRetainedLsn();
      safeLsn = slots.length
        ? Math.min(...slots.map((sl) => Number(sl.confirmedFlushLsn) || 0))
        : null;
      renderStep('-- primaryPublication.listSlots() + minRetainedLsn()  (FB_REPL_SLOTS$)', {
        rows: slots.map((sl) => ({
          SLOT: sl.slotName, NODE: sl.nodeId, CONFIRMED_FLUSH_LSN: sl.confirmedFlushLsn,
          JOURNAL_RETAINED_FROM: retainedFrom, PRUNE_ACKED_WOULD_REACH: safeLsn,
        })),
      }, null);
    } catch (e) { /* slots are a courtesy readout */ }

    const ok = sameRows(primaryRows, replicaRows) && after.lagEntries === 0;
    broadcastTelemetry({
      replication: {
        event: 'sync',
        entries: entries.length,
        primaryLsn: after.primaryLsn,
        replicaWatermark: after.replicaWatermark,
        lagBefore: before.lagEntries,
        lagAfter: after.lagEntries,
        applied: p2r.appliedCount || 0,
        slots: slots.length,
      },
    });
    verdictBox(ok, ok
      ? `${writes.length} statements became ${entries.length} LSN-stamped journal ` +
        `entr${entries.length === 1 ? 'y' : 'ies'} in FB_REPL_JOURNAL$` +
        (useTriggers
          ? `, captured live by the PSQL trigger FB_REPL_TRG_REPL_DEMO$ (3 INSERTs and 1 UPDATE with its BEFORE and AFTER JSON images).`
          : `: captureTableChanges() diffs the table against its last mirror, so it sees net state — an INSERT followed by an UPDATE of the same row is journalled once, as an INSERT of the final row.`) +
        ` Before the pull the replica was ${before.lagEntries} behind; one sync() applied ` +
        `${p2r.appliedCount || 0} in LSN order and it now matches the primary row ` +
        `for row (${replicaRows.length} rows, watermark ${after.replicaWatermark}). ` +
        `Its slot confirms LSN ${safeLsn ?? '—'}, as far as pruneAcked() may delete.`
      : `Primary has ${primaryRows.length} rows, replica has ${replicaRows.length}, ` +
        `and ${after.lagEntries} entries are still unapplied.`);
  });
}

async function runPromote() {
  await withBusy('Promoting the replica…', async () => {
    if (!replicator) throw new Error('Run Replicate first, so there is a replica to promote.');
    const promoteReplica = replicationApi('promoteReplica');
    const res = await promoteReplica({
      replicaDb: firebirdSafe(replicaDb),
      subscription: replicator.replicaSubscription,
      previousPrimaryDb: firebirdSafe(db),
      maxAllowedLagEntries: 0,
      promotedNodeId: 'machine-replica-promoted',
      tables: REPL_TABLES,
      installTriggers: true,
      sequenceBuffer: 100,
    });
    renderStep('-- promoteReplica({ maxAllowedLagEntries: 0, installTriggers: true, sequenceBuffer: 100 })', {
      rows: [{
        PROMOTED_NODE: res.promotedNodeId,
        FINAL_WATERMARK: res.finalReplicaWatermark,
        STARTING_LSN: res.promotedStartingLsn,
        TABLES: (res.publishedTables || []).join(', '),
        TRIGGERS: res.triggersInstalled,
        ROLE_RESET: res.roleContextCleared,
      }],
    }, null);
    replicator = null;
    replPromoted = true;
    broadcastTelemetry({
      replication: { event: 'promote', finalWatermark: res.finalReplicaWatermark, promotedNodeId: res.promotedNodeId },
    });
    const promotedOk = (res.publishedTables || []).length > 0 && res.roleContextCleared !== false;
    verdictBox(promotedOk, promotedOk
      ? `The replica drained to watermark ${res.finalReplicaWatermark} (promotion is refused ` +
      `while any entry is unapplied), had FB_REPL_ROLE set back to PRIMARY, and now ` +
      `publishes ${(res.publishedTables || []).join(', ')} itself from LSN ` +
      `${res.promotedStartingLsn}. That is failover: the old primary stops being the ` +
      `source of truth. Native Firebird has no single call for this — the operator ` +
      `reconfigures replication.conf and switches the replica to read-write.`
      : `promoteReplica() returned without publishing any table or resetting the role ` +
        `context, so the replica is not acting as a primary.`);
  });
}

async function runRewind() {
  await withBusy('Rewinding the primary…', async () => {
    if (!replicator || replCheckpointLsn === null) {
      throw new Error('Run Replicate first, so there is journal history to rewind.');
    }
    const rewindToLsn = replicationApi('rewindToLsn');
    const res = await rewindToLsn(firebirdSafe(db), { target: replCheckpointLsn });
    const primaryRows = await rowsOf(db);
    const replicaRows = await rowsOf(replicaDb);
    renderStep(`-- rewindToLsn(primary, { target: ${replCheckpointLsn} })`, {
      rows: [{
        PREVIOUS_HEAD: res.previousHeadLsn, REWOUND_TO: res.rewoundToLsn,
        UNDONE: res.entriesUndone, JOURNAL_REMOVED: res.journalEntriesRemoved,
        PRIMARY_ROWS: primaryRows.length, REPLICA_ROWS: replicaRows.length,
      }],
    }, null);
    broadcastTelemetry({ replication: { event: 'rewind', entriesUndone: res.entriesUndone } });
    const rewound = res.entriesUndone > 0;
    verdictBox(rewound, rewound
      ? `${res.entriesUndone} operations were undone on the primary, newest first — ` +
      `an INSERT is inverted by a DELETE, an UPDATE by writing back its BEFORE ` +
      `image — and the journal was cut back to LSN ` +
      `${res.rewoundToLsn}. The replica still holds ${replicaRows.length} rows against ` +
      `the primary's ${primaryRows.length}: a rewind is local to one node and is not ` +
      `itself replicated. Rewinding history and replicating it are separate decisions.`
      : `Nothing was undone — there was no journal history after LSN ${replCheckpointLsn} ` +
        `(it may already have been rewound). Run Replicate again to write some.`);
  });
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
    ? 'Cross-origin isolated, so this runs the threaded build of the engine.'
    : 'Not cross-origin isolated (GitHub Pages sends no COOP/COEP), so this runs ' +
      'the build without threads, which needs no SharedArrayBuffer.';
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

  try {
    const mod = await import(ENGINE_BASE + 'firebird-browser.mjs');
    engineMod = mod;
    const worker = new Worker(new URL(ENGINE_BASE + 'firebird-engine-worker.js', location.origin));
    db = new mod.FirebirdBrowser(DB_NAME, { worker });
    const hello = await db.query(
      "SELECT TRIM(RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION')) AS V FROM RDB$DATABASE");
    const v = row(hello);
    const lib = mod.VERSION ? ` · firebird-wasm ${mod.VERSION}` : '';
    setStatus('ready', v ? `Firebird ${v.V} ready${lib}` : 'Ready');
    setButtonsDisabled(false);
    await refreshMarkers();
  } catch (e) {
    fail('Could not start the engine: ' + String((e && e.message) || e));
  }
}

els.run.addEventListener('click', runWorkbench);
if (els.explain) els.explain.addEventListener('click', runExplain);
if (els.sweep) els.sweep.addEventListener('click', runSweep);
if (els.introspect) els.introspect.addEventListener('click', runIntrospect);
if (els.replicate) els.replicate.addEventListener('click', runReplicate);
if (els.promote) els.promote.addEventListener('click', runPromote);
if (els.rewind) els.rewind.addEventListener('click', runRewind);
els.sql.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runWorkbench(); }
});
els.reset.addEventListener('click', async () => {
  els.reset.disabled = true;
  setButtonsDisabled(true);
  setStatus('booting', 'Deleting the database…');
  try {
    if (replicator) { try { await replicator.stop(); } catch (e) { /* not started */ } }
    if (replicaDb) await replicaDb.close();
    replicaDb = null;
    if (db) await db.close();
    db = null;
    const dropStore = (store) => new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(store);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => setTimeout(resolve, 3000);
    });
    await dropStore(`firebird_${DB_NAME}`);
    await dropStore(`firebird_${REPLICA_DB_NAME}`);
  } catch (e) {
    /* closing or deleting a dead handle is fine */
  } finally {
    location.reload();
  }
});

boot();
