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

  var districts = [
    { name: "REMOTE — the harbor", x: -1, y: 14, w: 11, d: 12, color: "rgba(61,139,253,0.10)" },
    { name: "DSQL — translation quarter", x: 11, y: 13, w: 13, d: 6.5, color: "rgba(139,92,246,0.10)" },
    { name: "JRD — engine downtown", x: 27, y: 4, w: 20, d: 21, color: "rgba(32,201,151,0.08)" },
    { name: "VIO / MVCC — version towers", x: 47, y: 10, w: 10, d: 18, color: "rgba(77,171,247,0.10)" },
    { name: "CCH — page cache", x: 25, y: 23, w: 13, d: 8, color: "rgba(76,110,245,0.12)" },
    { name: "PIO — database file", x: 23, y: 33, w: 17, d: 8, color: "rgba(95,61,196,0.16)" }
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
    ["gc", "mvcc"]
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
      focus: "gc", zoom: 1.15, title: "Sweep — and over to you",
      text: "The sweep truck tours the towers demolishing versions below the " +
        "OIT — unless a long transaction parks it. Now experiment: raise " +
        "the query rate, shrink the cache, pin the OIT, hit Sweep now. " +
        "Click any building for its story from the paper."
    }
  ];

  return {
    VERSION: "0.3.0",
    buildings: buildings,
    byId: byId,
    stations: stations,
    districts: districts,
    roads: roads,
    tour: tour,
    // world bounds for camera fit
    bounds: { x0: -2, y0: 0, x1: 58, y1: 41 }
  };
})();
