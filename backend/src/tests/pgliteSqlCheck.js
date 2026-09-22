/* 端到端 SQL 语义验证（pglite，无需外部 PG 服务） */
const { PGlite } = require('@electric-sql/pglite');

const assert = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) {
    console.log('  ', extra);
    process.exitCode = 1;
  }
};

const run = async () => {
  const db = new PGlite();

  await db.exec(`
    CREATE TABLE volunteers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      total_points INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      credit_score INTEGER NOT NULL DEFAULT 100,
      service_count INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE service_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
      service_type VARCHAR(50) NOT NULL,
      duration_hours DECIMAL(6,2) NOT NULL,
      rating INTEGER NOT NULL DEFAULT 5,
      points_earned INTEGER NOT NULL DEFAULT 0,
      is_no_show BOOLEAN NOT NULL DEFAULT false,
      location VARCHAR(200),
      description TEXT,
      batch_no VARCHAR(64),
      recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX uq_service_records_dedup
      ON service_records (
        volunteer_id, date_trunc('second', recorded_at), service_type, duration_hours, COALESCE(location, '')
      );
    CREATE TABLE batch_imports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_no VARCHAR(64) NOT NULL UNIQUE,
      status VARCHAR(20) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','rejected')),
      total_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      request_payload_hash VARCHAR(128),
      result_summary JSONB,
      error_summary JSONB,
      created_by VARCHAR(100) NOT NULL DEFAULT 'anonymous',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP
    );
    CREATE TABLE batch_import_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID NOT NULL REFERENCES batch_imports(id) ON DELETE CASCADE,
      line_number INTEGER NOT NULL,
      service_record_id UUID REFERENCES service_records(id) ON DELETE SET NULL,
      volunteer_id UUID NOT NULL,
      service_type VARCHAR(50) NOT NULL,
      duration_hours DECIMAL(6,2) NOT NULL,
      rating INTEGER NOT NULL,
      is_no_show BOOLEAN NOT NULL DEFAULT false,
      location VARCHAR(200),
      description TEXT,
      recorded_at TIMESTAMP NOT NULL,
      points_earned INTEGER,
      status VARCHAR(20) NOT NULL CHECK (status IN ('accepted','rejected')),
      error_codes JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(batch_id, line_number)
    );
    CREATE TABLE points_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL, change_amount INTEGER NOT NULL, reason VARCHAR(200) NOT NULL, before_points INTEGER NOT NULL, after_points INTEGER NOT NULL, related_id UUID, related_type VARCHAR(50));
    CREATE TABLE badges (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL, star_level INTEGER NOT NULL, badge_name VARCHAR(100) NOT NULL, description TEXT, UNIQUE(volunteer_id, star_level));
  `);

  // 志愿者
  const v1 = (await db.query(`INSERT INTO volunteers(name) VALUES ('张三') RETURNING id`)).rows[0].id;
  const v2 = (await db.query(`INSERT INTO volunteers(name, is_active) VALUES ('李四', false) RETURNING id`)).rows[0].id;

  // ANY($1::uuid[]) 与 ANY($2::timestamp[])
  const past = new Date('2026-09-01T08:00:00Z');
  const review = await db.query(
    `SELECT id, is_active FROM volunteers WHERE id = ANY($1::uuid[])`,
    [[v1, v2]]
  );
  assert('志愿者批量查询 ANY(uuid[]) 返回两人', review.rows.length === 2);

  const timeQ = await db.query(
    `SELECT COUNT(*)::int AS c FROM service_records
     WHERE volunteer_id = ANY($1::uuid[]) AND recorded_at = ANY($2::timestamp[])`,
    [[v1], [past]]
  );
  assert('时间键 ANY(timestamp[]) 查询可执行', timeQ.rows[0].c === 0);

  // 插入一条已存在记录
  await db.query(
    `INSERT INTO service_records (volunteer_id, service_type, duration_hours, rating, recorded_at, location)
     VALUES ($1,'elderly_care',2.00,5,$2,'社区A')`,
    [v1, past]
  );

  // 唯一索引：完全相同键 -> 冲突
  let dupCaught = false;
  try {
    await db.query(
      `INSERT INTO service_records (volunteer_id, service_type, duration_hours, rating, recorded_at, location)
       VALUES ($1,'elderly_care',2.00,5,$2,'社区A')`,
      [v1, past]
    );
  } catch (e) {
    dupCaught = true;
  }
  assert('同志愿者同时间/类型/时长/地点 -> 唯一索引拒绝', dupCaught);

  // 地点 NULL 与 '' 归一：两条都无地点应冲突
  let nullEmptyCaught = false;
  try {
    await db.query(
      `INSERT INTO service_records (volunteer_id, service_type, duration_hours, rating, recorded_at)
       VALUES ($1,'elderly_care',2.00,5,$2)`,
      [v1, past]
    );
  } catch (e) {
    nullEmptyCaught = true;
  }
  // 第一条 location='社区A'，无地点是不同键，应该成功；再插一条 NULL 才冲突
  assert('不同地点不算重复（无地点 vs 社区A）', !nullEmptyCaught);
  let nullNullCaught = false;
  try {
    await db.query(
      `INSERT INTO service_records (volunteer_id, service_type, duration_hours, rating, recorded_at)
       VALUES ($1,'elderly_care',2.00,5,$2)`,
      [v1, past]
    );
  } catch (e) {
    nullNullCaught = true;
  }
  assert('两条都无地点（NULL 归一）-> 冲突', nullNullCaught);

  // 时长不同不冲突
  let durOk = true;
  try {
    await db.query(
      `INSERT INTO service_records (volunteer_id, service_type, duration_hours, rating, recorded_at, location)
       VALUES ($1,'elderly_care',2.50,5,$2,'社区A')`,
      [v1, past]
    );
  } catch (e) {
    durOk = false;
  }
  assert('时长不同不冲突', durOk);

  // 类型不同不冲突
  let typeOk = true;
  try {
    await db.query(
      `INSERT INTO service_records (volunteer_id, service_type, duration_hours, rating, recorded_at, location)
       VALUES ($1,'education',2.00,5,$2,'社区A')`,
      [v1, past]
    );
  } catch (e) {
    typeOk = false;
  }
  assert('类型不同不冲突', typeOk);

  // 不同志愿者不冲突
  let otherVolOk = true;
  try {
    await db.query(
      `INSERT INTO service_records (volunteer_id, service_type, duration_hours, rating, recorded_at, location)
       VALUES ($1,'elderly_care',2.00,5,$2,'社区A')`,
      [v2, past]
    );
  } catch (e) {
    otherVolOk = false;
  }
  assert('不同志愿者不冲突', otherVolOk);

  // NOT EXISTS 守卫：重复键时不插入、rowCount=0
  const guardDup = await db.query(
    `INSERT INTO service_records
       (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show, location, description, batch_no, recorded_at)
     SELECT $1,'elderly_care',2.00,5,10,false,'社区A',NULL,$2,$3
     WHERE NOT EXISTS (
       SELECT 1 FROM service_records s
       WHERE s.volunteer_id=$1 AND s.recorded_at=$3 AND s.service_type='elderly_care'
         AND s.duration_hours=2.00 AND COALESCE(s.location,'')=COALESCE($4,'')
     ) RETURNING id`,
    [v1, 'B-001', past, '社区A']
  );
  assert('NOT EXISTS 守卫：重复时 0 行不抛错', guardDup.rows.length === 0);

  const guardNew = await db.query(
    `INSERT INTO service_records
       (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show, location, description, batch_no, recorded_at)
     SELECT $1,'medical_assist',3.00,5,48,false,'社区B',NULL,$2,$3
     WHERE NOT EXISTS (
       SELECT 1 FROM service_records s
       WHERE s.volunteer_id=$1 AND s.recorded_at=$3 AND s.service_type='medical_assist'
         AND s.duration_hours=3.00 AND COALESCE(s.location,'')=COALESCE($4,'')
     ) RETURNING id`,
    [v1, 'B-001', new Date('2026-09-02T08:00:00Z'), '社区B']
  );
  assert('NOT EXISTS 守卫：新记录正常插入', guardNew.rows.length === 1);

  // 咨询锁可执行（串行化保证）
  await db.query('BEGIN');
  const lock = await db.query('SELECT pg_advisory_xact_lock($1,$2)', [0x12345678, 0x0fabcd12]);
  await db.query('COMMIT');
  assert('pg_advisory_xact_lock 可执行', !!lock);

  // 批次号唯一
  await db.query(`INSERT INTO batch_imports(batch_no,total_count) VALUES ('B1',2)`);
  let batchDup = false;
  try {
    await db.query(`INSERT INTO batch_imports(batch_no,total_count) VALUES ('B1',3)`);
  } catch (e) {
    batchDup = true;
  }
  assert('batch_no 唯一约束', batchDup);

  // 明细行号唯一（同批次）
  const bid = (await db.query(`SELECT id FROM batch_imports WHERE batch_no='B1'`)).rows[0].id;
  await db.query(
    `INSERT INTO batch_import_items(batch_id,line_number,volunteer_id,service_type,duration_hours,rating,recorded_at,status,error_codes)
     VALUES ($1,1,$2,'elderly_care',2,5,$3,'rejected',$4)`,
    [bid, v1, past, JSON.stringify(['FUTURE_RECORDED_AT'])]
  );
  let lineDup = false;
  try {
    await db.query(
      `INSERT INTO batch_import_items(batch_id,line_number,volunteer_id,service_type,duration_hours,rating,recorded_at,status)
       VALUES ($1,1,$2,'elderly_care',2,5,$3,'rejected')`,
      [bid, v1, past]
    );
  } catch (e) {
    lineDup = true;
  }
  assert('同批次 line_number 唯一约束', lineDup);

  // error_codes JSONB 回读
  const item = (await db.query(`SELECT error_codes FROM batch_import_items WHERE batch_id=$1 AND line_number=1`, [bid])).rows[0];
  assert('error_codes JSONB 正确回读', Array.isArray(item.error_codes) && item.error_codes[0] === 'FUTURE_RECORDED_AT', item.error_codes);

  // 级联删除
  await db.query(`DELETE FROM batch_imports WHERE id=$1`, [bid]);
  const left = (await db.query(`SELECT COUNT(*)::int c FROM batch_import_items WHERE batch_id=$1`, [bid])).rows[0].c;
  assert('删除批次级联删除明细', left === 0);

  // FOR UPDATE
  await db.query('BEGIN');
  const fu = await db.query('SELECT * FROM volunteers WHERE id = ANY($1::uuid[]) FOR UPDATE', [[v1]]);
  await db.query('COMMIT');
  assert('SELECT ... FOR UPDATE 可执行', fu.rows.length === 1);

  console.log('\nSQL 语义验证完成');
};

run().catch(e => {
  console.error(e);
  process.exit(1);
});
