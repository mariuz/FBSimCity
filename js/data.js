/* FBSimCity — world data.
 * Building blocks follow the subsystem decomposition in
 * "Conceptual Architecture for Firebird" (Chan & Yashkir, Univ. of Waterloo;
 * extended by Popa Adrian Marius): REMOTE -> DSQL -> JRD (+LOCK),
 * a pipe-and-filter at the top level.
 */
var FB = (function () {
  "use strict";

  var buildings = [
    {
      id: "harbor", code: "REMOTE", name: "Client Harbor",
      x: 0, y: 16, w: 4, d: 8, h: 1.6, color: "#2a6f97",
      short: "Clients arrive over TCP/IP and XNET.",
      desc: "The remote connection system lets local and network clients talk " +
        "to the server over several protocols (TCP/IP sockets, XNET shared " +
        "memory on the same machine). Every request enters the city here and " +
        "every result ship leaves from here — the two ends of the " +
        "pipe-and-filter pipeline."
    },
    {
      id: "yvalve", code: "Y-VALVE", name: "Y-Valve Gate",
      x: 7, y: 18, w: 2, d: 4, h: 3, color: "#3d8bfd",
      short: "Dispatches each attachment to the right provider.",
      desc: "The Y-valve is the dispatcher of the client library: it looks at " +
        "the connection string and routes the attachment to the right " +
        "provider — the embedded engine, the remote redirector, or a " +
        "compatibility provider. In the city, every query drives through " +
        "this gate in both directions."
    },
    {
      id: "lexer", code: "DSQL", name: "Lexer",
      x: 12, y: 14, w: 3, d: 3, h: 3.6, color: "#7b6cf6",
      short: "Splits SQL text into tokens.",
      desc: "First stage of the SQL translator (DSQL). The lexical analyzer " +
        "chops the raw SQL string into tokens — keywords, identifiers, " +
        "literals, operators — for the parser next door."
    },
    {
      id: "parser", code: "DSQL", name: "Parser",
      x: 16, y: 14, w: 3, d: 3, h: 4.6, color: "#8b5cf6",
      short: "Builds the syntax tree.",
      desc: "The parser (a yacc/bison grammar in the real engine) turns the " +
        "token stream into a syntax tree, checking that the statement is " +
        "well-formed SQL along the way."
    },
    {
      id: "blrgen", code: "DSQL", name: "BLR Generator",
      x: 20, y: 14, w: 3, d: 3, h: 4, color: "#a855f7",
      short: "Emits BLR — the engine's native language.",
      desc: "DSQL's code generator converts the syntax tree into BLR (Binary " +
        "Language Representation), the compact binary language the " +
        "relational engine actually understands. Watch the query particles " +
        "change color here: SQL in, BLR out. Stored procedures and triggers " +
        "are kept in BLR form too."
    },
    {
      id: "security", code: "SCL", name: "Security Gatehouse",
      x: 24, y: 18, w: 2, d: 3, h: 2.6, color: "#f59f00",
      short: "Authentication and access control.",
      desc: "The security subsystem authenticates attachments against the " +
        "security database and enforces SQL privileges and ACLs on every " +
        "object a request touches. No query gets deeper into JRD downtown " +
        "without passing the gatehouse."
    },
    {
      id: "met", code: "MET", name: "Metadata Library",
      x: 28, y: 7, w: 4, d: 4, h: 4.6, color: "#20c997",
      short: "System tables: RDB$RELATIONS and friends.",
      desc: "The metadata subsystem reads and caches the system tables " +
        "(RDB$RELATIONS, RDB$FIELDS, RDB$INDICES...). The compiler consults " +
        "this library to resolve table and column names, formats, triggers " +
        "and constraints. Metadata lives in the database file itself — the " +
        "catalog is just more tables."
    },
    {
      id: "cmp", code: "CMP", name: "Compiler & Optimizer",
      x: 28, y: 14, w: 4, d: 4, h: 5.6, color: "#12b886",
      short: "BLR becomes an optimized execution tree.",
      desc: "The compiler (CMP) turns BLR into an executable request tree, " +
        "and the optimizer decides how to run it: which indexes to use, the " +
        "join order, whether a sort is needed. It weighs index selectivity " +
        "and stream cardinalities — a compact cost-based planner."
    },
    {
      id: "exec", code: "EXE", name: "Execution Hall",
      x: 34, y: 13, w: 5, d: 5, h: 3.6, color: "#40c057",
      short: "Interprets the request tree; the heart of JRD.",
      desc: "The execution subsystem walks the compiled request tree node by " +
        "node, pulling rows through record streams. It coordinates everyone " +
        "else: metadata, B-tree indexes, the sorter, the lock manager and " +
        "record-level I/O. Every query spends its working life in this hall."
    },
    {
      id: "btr", code: "BTR", name: "B-Tree Gardens",
      x: 41, y: 7, w: 5, d: 4, h: 2.8, color: "#63e6be",
      short: "Indexes with prefix-compressed keys.",
      desc: "The B-tree subsystem maintains index pages with prefix-compressed " +
        "keys. The optimizer sends retrievals here to avoid full scans; " +
        "index walks resolve to record numbers that VIO then fetches. " +
        "Since Firebird 5, index creation can use parallel workers."
    },
    {
      id: "sort", code: "SORT", name: "Sort Yard",
      x: 41, y: 20, w: 5, d: 4, h: 1.8, color: "#94d82d",
      short: "External merge sort for ORDER BY / GROUP BY.",
      desc: "When no index provides the needed order, the sorter builds sorted " +
        "runs in memory and merges them — spilling to temporary files when " +
        "the data outgrows RAM. DISTINCT, ORDER BY and GROUP BY all send " +
        "freight through this yard."
    },
    {
      id: "tra", code: "TRA", name: "Transaction Hall",
      x: 34, y: 5, w: 5, d: 4, h: 4.6, color: "#fcc419",
      short: "TIP pages; Next / OAT / OIT counters.",
      desc: "The transaction subsystem hands out transaction IDs and records " +
        "every transaction's state on Transaction Inventory Pages (TIP). " +
        "Three famous counters live on this hall's facade: Next (the next " +
        "ID), OAT (Oldest Active Transaction) and OIT (Oldest Interesting " +
        "Transaction). Garbage collection can only clean record versions " +
        "older than the OIT — keep a transaction open for hours and the " +
        "whole city hoards garbage. Firebird 4 replaced state-bitmap " +
        "snapshots with commit-order snapshots for read consistency."
    },
    {
      id: "lock", code: "LOCK", name: "Lock Manager Tower",
      x: 30, y: 1, w: 3, d: 3, h: 7.5, color: "#ff6b6b",
      short: "Shared-memory lock table; the concurrency traffic control.",
      desc: "The lock manager coordinates concurrent access when multiple " +
        "attachments (or, in Classic mode, multiple processes) use the same " +
        "database file. A shared-memory lock table holds locks on pages, " +
        "relations and other resources; when a modification is needed a " +
        "lock is requested, the change is made, the lock is released. " +
        "Blocked requests queue at the tower — and occasionally a deadlock " +
        "scan sends one of them home to retry."
    },
    {
      id: "mvcc", code: "VIO", name: "Record Version Towers",
      x: 48, y: 11, w: 8, d: 10, h: 0, color: "#4dabf7",
      short: "Multi-generational records: every update stacks a version.",
      desc: "Firebird pioneered multi-generational concurrency (MVCC): an " +
        "UPDATE does not overwrite a row — it creates a new version and " +
        "chains the old one behind it (as a backward delta). Readers walk " +
        "the chain to the version visible to their snapshot, so readers " +
        "never block writers. These towers grow one floor per stale " +
        "version. If the OIT is stuck, nobody may demolish the old floors — " +
        "watch the district turn red under a long-running transaction."
    },
    {
      id: "gc", code: "GC", name: "Sweep & GC Depot",
      x: 48, y: 24, w: 3, d: 3, h: 1.8, color: "#868e96",
      short: "Cooperative GC + background sweep.",
      desc: "Garbage collection demolishes record versions no active " +
        "transaction can see (older than the OIT). It happens two ways: " +
        "cooperatively, when a reader passing a chain tidies it up, and via " +
        "sweep — the depot's truck touring every table. Since Firebird 5 " +
        "the sweep can run with multiple worker threads. A stuck OIT parks " +
        "the truck: nothing can be cleaned."
    },
    {
      id: "cache", code: "CCH", name: "Page Cache Plaza",
      x: 26, y: 24, w: 11, d: 6, h: 0, color: "#4c6ef5",
      short: "Shared page buffers between the engine and the disk.",
      desc: "The virtual I/O layer is three tiers: an abstract interface, " +
        "this cache manager, and physical I/O. Every page the engine reads " +
        "or writes goes through these buffer slots. A green flash is a " +
        "cache hit; red means a miss — the query must ride down to the " +
        "database file and haul the page up. Resize the cache in the " +
        "control panel and watch the hit ratio move."
    },
    {
      id: "journal", code: "REPL", name: "Journal Yard",
      x: 15, y: 29.5, w: 5, d: 4, h: 2.4, color: "#845ef7",
      short: "Committed changes are journalled into segments.",
      desc: "Firebird 4 replication is <em>logical</em>, not physical — and " +
        "it has to be, because there is no write-ahead log to ship. As each " +
        "transaction commits, the changes themselves are written into a " +
        "replication journal segment. When a segment fills it is sealed and " +
        "queued for the replicator; a new one opens behind it. Crucially the " +
        "segments preserve <strong>commit order</strong>, so the replica " +
        "replays history exactly as the primary lived it."
    },
    {
      id: "replicator", code: "REPL", name: "Replicator",
      x: 9, y: 31.5, w: 3, d: 3, h: 3.2, color: "#5f3dc4",
      short: "Ships sealed segments to the replica.",
      desc: "In <strong>asynchronous</strong> mode the replicator hands sealed " +
        "journal segments to the replica at its own pace, and the replica " +
        "trails behind. In <strong>synchronous</strong> mode there is no " +
        "journal at all — the change goes straight down a connection to the " +
        "replica, which costs the commit some latency.<br><br>" +
        "When a replica errors, the commit is <em>not</em> blocked. " +
        "<code>disable_on_error</code> (on by default) tears replication " +
        "down — the engine logs STOP_ERROR, clears the replicating flags and " +
        "disposes the replicator — and the commit succeeds normally. " +
        "Synchronous replication here is not two-phase commit and offers no " +
        "durability guarantee, so there is none to lose: replication simply " +
        "stops, and someone has to notice and turn it back on."
    },
    {
      id: "replica", code: "REPL", name: "Replica Database",
      x: 1.5, y: 33, w: 6, d: 5, h: 0, color: "#7048e8",
      short: "A second database applying the journal in commit order.",
      desc: "The replica is another Firebird database, running read-only in " +
        "replica mode, applying the arriving segments in the order they were " +
        "committed. It is not a copy of the primary's pages — it is the same " +
        "history, replayed. If it applies slower than the primary generates, " +
        "the lag grows and unshipped segments pile up on disk, and that disk " +
        "is the one the primary is also writing to. A replica that is merely " +
        "slow is an inconvenience; a replica that is gone is a disk-space " +
        "problem with a deadline."
    },
    {
      id: "delta", code: "DELTA", name: "Difference File",
      x: 41, y: 34, w: 5.5, d: 6, h: 0, color: "#e8590c",
      short: "Where writes go while nbackup holds the database locked.",
      desc: "When nbackup locks the database (nbackup -L), the main file is " +
        "frozen so it can be copied safely while the server keeps running. " +
        "Every page written from that moment lands here in the difference " +
        "file instead. Readers still read the frozen main file; writers " +
        "quietly fill this pit. On unlock, the delta is merged back into the " +
        "database file and the main file goes live again. Forget to unlock " +
        "and this pit grows forever — a classic Firebird operations story."
    },
    {
      id: "gbak", code: "GBAK", name: "gbak Depot",
      x: 48.5, y: 32, w: 4, d: 3, h: 2.6, color: "#0ca678",
      short: "Logical backup — and a snapshot that pins the OIT.",
      desc: "gbak takes a logical backup: it attaches to the database like " +
        "any other client, reads every table through a snapshot transaction " +
        "and writes a portable .fbk file that a restore rebuilds from " +
        "scratch. It runs online — but watch the Transaction Hall while it " +
        "does. Its snapshot transaction pins the OIT for the entire run, so " +
        "garbage collection stalls and record versions pile up until the " +
        "backup finishes. A nightly gbak against a busy database and a " +
        "mysteriously bloating database are very often the same story."
    },
    {
      id: "nbackup", code: "NBACKUP", name: "nbackup Vault",
      x: 54, y: 32.5, w: 3.2, d: 3.2, h: 3.4, color: "#1098ad",
      short: "Physical, incremental backup by level.",
      desc: "nbackup copies the database file itself, incrementally, by " +
        "level. Level 0 is the whole file; level 1 copies only the pages " +
        "that changed since level 0; level 2 only those changed since level " +
        "1, and so on. Each level is fast and small, but a restore must " +
        "apply the whole chain in order — lose level 0 and the rest are " +
        "waste paper. Locking the database sends new writes to the " +
        "difference file so the frozen main file can be copied safely."
    },
    {
      id: "pio", code: "PIO", name: "Database File — Physical I/O",
      x: 24, y: 34, w: 15, d: 6, h: 0, color: "#5f3dc4",
      short: "Careful writes instead of a WAL.",
      desc: "The physical I/O layer reads and writes pages of the single " +
        "database file. Classic Firebird recovers from crashes without a " +
        "write-ahead log by using careful writes: pages are flushed in an " +
        "order that keeps the on-disk structure consistent at every " +
        "instant — a page is never written before the pages it points to " +
        "exist. The excavation below the city is the file itself."
    }
  ];

  var byId = {};
  buildings.forEach(function (b) { byId[b.id] = b; });

  // "Door" of each building: where particles stop.
  var stations = {};
  buildings.forEach(function (b) {
    stations[b.id] = { x: b.x + b.w / 2, y: b.y + b.d + 0.6 };
  });
  // Overrides for nicer traffic flow.
  stations.harbor = { x: 4.6, y: 20 };
  stations.yvalve = { x: 8, y: 20.2 };
  stations.lexer = { x: 13.5, y: 18.2 };
  stations.parser = { x: 17.5, y: 18.2 };
  stations.blrgen = { x: 21.5, y: 18.2 };
  stations.security = { x: 25, y: 19.8 };
  stations.cmp = { x: 30, y: 19.2 };
  stations.exec = { x: 36.5, y: 19.2 };
  stations.cache = { x: 31.5, y: 27 };
  stations.pio = { x: 31.5, y: 36.5 };
  stations.lock = { x: 31.5, y: 4.8 };
  stations.mvcc = { x: 52, y: 16 };
  stations.tra = { x: 36.5, y: 10 };
  stations.met = { x: 30, y: 12 };
  stations.btr = { x: 43.5, y: 12 };
  stations.sort = { x: 43.5, y: 19.2 };
  stations.gc = { x: 49.5, y: 25.5 };
  stations.journal = { x: 17.5, y: 34 };
  stations.replicator = { x: 10.5, y: 35 };
  stations.replica = { x: 4.5, y: 32.6 };
  stations.delta = { x: 43.7, y: 33.4 };
  stations.gbak = { x: 50.5, y: 35.4 };
  stations.nbackup = { x: 55.6, y: 36 };

  var districts = [
    { name: "REMOTE — the harbor", x: -1, y: 14, w: 11, d: 12, color: "rgba(61,139,253,0.10)" },
    { name: "DSQL — translation quarter", x: 11, y: 13, w: 13, d: 6.5, color: "rgba(139,92,246,0.10)" },
    { name: "JRD — engine downtown", x: 27, y: 4, w: 20, d: 21, color: "rgba(32,201,151,0.08)" },
    { name: "VIO / MVCC — version towers", x: 47, y: 10, w: 10, d: 18, color: "rgba(77,171,247,0.10)" },
    { name: "CCH — page cache", x: 25, y: 23, w: 13, d: 8, color: "rgba(76,110,245,0.12)" },
    { name: "PIO — database file", x: 23, y: 33, w: 17, d: 8, color: "rgba(95,61,196,0.16)" },
    { name: "REPL — journal, ship, apply", x: 0.5, y: 28, w: 20.5, d: 13, color: "rgba(132,94,247,0.09)" },
    { name: "delta — difference file", x: 40.4, y: 33.2, w: 6.7, d: 7.6, color: "rgba(232,89,12,0.12)" },
    { name: "backup yard — gbak & nbackup", x: 47.6, y: 30.6, w: 11.4, d: 9.8, color: "rgba(16,152,173,0.10)" }
  ];

  // Main road as sequences of station ids.
  var roads = [
    ["harbor", "yvalve", "lexer", "parser", "blrgen", "security", "cmp", "exec"],
    ["exec", "cache"],
    ["cache", "pio"],
    ["exec", "lock"],
    ["exec", "mvcc"],
    ["mvcc", "tra"],
    ["tra", "exec"],
    ["cmp", "met"],
    ["exec", "btr"],
    ["exec", "sort"],
    ["gc", "mvcc"],
    ["pio", "delta"],
    ["delta", "gbak"],
    ["gbak", "nbackup"],
    ["tra", "journal"],
    ["journal", "replicator"],
    ["replicator", "replica"]
  ];

  /* Operator decisions: situations where Firebird hands you a genuinely hard
   * call, both options cost something, and the verdict is measured from what
   * actually happened in the model rather than asserted. */
  var challenges = [
    {
      id: "sweepblock",
      title: "Sweep is blocked",
      situation: "An attachment has been sitting in a transaction for a long " +
        "time without committing. It pins the OIT, so garbage collection " +
        "cannot touch anything newer, and record versions are piling up on " +
        "every table. The application team says the session 'might still be " +
        "doing something'.",
      options: [
        { id: "kill", label: "Terminate the attachment",
          detail: "DELETE FROM MON$ATTACHMENTS — the OIT advances immediately " +
            "and garbage collection resumes. Whatever that transaction had " +
            "done is rolled back." },
        { id: "wait", label: "Wait for it to commit",
          detail: "Nothing is lost, but nothing is collected either. The " +
            "versions keep accumulating for as long as it sits there." }
      ]
    },
    {
      id: "gbakwindow",
      title: "The backup is holding the OIT",
      situation: "The nightly gbak started, and the workload did not go home " +
        "with the day shift. gbak's snapshot pins the OIT for as long as it " +
        "runs, so garbage collection is stalled and versions are climbing — " +
        "but the backup is the reason you can sleep at night.",
      options: [
        { id: "finish", label: "Let the backup finish",
          detail: "You get tonight's backup. Versions accumulate until it " +
            "completes and GC catches up afterwards." },
        { id: "cancel", label: "Cancel gbak",
          detail: "The OIT is released now and GC resumes immediately — but " +
            "there is no backup tonight." }
      ]
    },
    {
      id: "replicadown",
      title: "The replica is gone and the segments are stacking up",
      situation: "The replica stopped responding an hour ago. Replication is " +
        "asynchronous, so the primary has carried on happily — but every " +
        "committed change is still being journalled, and none of those " +
        "segments are being shipped. They are accumulating on the same " +
        "volume the database is writing to. Nobody can say yet when the " +
        "replica comes back.",
      options: [
        { id: "drop", label: "Stop replication and discard the backlog",
          detail: "The disk stops filling immediately. The replica is now " +
            "useless — bringing it back means a fresh backup and restore, " +
            "not a resume." },
        { id: "keep", label: "Keep journalling and wait for the replica",
          detail: "If it returns soon, it catches up from where it left off " +
            "and nothing is lost. If it does not, you are racing the free " +
            "space on that volume." }
      ]
    },
    {
      id: "deltagrowing",
      title: "The delta file is growing",
      situation: "Someone locked the database with nbackup -L and never " +
        "unlocked it. The main file is frozen and every page write is landing " +
        "in the difference file, which has been growing all afternoon. Peak " +
        "traffic is still an hour from over.",
      options: [
        { id: "unlock", label: "Unlock and merge now",
          detail: "The delta merges back into the database file. That is real " +
            "I/O, and it lands during peak — but the growth stops." },
        { id: "wait", label: "Wait for the quiet window",
          detail: "Avoids merge I/O now. The delta keeps growing, and it is " +
            "the free space on that volume you are betting." }
      ]
    }
  ];

  var tour = [
    {
      focus: "harbor", zoom: 1.25, title: "Welcome to FBSimCity",
      text: "This city is Firebird. Each building is a real subsystem from the " +
        "conceptual-architecture paper; the glowing particles are queries. " +
        "Firebird is a pipe-and-filter system: requests flow from the harbor " +
        "through the SQL translator into the relational engine, and results " +
        "flow back. Use Next to follow one query's commute."
    },
    {
      focus: "yvalve", zoom: 1.35, title: "REMOTE — arrival",
      text: "Clients dock over TCP/IP or XNET and pass the Y-valve, which " +
        "dispatches each attachment to the right provider. Everything a " +
        "client ever learns about your data comes back through this gate."
    },
    {
      focus: "parser", zoom: 1.3, title: "DSQL — SQL becomes BLR",
      text: "The translation quarter: lexer splits the SQL text into tokens, " +
        "the parser builds a syntax tree, and the BLR generator emits Binary " +
        "Language Representation — the engine's native tongue. Particles " +
        "turn violet once they speak BLR."
    },
    {
      focus: "cmp", zoom: 1.3, title: "CMP — compile & optimize",
      text: "The compiler turns BLR into an execution tree, borrowing table " +
        "and index facts from the Metadata Library (the RDB$ system tables). " +
        "The optimizer picks indexes and join order."
    },
    {
      focus: "exec", zoom: 1.25, title: "EXE — the Execution Hall",
      text: "The heart of JRD. The request tree is interpreted here, pulling " +
        "rows through streams, calling on the B-Tree Gardens for index " +
        "walks and the Sort Yard when no index gives the right order."
    },
    {
      focus: "cache", zoom: 1.25, title: "CCH & PIO — pages and careful writes",
      text: "Every page goes through the cache plaza. Green flash: hit. Red: " +
        "miss — the query rides down to the database file. Firebird has no " +
        "WAL; careful write ordering keeps the file consistent at every " +
        "moment. Shrink the cache in the control panel and watch the misses."
    },
    {
      focus: "mvcc", zoom: 1.2, title: "VIO — record version towers",
      text: "An UPDATE never overwrites a row: it stacks a new version on the " +
        "chain. Readers walk down to the version their snapshot may see — " +
        "readers never block writers. Stale floors wait for demolition."
    },
    {
      focus: "tra", zoom: 1.3, title: "TRA — Next, OAT and OIT",
      text: "The Transaction Hall stamps IDs and tracks state on TIP pages. " +
        "Watch the three counters: Next, Oldest Active, Oldest Interesting. " +
        "GC may only demolish versions older than the OIT. Flip on the " +
        "long-running transaction in the panel and watch OIT freeze — and " +
        "the version towers redden."
    },
    {
      focus: "lock", zoom: 1.3, title: "LOCK — the traffic control tower",
      text: "The shared-memory lock table coordinates concurrent access to " +
        "the database file. Writers queue at the tower when they collide; " +
        "the deadlock scanner occasionally sends one home to retry."
    },
    {
      focus: "journal", zoom: 1.1, title: "REPL — replication without a log",
      text: "Firebird has no write-ahead log to ship, so its replication is " +
        "logical: committed changes are journalled into segments and " +
        "replayed on the replica in commit order. Asynchronous means the " +
        "replica trails and the journal keeps growing while it is away. " +
        "Synchronous sends changes down a live connection instead — and if " +
        "that replica dies, replication does not hang the database, it " +
        "stops itself. Break the replica from the control room and watch " +
        "which of the two happens."
    },
    {
      focus: "gbak", zoom: 1.15, title: "Backup yard — gbak and nbackup",
      text: "Two very different tools. gbak dumps the database logically " +
        "through a normal attachment — but its snapshot pins the OIT for " +
        "the whole run, so a nightly backup of a busy database is itself a " +
        "bloat story. nbackup copies the file physically, level by level; " +
        "while it holds the lock, every new write lands in the orange delta " +
        "pit and is merged back on unlock. Run one from the control room " +
        "and watch the counters."
    },
    {
      focus: "gc", zoom: 1.15, title: "Sweep — and over to you",
      text: "The sweep truck tours the towers demolishing versions below the " +
        "OIT — unless a long transaction parks it. Now experiment: raise " +
        "the query rate, shrink the cache, pin the OIT, hit Sweep now. " +
        "Click any building for its story from the paper."
    }
  ];

  return {
    VERSION: "0.8.0",
    buildings: buildings,
    challenges: challenges,
    byId: byId,
    stations: stations,
    districts: districts,
    roads: roads,
    tour: tour,
    // world bounds for camera fit
    bounds: { x0: -2, y0: 0, x1: 60, y1: 42 }
  };
})();
