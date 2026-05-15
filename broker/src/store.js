import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        domain TEXT,
        mode TEXT NOT NULL,
        chrome_group_id INTEGER,
        title TEXT,
        color TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tabs (
        id INTEGER PRIMARY KEY,
        lease_id TEXT NOT NULL,
        url TEXT,
        title TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY (lease_id) REFERENCES leases(id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        lease_id TEXT,
        tab_id INTEGER,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT,
        bytes INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        lease_id TEXT,
        agent_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT,
        extractor TEXT,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS job_logs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id)
      );
    `);
  }

  createLease(lease) {
    this.db.prepare(`INSERT INTO leases
      (id, agent_id, task_id, domain, mode, chrome_group_id, title, color, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(lease.id, lease.agentId, lease.taskId, lease.domain, lease.mode, lease.chromeGroupId ?? null, lease.title, lease.color, lease.status, lease.createdAt, lease.expiresAt);
    return lease;
  }

  updateLeaseGroup(id, chromeGroupId) {
    this.db.prepare('UPDATE leases SET chrome_group_id = ? WHERE id = ?').run(chromeGroupId, id);
  }

  releaseLease(id, status = 'released') {
    this.db.prepare('UPDATE leases SET status = ?, released_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
  }

  getLease(id) {
    return mapLease(this.db.prepare('SELECT * FROM leases WHERE id = ?').get(id));
  }

  listLeases({ activeOnly = false } = {}) {
    const sql = activeOnly
      ? "SELECT * FROM leases WHERE status = 'allocated' ORDER BY created_at DESC"
      : 'SELECT * FROM leases ORDER BY created_at DESC LIMIT 200';
    return this.db.prepare(sql).all().map(mapLease);
  }

  addTab(tab) {
    this.db.prepare(`INSERT OR REPLACE INTO tabs (id, lease_id, url, title, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(tab.id, tab.leaseId, tab.url ?? null, tab.title ?? null, tab.status, tab.createdAt);
  }

  closeTab(tabId) {
    this.db.prepare('UPDATE tabs SET status = ?, closed_at = ? WHERE id = ?').run('closed', new Date().toISOString(), tabId);
  }

  listTabs(leaseId = null) {
    const rows = leaseId
      ? this.db.prepare('SELECT * FROM tabs WHERE lease_id = ? ORDER BY created_at DESC').all(leaseId)
      : this.db.prepare('SELECT * FROM tabs ORDER BY created_at DESC LIMIT 300').all();
    return rows.map(mapTab);
  }

  addArtifact(artifact) {
    this.db.prepare(`INSERT INTO artifacts (id, lease_id, tab_id, kind, path, mime_type, bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(artifact.id, artifact.leaseId ?? null, artifact.tabId ?? null, artifact.kind, artifact.path, artifact.mimeType ?? null, artifact.bytes ?? null, artifact.createdAt);
  }

  getArtifact(id) {
    return mapArtifact(this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id));
  }

  listArtifacts({ leaseId = null, kind = null, limit = 300, before = null } = {}) {
    const where = [];
    const args = [];
    if (leaseId) { where.push('lease_id = ?'); args.push(leaseId); }
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (before) { where.push('created_at < ?'); args.push(before); }
    const sql = `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, Math.max(1, Math.min(1000, Number(limit) || 300)));
    return rows.map(mapArtifact);
  }

  deleteArtifact(id) {
    this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
  }

  createJob(job) {
    this.db.prepare(`INSERT INTO jobs
      (id, lease_id, agent_id, task_id, kind, status, url, extractor, attempts, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.leaseId ?? null, job.agentId ?? null, job.taskId ?? null, job.kind, job.status, job.url ?? null, job.extractor ?? null, job.attempts ?? 0, job.maxAttempts ?? 1, job.createdAt, job.updatedAt);
    return job;
  }

  updateJob(id, patch) {
    const fields = [];
    const args = [];
    const mapping = { leaseId: 'lease_id', agentId: 'agent_id', taskId: 'task_id', maxAttempts: 'max_attempts', finishedAt: 'finished_at' };
    for (const [key, value] of Object.entries(patch)) {
      const column = mapping[key] || key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      fields.push(`${column} = ?`);
      args.push(value);
    }
    fields.push('updated_at = ?');
    args.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...args);
  }

  getJob(id) {
    return mapJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  }

  listJobs({ status = null, limit = 100 } = {}) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, capped)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(capped);
    return rows.map(mapJob);
  }

  addJobLog(log) {
    this.db.prepare(`INSERT INTO job_logs (id, job_id, level, event, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(log.id, log.jobId, log.level, log.event, log.data == null ? null : JSON.stringify(log.data), log.createdAt);
  }

  listJobLogs(jobId) {
    return this.db.prepare('SELECT * FROM job_logs WHERE job_id = ? ORDER BY created_at ASC').all(jobId).map(mapJobLog);
  }
}

function mapLease(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    taskId: row.task_id,
    domain: row.domain,
    mode: row.mode,
    chromeGroupId: row.chrome_group_id,
    title: row.title,
    color: row.color,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
  };
}

function mapTab(row) {
  return {
    id: row.id,
    leaseId: row.lease_id,
    url: row.url,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

function mapArtifact(row) {
  return {
    id: row.id,
    leaseId: row.lease_id,
    tabId: row.tab_id,
    kind: row.kind,
    path: row.path,
    mimeType: row.mime_type,
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}


function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    leaseId: row.lease_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    url: row.url,
    extractor: row.extractor,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

function mapJobLog(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    level: row.level,
    event: row.event,
    data: row.data ? JSON.parse(row.data) : null,
    createdAt: row.created_at,
  };
}
