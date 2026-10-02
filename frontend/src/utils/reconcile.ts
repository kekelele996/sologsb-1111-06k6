import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { LithoLog } from '../types/litho-log';
import type { MatchType, ReconcileRecord, ReconcileStatus, SectionMatch } from '../types/reconcile';
import { holeToVertical } from './depth';
import { uid } from './id';

/** 匹配容差（m）：边界偏差小于此值视为精确匹配 */
const MATCH_TOLERANCE = 0.5;

interface RunV {
  runId: string;
  runNo: string;
  fromHole: number;
  toHole: number;
  fromV: number;
  toV: number;
}

interface LithoV {
  lithoId: string;
  lithology: string;
  fromV: number;
  toV: number;
}

/** 两个垂深区间是否重叠（端点相接不算重叠） */
function overlaps(a: { fromV: number; toV: number }, b: { fromV: number; toV: number }): boolean {
  return Math.min(a.toV, b.toV) - Math.max(a.fromV, b.fromV) > 0.0001;
}

/** 边界是否对齐（精确匹配）：起止垂深偏差均在容差内 */
function boundariesAlign(run: RunV, litho: LithoV): boolean {
  return (
    Math.abs(run.fromV - litho.fromV) <= MATCH_TOLERANCE &&
    Math.abs(run.toV - litho.toV) <= MATCH_TOLERANCE
  );
}

/**
 * 对账：把回次（孔深）按测斜换算成垂深后，与岩性区间（垂深）比段。
 *
 * 换算值只用于对照，现场孔深（fromHole/toHole）始终保留不动。
 * 对不上的段（overlap / extra-run / extra-litho）原样摆出，等组长定，不拖住别的段。
 */
export function reconcileHole(
  hole: DrillHole,
  runs: DrillRun[],
  lithos: LithoLog[],
): { sections: SectionMatch[]; status: ReconcileStatus } {
  const holeRuns = runs.filter((r) => r.holeId === hole.id);
  const holeLithos = lithos.filter((l) => l.holeId === hole.id);

  const runVs: RunV[] = holeRuns.map((run) => ({
    runId: run.id,
    runNo: run.runNo,
    fromHole: run.fromDepth,
    toHole: run.toDepth,
    fromV: holeToVertical(hole.surveyData, run.fromDepth),
    toV: holeToVertical(hole.surveyData, run.toDepth),
  }));

  const lithoVs: LithoV[] = holeLithos.map((log) => ({
    lithoId: log.id,
    lithology: log.lithology,
    fromV: log.fromDepth,
    toV: log.toDepth,
  }));

  const sections: SectionMatch[] = [];
  const matchedLithoIds = new Set<string>();

  // 处理回次：与岩性区间比段
  for (const run of runVs) {
    const overlappingLithos = lithoVs.filter((l) => overlaps(run, l));
    if (overlappingLithos.length === 0) {
      sections.push({
        id: uid('sec'),
        runId: run.runId,
        runNo: run.runNo,
        runFromHole: run.fromHole,
        runToHole: run.toHole,
        runFromV: run.fromV,
        runToV: run.toV,
        matchType: 'extra-run',
        note: '无对应岩性区间',
      });
    } else {
      for (const litho of overlappingLithos) {
        const isExact = boundariesAlign(run, litho);
        sections.push({
          id: uid('sec'),
          runId: run.runId,
          lithoId: litho.lithoId,
          runNo: run.runNo,
          lithology: litho.lithology,
          runFromHole: run.fromHole,
          runToHole: run.toHole,
          runFromV: run.fromV,
          runToV: run.toV,
          lithoFromV: litho.fromV,
          lithoToV: litho.toV,
          matchType: isExact ? 'exact' : 'overlap',
          note: isExact ? undefined : '边界未对齐，部分重叠',
        });
        matchedLithoIds.add(litho.lithoId);
      }
    }
  }

  // 处理未匹配的岩性区间
  for (const litho of lithoVs) {
    if (matchedLithoIds.has(litho.lithoId)) continue;
    sections.push({
      id: uid('sec'),
      lithoId: litho.lithoId,
      lithology: litho.lithology,
      lithoFromV: litho.fromV,
      lithoToV: litho.toV,
      matchType: 'extra-litho',
      note: '无对应回次',
    });
  }

  // 按垂深排序（取回次或岩性的起点垂深）
  sections.sort((a, b) => {
    const aFrom = a.runFromV ?? a.lithoFromV ?? 0;
    const bFrom = b.runFromV ?? b.lithoFromV ?? 0;
    return aFrom - bFrom;
  });

  // 计算总体状态
  const exactCount = sections.filter((s) => s.matchType === 'exact').length;
  const status: ReconcileStatus =
    sections.length === 0 ? 'failed' : exactCount === sections.length ? 'matched' : exactCount > 0 ? 'partial' : 'failed';

  return { sections, status };
}

/** 创建对账记录 */
export function createReconcileRecord(
  holeId: string,
  sections: SectionMatch[],
  status: ReconcileStatus,
  createdBy: string,
  note?: string,
): ReconcileRecord {
  return {
    id: uid('rec'),
    holeId,
    status,
    sections,
    createdBy,
    createdAt: new Date().toISOString(),
    note,
  };
}

/** 匹配类型文案与配色 */
export const MATCH_TYPE_TEXT: Record<MatchType, { label: string; color: string }> = {
  exact: { label: '精确匹配', color: 'green' },
  overlap: { label: '部分重叠', color: 'orange' },
  'extra-run': { label: '无岩性', color: 'red' },
  'extra-litho': { label: '无回次', color: 'red' },
};
