/* 用 PGlite 模拟 node-postgres 的 Pool/PoolClient。
   pglite 为单连接：用一把异步互斥锁串行化全部访问；
   事务在 BEGIN 时持锁、COMMIT/ROLLBACK 时释放，保证事务体原子。
   这等价于真实 PG 中 pg_advisory_xact_lock 对同批次号的串行化（更强：全局串行）。 */
const { PGlite } = require('@electric-sql/pglite');

const coerceValue = (value) => (value === undefined ? null : value);

const createMutex = () => {
  let locked = false;
  const waiters = [];
  return {
    async acquire() {
      if (locked) {
        await new Promise((resolve) => waiters.push(resolve));
      }
      locked = true;
    },
    release() {
      locked = false;
      const next = waiters.shift();
      if (next) next();
    },
  };
};

class PGliteClient {
  constructor(pglite, mutex, txState) {
    this._pg = pglite;
    this._mutex = mutex;
    this._tx = txState;
  }

  async query(text, params) {
    const sql = text.trim();
    const isTxControl = sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK';

    if (sql === 'BEGIN') {
      await this._mutex.acquire();
      this._tx.active = true;
      await this._pg.exec('BEGIN');
      return { rows: [], rowCount: 0 };
    }

    // 事务内查询已持锁；事务外查询临时取锁
    if (!this._tx.active) {
      await this._mutex.acquire();
    }
    try {
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        await this._pg.exec(sql);
        return { rows: [], rowCount: 0 };
      }
      if (params === undefined) {
        const result = await this._pg.query(sql);
        return { rows: result.rows, rowCount: result.rows.length };
      }
      const result = await this._pg.query(sql, params.map(coerceValue));
      const rowCount = /RETURNING/i.test(sql)
        ? result.rows.length
        : result.affectedRows !== undefined
          ? result.affectedRows
          : result.rows.length;
      return { rows: result.rows, rowCount };
    } finally {
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        this._tx.active = false;
        this._mutex.release();
      } else if (!this._tx.active) {
        this._mutex.release();
      }
    }
  }

  release() {}
}

const createPGlitePool = async () => {
  const pglite = new PGlite();
  const mutex = createMutex();
  // 单连接单事务状态；service 在并发调用下通过互斥锁串行
  const txState = { active: false };
  const client = new PGliteClient(pglite, mutex, txState);

  const pool = {
    async connect() {
      return client;
    },
    async query(text, params) {
      return client.query(text, params);
    },
  };

  return { pool, pglite, client };
};

module.exports = { createPGlitePool };
