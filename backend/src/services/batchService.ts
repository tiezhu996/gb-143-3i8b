import {
  ApiResponse,
  Badge,
  BatchDetailsData,
  BatchImportData,
  BatchLineError,
  BatchRejectData,
  BatchResultSnapshot,
  BatchVolunteerResult,
  ServiceRecord,
  ServiceRecordBatch,
  Volunteer,
} from '../types';
import pool, { DbClient } from '../db/pool';
import { batchItemSchema } from '../middleware/validator';
import { messages } from '../constants/messages';
import { logger } from '../utils/logger';
import { calculatePoints, calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel, checkNewBadges } from './badgeService';
import { recalculateCreditScore, logCreditChange } from './creditService';

const MAX_BATCH_SIZE = 500;

const ERROR_CODE_ORDER: Record<string, number> = {
  INVALID_FORMAT: 1,
  VOLUNTEER_NOT_FOUND: 2,
  VOLUNTEER_INACTIVE: 3,
  FUTURE_RECORDED_AT: 4,
  DUPLICATE_IN_BATCH: 5,
  DUPLICATE_EXISTING: 6,
};

interface ValidBatchItem {
  line: number;
  record: ServiceRecord;
}

export interface BatchHttpResult {
  status: number;
  body: ApiResponse<BatchImportData | BatchRejectData>;
}

const normalizeLocation = (location?: string | null): string => {
  return location === undefined || location === null ? '' : String(location).trim();
};

const normalizeDuration = (duration: number): number => {
  return Math.round(duration * 100) / 100;
};

const dedupeKey = (
  volunteerId: string,
  recordedAt: Date,
  serviceType: string,
  durationHours: number,
  location: string
): string => {
  return [
    volunteerId,
    recordedAt.getTime().toString(),
    serviceType,
    durationHours.toFixed(2),
    location,
  ].join('|');
};

const sortErrors = (errors: BatchLineError[]): BatchLineError[] => {
  return [...errors].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return (ERROR_CODE_ORDER[a.code] || 99) - (ERROR_CODE_ORDER[b.code] || 99);
  });
};

const parseBatchRow = (row: ServiceRecordBatch): ServiceRecordBatch => ({
  ...row,
  errors: row.errors ?? undefined,
  result_snapshot: row.result_snapshot ?? null,
});

const buildReplayBody = (row: ServiceRecordBatch): BatchHttpResult => {
  const batch = parseBatchRow(row);

  if (batch.status === 'processing') {
    return {
      status: 409,
      body: {
        success: false,
        error: messages.batch.importFailed,
        details: { batch_no: batch.batch_no, status: 'processing' },
      },
    };
  }

  if (batch.status === 'rejected') {
    const data: BatchRejectData = {
      batch_id: batch.id,
      batch_no: batch.batch_no,
      status: 'rejected',
      total: batch.total_count,
      successCount: 0,
      failCount: batch.fail_count,
      errors: batch.errors || [],
      replayed: true,
    };
    return {
      status: 400,
      body: { success: false, error: messages.batch.rejected, data },
    };
  }

  const snapshot = (batch.result_snapshot || {}) as BatchResultSnapshot;
  const data: BatchImportData = {
    ...snapshot,
    batch_id: batch.id,
    batch_no: batch.batch_no,
    status: 'completed',
    total: batch.total_count,
    successCount: batch.success_count,
    failCount: 0,
    replayed: true,
    created_at: batch.created_at,
    processed_at: batch.processed_at,
  };
  return {
    status: 200,
    body: { success: true, message: messages.batch.completed, data },
  };
};

export const importServiceRecordBatch = async (
  batchNo: string,
  rawRecords: unknown[],
  createdBy: string
): Promise<BatchHttpResult> => {
  // 第一步：逐行格式校验（Joi），记录所有不合法行号
  const formatErrors: BatchLineError[] = [];
  const validItems: ValidBatchItem[] = [];

  rawRecords.forEach((raw, index) => {
    const line = index + 1;
    const { error, value } = batchItemSchema.validate(raw, { abortEarly: false });
    if (error) {
      formatErrors.push({
        line,
        code: 'INVALID_FORMAT',
        message: error.details.map(d => d.message).join('；'),
      });
    } else {
      value.duration_hours = normalizeDuration(value.duration_hours);
      value.location = normalizeLocation(value.location) || null;
      validItems.push({ line, record: value });
    }
  });

  const client: DbClient = await pool.connect();

  try {
    await client.query('BEGIN');

    // 同一批次号全局串行：事务级咨询锁，保证并发提交只产生一套结果
    const lockResult = await client.query('SELECT hashtextextended($1, 0) AS lock_key', [batchNo]);
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockResult.rows[0].lock_key]);

    const existingResult = await client.query(
      'SELECT * FROM service_record_batches WHERE batch_no = $1',
      [batchNo]
    );
    if (existingResult.rows.length > 0) {
      // 批次号重复：幂等回读已有结果，不重复入账
      await client.query('ROLLBACK');
      return buildReplayBody(existingResult.rows[0]);
    }

    const batchInsert = await client.query(
      `INSERT INTO service_record_batches (batch_no, status, total_count, created_by)
       VALUES ($1, 'processing', $2, $3)
       RETURNING *`,
      [batchNo, rawRecords.length, createdBy]
    );
    const batchId: string = batchInsert.rows[0].id;

    const nowResult = await client.query('SELECT CURRENT_TIMESTAMP AS now');
    const dbNow: Date = nowResult.rows[0].now;

    const errors: BatchLineError[] = [...formatErrors];

    // 第二步：志愿者存在且启用
    const volunteerIds = [...new Set(validItems.map(item => item.record.volunteer_id))];
    const volunteerMap = new Map<string, Volunteer>();
    if (volunteerIds.length > 0) {
      // FOR UPDATE：锁定本批涉及的志愿者，串行化并发批次的重复判定
      const volunteerResult = await client.query(
        'SELECT * FROM volunteers WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [volunteerIds]
      );
      volunteerResult.rows.forEach((row: Volunteer) => volunteerMap.set(row.id, row));
    }

    // 记录时间不能在未来；缺省时间统一取事务当前时间
    const effectiveTimes = new Map<number, Date>();
    for (const item of validItems) {
      const volunteer = volunteerMap.get(item.record.volunteer_id);
      if (!volunteer) {
        errors.push({ line: item.line, code: 'VOLUNTEER_NOT_FOUND', message: messages.batch.volunteerNotFound });
      } else if (!volunteer.is_active) {
        errors.push({ line: item.line, code: 'VOLUNTEER_INACTIVE', message: messages.batch.volunteerInactive });
      }

      const recordedAt = item.record.recorded_at ? new Date(item.record.recorded_at) : dbNow;
      effectiveTimes.set(item.line, recordedAt);
      if (recordedAt.getTime() > dbNow.getTime()) {
        errors.push({ line: item.line, code: 'FUTURE_RECORDED_AT', message: messages.batch.futureRecordedAt });
      }
    }

    // 第三步：批次内重复（同一志愿者相同时间、类型、时长、地点）
    const seenKeys = new Map<string, number>();
    for (const item of validItems) {
      const recordedAt = effectiveTimes.get(item.line)!;
      const key = dedupeKey(
        item.record.volunteer_id,
        recordedAt,
        item.record.service_type,
        item.record.duration_hours,
        normalizeLocation(item.record.location)
      );
      const firstLine = seenKeys.get(key);
      if (firstLine === undefined) {
        seenKeys.set(key, item.line);
      } else {
        errors.push({
          line: item.line,
          code: 'DUPLICATE_IN_BATCH',
          message: messages.batch.duplicateInBatch.replace('{line}', String(firstLine)),
        });
      }
    }

    // 第四步：与已入账记录重复
    if (validItems.length > 0) {
      const valuesSql: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      validItems.forEach(item => {
        valuesSql.push(
          `($${paramIndex}::uuid, $${paramIndex + 1}::timestamp, $${paramIndex + 2}::varchar, ` +
          `$${paramIndex + 3}::numeric, $${paramIndex + 4}::varchar, $${paramIndex + 5}::int)`
        );
        params.push(
          item.record.volunteer_id,
          effectiveTimes.get(item.line),
          item.record.service_type,
          item.record.duration_hours,
          normalizeLocation(item.record.location),
          item.line
        );
        paramIndex += 6;
      });

      const duplicateResult = await client.query(
        `SELECT DISTINCT v.line AS line
         FROM (VALUES ${valuesSql.join(', ')})
           AS v(volunteer_id, recorded_at, service_type, duration_hours, location, line)
         JOIN service_records sr
           ON sr.volunteer_id = v.volunteer_id
          AND sr.recorded_at = v.recorded_at
          AND sr.service_type = v.service_type
          AND sr.duration_hours = v.duration_hours
          AND COALESCE(sr.location, '') = COALESCE(v.location, '')`,
        params
      );

      duplicateResult.rows.forEach(row => {
        errors.push({ line: Number(row.line), code: 'DUPLICATE_EXISTING', message: messages.batch.duplicateExisting });
      });
    }

    // 任一问题：整批拒绝，记录/积分/等级/徽章/信用均不写入
    if (errors.length > 0) {
      const sortedErrors = sortErrors(errors);
      await client.query(
        `UPDATE service_record_batches
         SET status = 'rejected', fail_count = $1, errors = $2, processed_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [rawRecords.length, JSON.stringify(sortedErrors), batchId]
      );
      await client.query('COMMIT');

      const data: BatchRejectData = {
        batch_id: batchId,
        batch_no: batchNo,
        status: 'rejected',
        total: rawRecords.length,
        successCount: 0,
        failCount: rawRecords.length,
        errors: sortedErrors,
        replayed: false,
      };
      return {
        status: 400,
        body: { success: false, error: messages.batch.rejected, data },
      };
    }

    // 第五步：全部合格，统一入账
    const recordIds: string[] = [];
    const pointsChangeByVolunteer = new Map<string, number>();
    const serviceCountDelta = new Map<string, number>();
    const runningPoints = new Map<string, number>();

    for (const item of validItems) {
      const volunteer = volunteerMap.get(item.record.volunteer_id)!;
      const isNoShow = item.record.is_no_show || false;
      const pointsEarned = isNoShow ? 0 : calculatePoints(
        item.record.duration_hours,
        item.record.service_type,
        item.record.rating
      );
      const pointsChange = isNoShow ? -calculateNoShowPenalty() : pointsEarned;

      const insertResult = await client.query(
        `INSERT INTO service_records
           (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show,
            location, description, recorded_at, batch_id, line_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          volunteer.id,
          item.record.service_type,
          item.record.duration_hours,
          item.record.rating,
          pointsEarned,
          isNoShow,
          item.record.location ?? null,
          item.record.description ?? null,
          effectiveTimes.get(item.line),
          batchId,
          item.line,
        ]
      );
      recordIds.push(insertResult.rows[0].id);

      pointsChangeByVolunteer.set(
        volunteer.id,
        (pointsChangeByVolunteer.get(volunteer.id) || 0) + pointsChange
      );
      if (!isNoShow) {
        serviceCountDelta.set(volunteer.id, (serviceCountDelta.get(volunteer.id) || 0) + 1);
      }
      if (!runningPoints.has(volunteer.id)) {
        runningPoints.set(volunteer.id, volunteer.total_points);
      }

      const beforePoints = runningPoints.get(volunteer.id)!;
      const afterPoints = Math.max(0, beforePoints + pointsChange);
      runningPoints.set(volunteer.id, afterPoints);

      await client.query(
        `INSERT INTO points_logs
           (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          volunteer.id,
          pointsChange,
          isNoShow
            ? `批量导入爽约扣分: ${item.record.service_type}（批次 ${batchNo} 第 ${item.line} 行）`
            : `批量导入服务积分: ${item.record.service_type}（批次 ${batchNo} 第 ${item.line} 行）`,
          beforePoints,
          afterPoints,
          insertResult.rows[0].id,
          'service_record_batch',
        ]
      );
    }

    // 志愿者积分、等级、徽章、信用分一次性结算（同一事务）
    const volunteerResults: BatchVolunteerResult[] = [];
    for (const volunteerId of volunteerIds) {
      const volunteer = volunteerMap.get(volunteerId)!;
      const totalPointsChange = pointsChangeByVolunteer.get(volunteerId) || 0;
      const oldTotalPoints = volunteer.total_points;
      const newTotalPoints = Math.max(0, oldTotalPoints + totalPointsChange);
      const oldLevel = volunteer.level;
      const newLevel = calculateLevel(newTotalPoints);

      await client.query(
        `UPDATE volunteers
         SET total_points = $1,
             level = $2,
             service_count = service_count + $3
         WHERE id = $4`,
        [newTotalPoints, newLevel, serviceCountDelta.get(volunteerId) || 0, volunteerId]
      );

      let newBadges: Badge[] = [];
      if (newLevel > oldLevel) {
        const currentBadgesResult = await client.query(
          'SELECT * FROM badges WHERE volunteer_id = $1',
          [volunteerId]
        );
        newBadges = await checkNewBadges(volunteerId, newLevel, currentBadgesResult.rows, client);
      }

      const creditResult = await recalculateCreditScore(volunteerId, client);
      const creditChange = creditResult ? creditResult.changeAmount : 0;
      const creditScore = creditResult ? creditResult.afterScore : volunteer.credit_score;
      if (creditResult && creditChange !== 0) {
        await logCreditChange(
          volunteerId,
          creditChange,
          `批量导入-信用分重算（批次 ${batchNo}）`,
          creditResult.beforeScore,
          creditResult.afterScore,
          batchId,
          'service_record_batch',
          client
        );
      }

      volunteerResults.push({
        volunteer_id: volunteerId,
        pointsChange: totalPointsChange,
        newTotalPoints,
        oldLevel,
        newLevel,
        levelUp: newLevel > oldLevel,
        newBadges,
        creditScore,
        creditChange,
        creditBreakdown: creditResult?.breakdown,
        recordCount: validItems.filter(item => item.record.volunteer_id === volunteerId).length,
      });
    }

    const snapshot: BatchResultSnapshot = {
      batch_id: batchId,
      batch_no: batchNo,
      status: 'completed',
      total: rawRecords.length,
      successCount: rawRecords.length,
      failCount: 0,
      recordIds,
      volunteerResults,
    };

    const completedResult = await client.query(
      `UPDATE service_record_batches
       SET status = 'completed',
           success_count = $1,
           fail_count = 0,
           result_snapshot = $2,
           processed_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [rawRecords.length, JSON.stringify(snapshot), batchId]
    );

    await client.query('COMMIT');

    const completedRow = completedResult.rows[0] as ServiceRecordBatch;
    const data: BatchImportData = {
      ...snapshot,
      replayed: false,
      created_at: completedRow.created_at,
      processed_at: completedRow.processed_at,
    };

    return {
      status: 200,
      body: { success: true, message: messages.batch.completed, data },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.batchImportFailed, error);
    return {
      status: 500,
      body: { success: false, error: messages.batch.importFailed },
    };
  } finally {
    client.release();
  }
};

export const getServiceRecordBatch = async (
  batchNo: string
): Promise<ApiResponse<ServiceRecordBatch>> => {
  const result = await pool.query(
    'SELECT * FROM service_record_batches WHERE batch_no = $1',
    [batchNo]
  );

  if (result.rows.length === 0) {
    return { success: false, error: messages.batch.notFound };
  }

  return { success: true, data: parseBatchRow(result.rows[0]) };
};

export const getServiceRecordBatchDetails = async (
  batchNo: string,
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<BatchDetailsData>> => {
  const batchResult = await pool.query(
    'SELECT * FROM service_record_batches WHERE batch_no = $1',
    [batchNo]
  );

  if (batchResult.rows.length === 0) {
    return { success: false, error: messages.batch.notFound };
  }

  const batch = parseBatchRow(batchResult.rows[0]);
  const offset = (page - 1) * pageSize;

  const countResult = await pool.query(
    'SELECT COUNT(*) AS total FROM service_records WHERE batch_id = $1',
    [batch.id]
  );

  const recordsResult = await pool.query(
    `SELECT * FROM service_records
     WHERE batch_id = $1
     ORDER BY line_no ASC
     LIMIT $2 OFFSET $3`,
    [batch.id, pageSize, offset]
  );

  return {
    success: true,
    data: {
      batch: {
        batch_id: batch.id,
        batch_no: batch.batch_no,
        status: batch.status,
        total_count: batch.total_count,
        success_count: batch.success_count,
        fail_count: batch.fail_count,
        errors: batch.errors || [],
        created_at: batch.created_at,
        processed_at: batch.processed_at,
      },
      records: recordsResult.rows,
      pagination: {
        page,
        page_size: pageSize,
        total: parseInt(countResult.rows[0].total),
        total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
      },
    },
  };
};

export { MAX_BATCH_SIZE };
