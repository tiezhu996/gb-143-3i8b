import * as crypto from 'crypto';
import { PoolClient } from 'pg';
import pool from '../db/pool';
import {
  ApiResponse,
  BatchImport,
  BatchImportErrorRow,
  BatchImportItem,
  BatchImportResultData,
  BatchRowErrorCode,
  BatchServiceRecordItem,
  Volunteer,
} from '../types';
import { calculatePoints, calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel } from './badgeService';
import { BADGE_NAMES, BADGE_DESCRIPTIONS } from '../types';
import { recalculateCreditScore, logCreditChange } from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

const FUTURE_TIME_TOLERANCE_MS = 60 * 1000;

const ERROR_CODE_MESSAGES: Record<BatchRowErrorCode, string> = {
  VOLUNTEER_NOT_FOUND: messages.batch.volunteerNotFound,
  VOLUNTEER_INACTIVE: messages.batch.volunteerInactive,
  FUTURE_RECORDED_AT: messages.batch.futureRecordedAt,
  DUPLICATE_RECORD: messages.batch.duplicateRecord,
};

export interface BatchSubmitInput {
  batch_no: string;
  records: BatchServiceRecordItem[];
  operator_id: string;
}

interface NormalizedRecord extends BatchServiceRecordItem {
  line_number: number;
  duration_key: string;
  time_key: string;
  location_key: string;
}

interface VolunteerBatchOutcome {
  volunteer_id: string;
  points_change: number;
  total_points: number;
  level: number;
  level_up: boolean;
  new_badges: { star_level: number; badge_name: string }[];
  service_count_increment: number;
  credit_score?: number;
  credit_change?: number;
}

const normalizeRecord = (raw: BatchServiceRecordItem, lineNumber: number): NormalizedRecord => {
  const recordedAt = new Date(Math.floor(new Date(raw.recorded_at).getTime() / 1000) * 1000);
  const durationHours = Math.round(raw.duration_hours * 100) / 100;
  const location = raw.location !== undefined ? String(raw.location).trim() : '';

  return {
    line_number: lineNumber,
    volunteer_id: raw.volunteer_id,
    service_type: raw.service_type,
    duration_hours: durationHours,
    rating: raw.rating,
    is_no_show: raw.is_no_show,
    location: location || undefined,
    description: raw.description,
    recorded_at: recordedAt,
    duration_key: durationHours.toFixed(2),
    time_key: recordedAt.toISOString(),
    location_key: location,
  };
};

const dedupKey = (r: {
  volunteer_id: string;
  time_key: string;
  service_type: string;
  duration_key: string;
  location_key: string;
}): string =>
  `${r.volunteer_id}|${r.time_key}|${r.service_type}|${r.duration_key}|${r.location_key}`;

export const hashBatchPayload = (batchNo: string, records: BatchServiceRecordItem[]): string => {
  const canonical = JSON.stringify({
    batch_no: batchNo,
    records: records.map((raw, index) => {
      const r = normalizeRecord(raw, index + 1);
      return {
        volunteer_id: r.volunteer_id,
        service_type: r.service_type,
        duration_hours: r.duration_hours,
        rating: r.rating,
        is_no_show: r.is_no_show,
        location: r.location_key,
        description: r.description ?? null,
        recorded_at: r.time_key,
      };
    }),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const advisoryLockKeys = (batchNo: string): [number, number] => {
  const digest = crypto.createHash('sha256').update(batchNo).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
};

const buildErrorRow = (
  lineNumber: number,
  volunteerId: string | undefined,
  codes: BatchRowErrorCode[],
  duplicateOfLine?: number
): BatchImportErrorRow => ({
  line_number: lineNumber,
  volunteer_id: volunteerId,
  error_codes: codes,
  messages: codes.map(code => ERROR_CODE_MESSAGES[code]),
  ...(duplicateOfLine !== undefined ? { duplicate_of_line: duplicateOfLine } : {}),
});

/**
 * 整批审查：志愿者存在且启用、记录时间不在未来、
 * 批内/库内不存在同志愿者同时间同类型同时长同地点的记录。
 * 返回全部问题行，不做任何写入。
 */
const reviewBatch = async (
  client: PoolClient,
  records: NormalizedRecord[]
): Promise<{ errorRows: BatchImportErrorRow[] }> => {
  const errorMap = new Map<number, { codes: Set<BatchRowErrorCode>; duplicateOfLine?: number }>();
  const addError = (lineNumber: number, code: BatchRowErrorCode, duplicateOfLine?: number) => {
    const entry = errorMap.get(lineNumber) || { codes: new Set<BatchRowErrorCode>() };
    entry.codes.add(code);
    if (duplicateOfLine !== undefined) {
      entry.duplicateOfLine = duplicateOfLine;
    }
    errorMap.set(lineNumber, entry);
  };

  const volunteerIds = [...new Set(records.map(r => r.volunteer_id))];
  const minTime = new Date(Math.min(...records.map(r => r.recorded_at.getTime())));
  const maxTime = new Date(Math.max(...records.map(r => r.recorded_at.getTime())) + 1000);

  const volunteerResult = await client.query(
    'SELECT id, is_active FROM volunteers WHERE id = ANY($1::uuid[])',
    [volunteerIds]
  );
  const volunteerMap = new Map<string, Volunteer>(
    volunteerResult.rows.map((row: Volunteer) => [row.id, row])
  );

  // 用时间窗口查询（库内历史记录可能带毫秒），再以归一化到秒的键精确比对
  const existingResult = await client.query(
    `SELECT volunteer_id,
            recorded_at,
            service_type,
            duration_hours,
            COALESCE(location, '') AS location
     FROM service_records
     WHERE volunteer_id = ANY($1::uuid[])
       AND recorded_at >= $2
       AND recorded_at <= $3`,
    [volunteerIds, minTime, maxTime]
  );

  const existingKeys = new Set(
    existingResult.rows.map((row: any) =>
      dedupKey({
        volunteer_id: row.volunteer_id,
        time_key: new Date(Math.floor(new Date(row.recorded_at).getTime() / 1000) * 1000).toISOString(),
        service_type: row.service_type,
        duration_key: Number(row.duration_hours).toFixed(2),
        location_key: row.location,
      })
    )
  );

  const now = Date.now();
  const intraBatchKeys = new Map<string, number>();

  for (const record of records) {
    const volunteer = volunteerMap.get(record.volunteer_id);
    if (!volunteer) {
      addError(record.line_number, 'VOLUNTEER_NOT_FOUND');
    } else if (!volunteer.is_active) {
      addError(record.line_number, 'VOLUNTEER_INACTIVE');
    }

    if (record.recorded_at.getTime() > now + FUTURE_TIME_TOLERANCE_MS) {
      addError(record.line_number, 'FUTURE_RECORDED_AT');
    }

    const key = dedupKey(record);
    const firstLine = intraBatchKeys.get(key);
    if (firstLine !== undefined) {
      addError(record.line_number, 'DUPLICATE_RECORD', firstLine);
    } else {
      intraBatchKeys.set(key, record.line_number);
      if (existingKeys.has(key)) {
        addError(record.line_number, 'DUPLICATE_RECORD');
      }
    }
  }

  const errorRows = [...errorMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lineNumber, entry]) => {
      const record = records.find(r => r.line_number === lineNumber);
      return buildErrorRow(
        lineNumber,
        record?.volunteer_id,
        [...entry.codes],
        entry.duplicateOfLine
      );
    });

  return { errorRows };
};

const persistRejectedItems = async (
  client: PoolClient,
  batchId: string,
  records: NormalizedRecord[],
  errorRows: BatchImportErrorRow[]
): Promise<void> => {
  const errorByLine = new Map(errorRows.map(row => [row.line_number, row]));

  for (const record of records) {
    const errorRow = errorByLine.get(record.line_number);
    await client.query(
      `INSERT INTO batch_import_items
         (batch_id, line_number, service_record_id, volunteer_id, service_type,
          duration_hours, rating, is_no_show, location, description, recorded_at,
          points_earned, status, error_codes)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, NULL, 'rejected', $11)`,
      [
        batchId,
        record.line_number,
        record.volunteer_id,
        record.service_type,
        record.duration_hours,
        record.rating,
        record.is_no_show,
        record.location ?? null,
        record.description ?? null,
        record.recorded_at,
        JSON.stringify(errorRow?.error_codes ?? ['DUPLICATE_RECORD']),
      ]
    );
  }

  await client.query(
    `UPDATE batch_imports
     SET status = 'rejected',
         rejected_count = $1,
         error_summary = $2,
         processed_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [errorRows.length, JSON.stringify(errorRows), batchId]
  );
};

interface AcceptedRecordRow {
  record: NormalizedRecord;
  serviceRecordId: string;
  pointsEarned: number;
  pointsChange: number;
}

const insertAcceptedRecords = async (
  client: PoolClient,
  batchNo: string,
  records: NormalizedRecord[]
): Promise<AcceptedRecordRow[]> => {
  const accepted: AcceptedRecordRow[] = [];

  for (const record of records) {
    const pointsEarned = record.is_no_show ? 0 : calculatePoints(
      record.duration_hours,
      record.service_type,
      record.rating
    );
    const pointsChange = record.is_no_show ? -calculateNoShowPenalty() : pointsEarned;

    // NOT EXISTS 守卫：与其他并发批次冲突时不触发唯一索引异常，事务仍可继续
    const insertResult = await client.query(
      `INSERT INTO service_records
         (volunteer_id, service_type, duration_hours, rating, points_earned,
          is_no_show, location, description, batch_no, recorded_at)
       SELECT $1::uuid, $2::varchar, $3::numeric, $4::int, $5::int,
              $6::boolean, $7::varchar, $8::text, $9::varchar, $10::timestamp
       WHERE NOT EXISTS (
         SELECT 1 FROM service_records s
         WHERE s.volunteer_id = $1::uuid
           AND date_trunc('second', s.recorded_at) = date_trunc('second', $10::timestamp)
           AND s.service_type = $2::varchar
           AND s.duration_hours = $3::numeric
           AND COALESCE(s.location, '') = COALESCE($7::varchar, '')
       )
       RETURNING id`,
      [
        record.volunteer_id,
        record.service_type,
        record.duration_hours,
        record.rating,
        pointsEarned,
        record.is_no_show,
        record.location ?? null,
        record.description ?? null,
        batchNo,
        record.recorded_at,
      ]
    );

    if (insertResult.rowCount === 0) {
      throw new ConcurrentDuplicateError(record.line_number);
    }

    accepted.push({
      record,
      serviceRecordId: insertResult.rows[0].id,
      pointsEarned,
      pointsChange,
    });
  }

  return accepted;
};

class ConcurrentDuplicateError extends Error {
  constructor(public lineNumber: number) {
    super('concurrent duplicate service record');
    this.name = 'ConcurrentDuplicateError';
  }
}

/**
 * 全部合格后统一入账：记录、积分、等级、徽章在同一事务内写入；
 * 信用分在提交后按志愿者重算（与单条录入规则一致）。
 */
const commitAcceptedBatch = async (
  client: PoolClient,
  batchId: string,
  batchNo: string,
  records: NormalizedRecord[]
): Promise<{ accepted: AcceptedRecordRow[]; outcomes: Map<string, VolunteerBatchOutcome> }> => {
  const accepted = await insertAcceptedRecords(client, batchNo, records);

  const volunteerIds = [...new Set(records.map(r => r.volunteer_id))];
  const volunteerResult = await client.query(
    'SELECT * FROM volunteers WHERE id = ANY($1::uuid[]) FOR UPDATE',
    [volunteerIds]
  );
  const volunteerMap = new Map<string, Volunteer>(
    volunteerResult.rows.map((row: Volunteer) => [row.id, row])
  );

  const outcomes = new Map<string, VolunteerBatchOutcome>();
  const pointsChangeById = new Map<string, number>();
  const serviceCountIncrementById = new Map<string, number>();

  for (const row of accepted) {
    pointsChangeById.set(
      row.record.volunteer_id,
      (pointsChangeById.get(row.record.volunteer_id) ?? 0) + row.pointsChange
    );
    if (!row.record.is_no_show) {
      serviceCountIncrementById.set(
        row.record.volunteer_id,
        (serviceCountIncrementById.get(row.record.volunteer_id) ?? 0) + 1
      );
    }
  }

  for (const [volunteerId, pointsChange] of pointsChangeById) {
    const volunteer = volunteerMap.get(volunteerId)!;
    const oldTotalPoints = volunteer.total_points;
    const oldLevel = volunteer.level;
    const newTotalPoints = Math.max(0, oldTotalPoints + pointsChange);
    const newLevel = calculateLevel(newTotalPoints);
    const serviceCountIncrement = serviceCountIncrementById.get(volunteerId) ?? 0;

    await client.query(
      `UPDATE volunteers
       SET total_points = $1,
           level = $2,
           service_count = service_count + $3
       WHERE id = $4`,
      [newTotalPoints, newLevel, serviceCountIncrement, volunteerId]
    );

    const newBadges: { star_level: number; badge_name: string }[] = [];
    if (newLevel > oldLevel) {
      const badgeResult = await client.query(
        'SELECT star_level FROM badges WHERE volunteer_id = $1',
        [volunteerId]
      );
      const ownedLevels = new Set<number>(badgeResult.rows.map((b: any) => b.star_level));
      for (let level = 2; level <= newLevel; level++) {
        if (!ownedLevels.has(level)) {
          await client.query(
            `INSERT INTO badges (volunteer_id, star_level, badge_name, description)
             VALUES ($1, $2, $3, $4)`,
            [volunteerId, level, BADGE_NAMES[level], BADGE_DESCRIPTIONS[level]]
          );
          newBadges.push({ star_level: level, badge_name: BADGE_NAMES[level] });
        }
      }
    }

    outcomes.set(volunteerId, {
      volunteer_id: volunteerId,
      points_change: pointsChange,
      total_points: newTotalPoints,
      level: newLevel,
      level_up: newLevel > oldLevel,
      new_badges: newBadges,
      service_count_increment: serviceCountIncrement,
    });
  }

  for (const row of accepted) {
    const volunteer = volunteerMap.get(row.record.volunteer_id)!;
    const beforePoints = volunteer.total_points;
    const afterPoints = Math.max(0, beforePoints + row.pointsChange);
    volunteer.total_points = afterPoints;

    await client.query(
      `INSERT INTO points_logs
         (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'service_record')`,
      [
        row.record.volunteer_id,
        row.pointsChange,
        row.record.is_no_show
          ? `批次爽约扣分: ${batchNo}`
          : `批次服务积分[${batchNo}]: ${row.record.service_type}`,
        beforePoints,
        afterPoints,
        row.serviceRecordId,
      ]
    );
  }

  for (const row of accepted) {
    await client.query(
      `INSERT INTO batch_import_items
         (batch_id, line_number, service_record_id, volunteer_id, service_type,
          duration_hours, rating, is_no_show, location, description, recorded_at,
          points_earned, status, error_codes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'accepted', NULL)`,
      [
        batchId,
        row.record.line_number,
        row.serviceRecordId,
        row.record.volunteer_id,
        row.record.service_type,
        row.record.duration_hours,
        row.record.rating,
        row.record.is_no_show,
        row.record.location ?? null,
        row.record.description ?? null,
        row.record.recorded_at,
        row.pointsEarned,
      ]
    );
  }

  return { accepted, outcomes };
};

const mapItemRow = (row: any): BatchImportItem => ({
  id: row.id,
  batch_id: row.batch_id,
  batch_no: row.batch_no,
  line_number: row.line_number,
  service_record_id: row.service_record_id,
  volunteer_id: row.volunteer_id,
  service_type: row.service_type,
  duration_hours: Number(row.duration_hours),
  rating: row.rating,
  is_no_show: row.is_no_show,
  location: row.location,
  description: row.description,
  recorded_at: row.recorded_at,
  points_earned: row.points_earned,
  status: row.status,
  error_codes: row.error_codes,
  created_at: row.created_at,
});

const buildResultData = (
  batch: BatchImport,
  items: BatchImportItem[],
  idempotent: boolean
): BatchImportResultData => {
  const errorRows: BatchImportErrorRow[] =
    batch.status === 'rejected' && batch.error_summary
      ? (batch.error_summary as unknown as BatchImportErrorRow[])
      : [];

  return {
    batch_no: batch.batch_no,
    status: batch.status,
    total_count: batch.total_count,
    success_count: batch.success_count,
    rejected_count: batch.rejected_count,
    idempotent,
    error_lines: errorRows.map(row => row.line_number),
    error_rows: errorRows,
    volunteers:
      batch.result_summary && (batch.result_summary as any).volunteers
        ? (batch.result_summary as any).volunteers
        : [],
    items,
  };
};

const getStoredBatchResult = async (
  batch: BatchImport
): Promise<BatchImportResultData> => {
  const itemsResult = await pool.query(
    `SELECT i.*, b.batch_no
     FROM batch_import_items i
     JOIN batch_imports b ON b.id = i.batch_id
     WHERE b.id = $1
     ORDER BY i.line_number ASC`,
    [batch.id]
  );
  return buildResultData(batch, itemsResult.rows.map(mapItemRow), false);
};

type TransactionOutcome =
  | { kind: 'accepted'; batchNo: string; outcomes: Map<string, VolunteerBatchOutcome> }
  | { kind: 'rejected'; batchNo: string }
  | { kind: 'existing'; response: ApiResponse<BatchImportResultData> };

/**
 * 批次导入入口：整批审查 → 全部合格才统一入账。
 * 同一批次号并发提交只会生成一套结果（事务级咨询锁 + batch_no 唯一约束）。
 */
export const submitBatchImport = async (
  input: BatchSubmitInput
): Promise<ApiResponse<BatchImportResultData>> => {
  const records = input.records.map((raw, index) => normalizeRecord(raw, index + 1));
  const payloadHash = hashBatchPayload(input.batch_no, input.records);
  const [lockKey1, lockKey2] = advisoryLockKeys(input.batch_no);

  const client = await pool.connect();
  let outcome: TransactionOutcome;

  try {
    await client.query('BEGIN');
    // 同批次号的并发提交在此串行化，保证只生成一套结果
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [lockKey1, lockKey2]);

    const existingResult = await client.query(
      'SELECT * FROM batch_imports WHERE batch_no = $1',
      [input.batch_no]
    );

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0] as BatchImport;

      if (existing.status === 'processing') {
        await client.query('COMMIT');
        outcome = {
          kind: 'existing',
          response: {
            success: false,
            statusCode: 409,
            error: messages.batch.inProgress,
            data: buildResultData(existing, [], true),
          },
        };
      } else if (existing.request_payload_hash && existing.request_payload_hash !== payloadHash) {
        await client.query('COMMIT');
        outcome = {
          kind: 'existing',
          response: {
            success: false,
            statusCode: 409,
            error: messages.batch.batchNoConflict,
          },
        };
      } else {
        await client.query('COMMIT');
        const data = await readBatchResultWithPool(existing);
        outcome = {
          kind: 'existing',
          response: {
            success: existing.status === 'completed',
            statusCode: existing.status === 'completed' ? 200 : 400,
            error: existing.status === 'completed' ? undefined : messages.batch.reviewFailed,
            data,
          },
        };
      }
    } else {
      const batchInsert = await client.query(
        `INSERT INTO batch_imports (batch_no, status, total_count, request_payload_hash, created_by)
         VALUES ($1, 'processing', $2, $3, $4)
         RETURNING *`,
        [input.batch_no, records.length, payloadHash, input.operator_id]
      );
      const batch = batchInsert.rows[0] as BatchImport;

      // 第一阶段：整批审查
      const { errorRows } = await reviewBatch(client, records);

      if (errorRows.length > 0) {
        // 审查不通过：仅留存批次结果与明细，记录/积分/等级/徽章/信用一律不写
        await persistRejectedItems(client, batch.id, records, errorRows);
        await client.query('COMMIT');
        outcome = { kind: 'rejected', batchNo: input.batch_no };
      } else {
        // 第二阶段：全部合格，统一入账
        let volunteerOutcomes: Map<string, VolunteerBatchOutcome>;
        try {
          const commitResult = await commitAcceptedBatch(client, batch.id, input.batch_no, records);
          volunteerOutcomes = commitResult.outcomes;
        } catch (error) {
          if (error instanceof ConcurrentDuplicateError) {
            // 与其他并发批次产生重复：回滚，随后重新审查并按整批拒绝落存
            await client.query('ROLLBACK');
            client.release();
            return rejectBatchAfterConflict(
              input.batch_no,
              payloadHash,
              records,
              input.operator_id
            );
          }
          throw error;
        }

        await client.query(
          `UPDATE batch_imports
           SET status = 'completed',
               success_count = $1,
               rejected_count = 0,
               result_summary = $2,
               processed_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [records.length, JSON.stringify({ volunteers: [...volunteerOutcomes.values()] }), batch.id]
        );

        await client.query('COMMIT');
        outcome = { kind: 'accepted', batchNo: input.batch_no, outcomes: volunteerOutcomes };
      }
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    logger.error(messages.logs.batchImportFailed, error);
    return { success: false, statusCode: 500, error: messages.batch.importFailed };
  }

  client.release();

  // 事务提交后的操作全部使用池连接，与入账事务隔离
  if (outcome.kind === 'existing') {
    return outcome.response;
  }

  if (outcome.kind === 'rejected') {
    const batch = await getBatchImportByNo(outcome.batchNo);
    const data = batch ? await getStoredBatchResult(batch) : undefined;
    return {
      success: false,
      statusCode: 400,
      error: messages.batch.reviewFailed,
      data,
    };
  }

  // 提交成功后重算信用分并记录信用流水（失败不影响已入账结果）
  await recalculateCreditsAfterCommit(outcome.batchNo, outcome.outcomes);

  const batch = await getBatchImportByNo(outcome.batchNo);
  const data = batch ? await getStoredBatchResult(batch) : undefined;
  return {
    success: true,
    statusCode: 201,
    data,
  };
};

const getBatchImportByNo = async (batchNo: string): Promise<BatchImport | null> => {
  const result = await pool.query('SELECT * FROM batch_imports WHERE batch_no = $1', [batchNo]);
  return result.rows.length > 0 ? (result.rows[0] as BatchImport) : null;
};

// 同批次号幂等回读使用独立连接（前一事务已提交并释放）
const readBatchResultWithPool = async (batch: BatchImport): Promise<BatchImportResultData> => {
  const result = await pool.query(
    `SELECT i.*, b.batch_no
     FROM batch_import_items i
     JOIN batch_imports b ON b.id = i.batch_id
     WHERE b.id = $1
     ORDER BY i.line_number ASC`,
    [batch.id]
  );
  return buildResultData(batch, result.rows.map(mapItemRow), true);
};

const getBatchImportEntity = async (
  client: PoolClient,
  batchNo: string
): Promise<BatchImport | null> => {
  const result = await client.query('SELECT * FROM batch_imports WHERE batch_no = $1', [batchNo]);
  return result.rows.length > 0 ? (result.rows[0] as BatchImport) : null;
};

const rejectBatchAfterConflict = async (
  batchNo: string,
  payloadHash: string,
  records: NormalizedRecord[],
  operatorId: string
): Promise<ApiResponse<BatchImportResultData>> => {
  const client = await pool.connect();
  let rejectedBatch: BatchImport | null = null;
  let existingResponse: ApiResponse<BatchImportResultData> | null = null;

  try {
    await client.query('BEGIN');

    const existing = await getBatchImportEntity(client, batchNo);
    if (existing) {
      await client.query('COMMIT');
      const data = await readBatchResultWithPool(existing);
      existingResponse = {
        success: existing.status === 'completed',
        statusCode: existing.status === 'completed' ? 200 : 400,
        error: existing.status === 'completed' ? undefined : messages.batch.reviewFailed,
        data,
      };
    } else {
      const batchInsert = await client.query(
        `INSERT INTO batch_imports (batch_no, status, total_count, request_payload_hash, created_by)
         VALUES ($1, 'rejected', $2, $3, $4)
         RETURNING *`,
        [batchNo, records.length, payloadHash, operatorId]
      );
      const batch = batchInsert.rows[0] as BatchImport;

      const { errorRows } = await reviewBatch(client, records);
      const rowsToStore =
        errorRows.length > 0
          ? errorRows
          : records.map(r => buildErrorRow(r.line_number, r.volunteer_id, ['DUPLICATE_RECORD']));

      await persistRejectedItems(client, batch.id, records, rowsToStore);
      await client.query('COMMIT');
      rejectedBatch = batch;
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    logger.error(messages.logs.batchImportFailed, error);
    return { success: false, statusCode: 500, error: messages.batch.importFailed };
  }

  client.release();

  if (existingResponse) {
    return existingResponse;
  }

  const data = rejectedBatch ? await getStoredBatchResult(rejectedBatch) : undefined;
  return {
    success: false,
    statusCode: 400,
    error: messages.batch.reviewFailed,
    data,
  };
};

const recalculateCreditsAfterCommit = async (
  batchNo: string,
  outcomes: Map<string, VolunteerBatchOutcome>
): Promise<void> => {
  for (const [volunteerId, outcome] of outcomes) {
    try {
      const creditResult = await recalculateCreditScore(volunteerId);
      if (creditResult) {
        outcome.credit_score = creditResult.afterScore;
        outcome.credit_change = creditResult.changeAmount;
        if (creditResult.changeAmount !== 0) {
          await logCreditChange(
            volunteerId,
            creditResult.changeAmount,
            `批次导入-信用分重算: ${batchNo}`,
            creditResult.beforeScore,
            creditResult.afterScore,
            undefined,
            'batch_import'
          );
        }
      }
    } catch (error) {
      logger.error(`批次 ${batchNo} 志愿者 ${volunteerId} 信用分重算失败`, error);
    }
  }

  // 回写批次汇总，使回读/幂等重放可获得最终信用结果
  try {
    await pool.query(
      `UPDATE batch_imports SET result_summary = $1 WHERE batch_no = $2`,
      [JSON.stringify({ volunteers: [...outcomes.values()] }), batchNo]
    );
  } catch (error) {
    logger.error(`批次 ${batchNo} 结果汇总回写失败`, error);
  }
};

export const getBatchImportResult = async (
  batchNo: string
): Promise<ApiResponse<BatchImportResultData>> => {
  try {
    const result = await pool.query('SELECT * FROM batch_imports WHERE batch_no = $1', [batchNo]);
    if (result.rows.length === 0) {
      return { success: false, statusCode: 404, error: messages.batch.notFound };
    }
    const batch = result.rows[0] as BatchImport;
    const data = await readBatchResultWithPool(batch);
    return {
      success: true,
      data,
    };
  } catch (error) {
    logger.error(messages.logs.batchImportFailed, error);
    return { success: false, statusCode: 500, error: messages.batch.importFailed };
  }
};

export const listBatchImportItems = async (
  batchNo: string,
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<any>> => {
  try {
    const batchResult = await pool.query(
      'SELECT * FROM batch_imports WHERE batch_no = $1',
      [batchNo]
    );
    if (batchResult.rows.length === 0) {
      return { success: false, statusCode: 404, error: messages.batch.notFound };
    }
    const batch = batchResult.rows[0] as BatchImport;
    const offset = (page - 1) * pageSize;

    const itemsResult = await pool.query(
      `SELECT i.*, b.batch_no
       FROM batch_import_items i
       JOIN batch_imports b ON b.id = i.batch_id
       WHERE b.id = $1
       ORDER BY i.line_number ASC
       LIMIT $2 OFFSET $3`,
      [batch.id, pageSize, offset]
    );

    return {
      success: true,
      data: {
        batch_no: batch.batch_no,
        status: batch.status,
        items: itemsResult.rows.map(mapItemRow),
        pagination: {
          page,
          page_size: pageSize,
          total: batch.total_count,
          total_pages: Math.ceil(batch.total_count / pageSize),
        },
      },
    };
  } catch (error) {
    logger.error(messages.logs.batchImportFailed, error);
    return { success: false, statusCode: 500, error: messages.batch.importFailed };
  }
};
