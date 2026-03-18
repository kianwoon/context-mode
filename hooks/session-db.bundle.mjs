import{createRequire as p}from"node:module";import{unlinkSync as _}from"node:fs";import{tmpdir as T}from"node:os";import{join as g}from"node:path";var E=null;function h(){return E||(E=p(import.meta.url)("better-sqlite3")),E}function R(i){i.pragma("journal_mode = WAL"),i.pragma("synchronous = NORMAL"),i.pragma("busy_timeout = 2000")}function S(i){for(let t of["","-wal","-shm"])try{_(i+t)}catch{}}function d(i){try{i.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{i.close()}catch{}}function c(i="context-mode"){return g(T(),`${i}-${process.pid}.db`)}var a=class{#e;#t;constructor(t){let s=h();this.#e=t,this.#t=new s(t,{timeout:5e3}),R(this.#t),this.initSchema(),this.prepareStatements()}get db(){return this.#t}get dbPath(){return this.#e}close(){d(this.#t)}cleanup(){d(this.#t),S(this.#e)}};import{createHash as m}from"node:crypto";import{execFileSync as l}from"node:child_process";function U(){let i=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(i!==void 0)return i?`__${i}`:"";try{let t=process.cwd(),s=l("git",["worktree","list","--porcelain"],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).split(/\r?\n/).find(n=>n.startsWith("worktree "))?.replace("worktree ","")?.trim();if(s&&t!==s)return`__${m("sha256").update(t).digest("hex").slice(0,8)}`}catch{}return""}var y=1e3,v=5,e={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",incrementCompactCount:"incrementCompactCount",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions"},u=class extends a{constructor(t){super(t?.dbPath??c("session"))}stmt(t){return this.stmts.get(t)}initSchema(){try{let s=this.db.pragma("table_xinfo(session_events)").find(n=>n.name==="data_hash");s&&s.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );
    `)}prepareStatements(){this.stmts=new Map;let t=(s,n)=>{this.stmts.set(s,this.db.prepare(n))};t(e.insertEvent,`INSERT INTO session_events (session_id, type, category, priority, data, source_hook, data_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),t(e.getEvents,`SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),t(e.getEventsByType,`SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),t(e.getEventsByPriority,`SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(e.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),t(e.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),t(e.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),t(e.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),t(e.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),t(e.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),t(e.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),t(e.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),t(e.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),t(e.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),t(e.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),t(e.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),t(e.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),t(e.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),t(e.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')")}insertEvent(t,s,n="PostToolUse"){let r=m("sha256").update(s.data).digest("hex").slice(0,16).toUpperCase();this.db.transaction(()=>{if(this.stmt(e.checkDuplicate).get(t,v,s.type,r))return;this.stmt(e.getEventCount).get(t).cnt>=y&&this.stmt(e.evictLowestPriority).run(t),this.stmt(e.insertEvent).run(t,s.type,s.category,s.priority,s.data,n,r),this.stmt(e.updateMetaLastEvent).run(t)})()}getEvents(t,s){let n=s?.limit??1e3,r=s?.type,o=s?.minPriority;return r&&o!==void 0?this.stmt(e.getEventsByTypeAndPriority).all(t,r,o,n):r?this.stmt(e.getEventsByType).all(t,r,n):o!==void 0?this.stmt(e.getEventsByPriority).all(t,o,n):this.stmt(e.getEvents).all(t,n)}getEventCount(t){return this.stmt(e.getEventCount).get(t).cnt}ensureSession(t,s){this.stmt(e.ensureSession).run(t,s)}getSessionStats(t){return this.stmt(e.getSessionStats).get(t)??null}incrementCompactCount(t){this.stmt(e.incrementCompactCount).run(t)}upsertResume(t,s,n){this.stmt(e.upsertResume).run(t,s,n??0)}getResume(t){return this.stmt(e.getResume).get(t)??null}markResumeConsumed(t){this.stmt(e.markResumeConsumed).run(t)}deleteSession(t){this.db.transaction(()=>{this.stmt(e.deleteEvents).run(t),this.stmt(e.deleteResume).run(t),this.stmt(e.deleteMeta).run(t)})()}cleanupOldSessions(t=7){let s=`-${t}`,n=this.stmt(e.getOldSessions).all(s);for(let{session_id:r}of n)this.deleteSession(r);return n.length}};export{u as SessionDB,U as getWorktreeSuffix};
