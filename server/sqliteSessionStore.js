const session = require('express-session');
const db = require('./db');

const upsertStmt = db.prepare(`
  INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data
`);
const getStmt = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
const destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
const clearExpiredStmt = db.prepare('DELETE FROM sessions WHERE expires < ?');
const touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    // Periodically sweep expired sessions.
    this._sweep = setInterval(() => {
      clearExpiredStmt.run(Date.now());
    }, 60 * 60 * 1000);
    this._sweep.unref();
  }

  get(sid, cb) {
    try {
      const row = getStmt.get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        destroyStmt.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge
        ? sessionData.cookie.maxAge
        : 24 * 60 * 60 * 1000;
      const expires = Date.now() + maxAge;
      upsertStmt.run(sid, expires, JSON.stringify(sessionData));
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      destroyStmt.run(sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge
        ? sessionData.cookie.maxAge
        : 24 * 60 * 60 * 1000;
      touchStmt.run(Date.now() + maxAge, sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }
}

module.exports = SqliteSessionStore;
