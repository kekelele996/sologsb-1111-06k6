import type { DrillRun } from '../types/drill-run';
import type { LithoLog } from '../types/litho-log';
import type { SurveyPoint } from '../types/drill-hole';
import type { ReconSegment, ReconSession } from '../types/reconcile';
import { tvdRangeOf } from './survey';

/** 对账容差（m）：两侧覆盖缺口小于该值按换算残差处理，不算对不上 */
export const RECON_TOLERANCE_M = 0.2;

/** cm 精度下的判零阈值 */
const EPS = 0.005;

interface Interval {
  id: string;
  from: number;
  to: number;
}

/** 重算得到的对账段（尚未与历史段合并） */
export type FreshSegment = Pick<ReconSegment, 'signature' | 'fromTvd' | 'toTvd' | 'status' | 'residual' | 'runIds' | 'lithoIds' | 'note'>;

/** [from, to] 被区间组覆盖的长度（并集口径） */
function coveredLength(from: number, to: number, intervals: Interval[]): number {
  const clipped = intervals
    .map((iv) => ({ from: Math.max(iv.from, from), to: Math.min(iv.to, to) }))
    .filter((iv) => iv.to - iv.from > EPS)
    .sort((a, b) => a.from - b.from);
  let covered = 0;
  let cursor = from;
  for (const seg of clipped) {
    const start = Math.max(seg.from, cursor);
    if (seg.to > start) {
      covered += seg.to - start;
      cursor = seg.to;
    }
  }
  return covered;
}

function overlappingIds(from: number, to: number, intervals: Interval[]): string[] {
  return intervals.filter((iv) => Math.min(iv.to, to) - Math.max(iv.from, from) > EPS).map((iv) => iv.id);
}

/** 单个垂深段的比对分类：看两侧各自覆盖了多少，缺口与容差比较 */
export function classifyRange(
  fromTvd: number,
  toTvd: number,
  runIntervals: Interval[],
  lithoIntervals: Interval[],
  tolerance: number,
): Pick<FreshSegment, 'status' | 'residual' | 'runIds' | 'lithoIds' | 'note'> {
  const length = toTvd - fromTvd;
  const runIds = overlappingIds(fromTvd, toTvd, runIntervals);
  const lithoIds = overlappingIds(fromTvd, toTvd, lithoIntervals);
  const gapRun = length - coveredLength(fromTvd, toTvd, runIntervals);
  const gapLitho = length - coveredLength(fromTvd, toTvd, lithoIntervals);

  if (gapRun <= tolerance && gapLitho <= tolerance) {
    return { status: 'matched', residual: gapRun > EPS || gapLitho > EPS, runIds, lithoIds };
  }
  if (gapLitho > tolerance && gapRun <= tolerance) {
    return { status: 'missingLitho', runIds, lithoIds };
  }
  if (gapRun > tolerance && gapLitho <= tolerance) {
    return { status: 'missingRun', runIds, lithoIds };
  }
  return { status: 'pending', runIds, lithoIds, note: '两侧记录在该段均有缺口，待班组长裁定' };
}

/**
 * 切分对账段：回次孔深按测斜换算垂深后，与岩性区间（垂深）的边界取并集切段，
 * 相邻同状态的段合并，段签名按垂深区间生成。
 */
export function buildSegments(runs: DrillRun[], lithos: LithoLog[], survey: SurveyPoint[], tolerance: number): FreshSegment[] {
  const runIntervals: Interval[] = runs.map((run) => {
    const { fromTvd, toTvd } = tvdRangeOf(run.fromDepth, run.toDepth, survey);
    return { id: run.id, from: fromTvd, to: toTvd };
  });
  const lithoIntervals: Interval[] = lithos.map((log) => ({ id: log.id, from: log.fromDepth, to: log.toDepth }));

  const boundaries = [...new Set([...runIntervals, ...lithoIntervals].flatMap((iv) => [iv.from, iv.to]))].sort((a, b) => a - b);
  const elementary: FreshSegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const fromTvd = boundaries[i];
    const toTvd = boundaries[i + 1];
    if (toTvd - fromTvd <= EPS) continue;
    elementary.push({
      signature: `${fromTvd.toFixed(2)}~${toTvd.toFixed(2)}`,
      fromTvd,
      toTvd,
      ...classifyRange(fromTvd, toTvd, runIntervals, lithoIntervals, tolerance),
    });
  }

  // 相邻同状态的段合并，减少碎段；残差标记从严（任一段有残差即标记）
  const merged: FreshSegment[] = [];
  for (const seg of elementary) {
    const last = merged[merged.length - 1];
    if (last && last.status === seg.status && !last.note && !seg.note) {
      last.toTvd = seg.toTvd;
      last.signature = `${last.fromTvd.toFixed(2)}~${seg.toTvd.toFixed(2)}`;
      last.residual = Boolean(last.residual || seg.residual);
      last.runIds = [...new Set([...last.runIds, ...seg.runIds])];
      last.lithoIds = [...new Set([...last.lithoIds, ...seg.lithoIds])];
    } else {
      merged.push({ ...seg, runIds: [...seg.runIds], lithoIds: [...seg.lithoIds] });
    }
  }
  return merged;
}

/**
 * 与历史段合并（对账失败后重跑/按段重试共用）：
 * - 已裁定：人工结论随签名保留；
 * - 挂起：重算已对上则落为已对上，仍对不上则维持挂起，不拖住其他段；
 * - 已比好（已对上）的段：数据未变时重算结果不变，自然留住；数据变了以重算为准。
 */
export function mergeWithStored(fresh: FreshSegment[], stored: ReconSegment[], now: string): Array<Omit<ReconSegment, 'id' | 'holeId'> & { id?: string }> {
  const bySignature = new Map(stored.map((seg) => [seg.signature, seg]));
  return fresh.map((seg) => {
    const prev = bySignature.get(seg.signature);
    if (!prev) {
      return { ...seg, updatedAt: now };
    }
    if (prev.status === 'resolved') {
      return {
        ...seg,
        id: prev.id,
        status: 'resolved',
        verdict: prev.verdict,
        verdictBy: prev.verdictBy,
        verdictAt: prev.verdictAt,
        note: prev.note,
        updatedAt: prev.updatedAt,
      };
    }
    if (prev.status === 'pending' && seg.status !== 'matched') {
      return { ...seg, id: prev.id, status: 'pending', note: prev.note ?? seg.note, updatedAt: prev.updatedAt };
    }
    return { ...seg, id: prev.id, updatedAt: prev.status === seg.status ? prev.updatedAt : now };
  });
}

/** 批次统计 */
export function summarizeSegments(segments: Array<Pick<ReconSegment, 'status'>>): Omit<ReconSession, 'id' | 'holeId' | 'createdAt' | 'operator' | 'tolerance' | 'result'> {
  return {
    total: segments.length,
    matched: segments.filter((s) => s.status === 'matched').length,
    missingLitho: segments.filter((s) => s.status === 'missingLitho').length,
    missingRun: segments.filter((s) => s.status === 'missingRun').length,
    pending: segments.filter((s) => s.status === 'pending').length,
    resolved: segments.filter((s) => s.status === 'resolved').length,
  };
}
