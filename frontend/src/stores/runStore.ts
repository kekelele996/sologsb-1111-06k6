import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import type { DrillRun, RunAnomaly, RunShift } from '../types/drill-run';
import { footageOf, gradeOf, isAnomaly, rangesOverlap, recoveryOf, RECOVERY_GRADE_TEXT, validateRange } from '../utils/recovery';

export interface RunInput {
  runNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  coreLength: number;
  waterLevel: number;
  shift: RunShift;
  drilledAt: string;
  recorder: string;
  remark?: string;
}

/** 班报行：回次号 + 起止深度 + 岩芯长度 */
export interface ShiftReportLine {
  runNo: string;
  fromDepth: number;
  toDepth: number;
  coreLength: number;
}

/** 班报提交结果：added 新增 / updated 同号修正 / skipped 无变化跳过 / errors 行级错误 */
export interface ShiftReportResult {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}

interface RunState {
  runs: DrillRun[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addRun: (input: RunInput) => Promise<DrillRun>;
  updateRun: (id: string, patch: Partial<RunInput>) => Promise<void>;
  removeRun: (id: string) => Promise<void>;
  removeByHole: (holeId: string) => Promise<void>;
  /**
   * 班报提交（幂等）：按 (holeId, runNo) 去重——同号无变化跳过、有变化修正、新号才新增，
   * 同一班报再交一次不会多出回次。
   */
  submitShiftReport: (input: {
    holeId: string;
    shift: RunShift;
    drilledAt: string;
    recorder: string;
    waterLevel: number;
    lines: ShiftReportLine[];
  }) => Promise<ShiftReportResult>;
}

/** 回次与采取率派生值：进尺与采取率均由起止深度、岩芯长度自动计算 */
export const useRunStore = create<RunState>()((set, get) => ({
  runs: [],
  hydrated: false,

  hydrate: async () => {
    const runs = await db.runs.orderBy('fromDepth').toArray();
    set({ runs, hydrated: true });
  },

  addRun: async (input) => {
    const footage = footageOf(input.fromDepth, input.toDepth);
    const run: DrillRun = {
      id: uid('run'),
      runNo: input.runNo.trim(),
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      footage,
      coreLength: Number(input.coreLength) || 0,
      recovery: recoveryOf(input.coreLength, footage),
      waterLevel: Number(input.waterLevel) || 0,
      shift: input.shift,
      drilledAt: input.drilledAt,
      recorder: input.recorder.trim(),
      remark: input.remark?.trim() || undefined,
    };
    await db.runs.put(run);
    set({ runs: [run, ...get().runs] });
    return run;
  },

  updateRun: async (id, patch) => {
    const current = get().runs.find((r) => r.id === id);
    if (!current) return;
    const merged = { ...current, ...patch };
    const footage = footageOf(merged.fromDepth, merged.toDepth);
    const next: DrillRun = {
      ...merged,
      footage,
      recovery: recoveryOf(merged.coreLength, footage),
    };
    await db.runs.put(next);
    set({ runs: get().runs.map((r) => (r.id === id ? next : r)) });
  },

  removeRun: async (id) => {
    await db.runs.delete(id);
    set({ runs: get().runs.filter((r) => r.id !== id) });
  },

  removeByHole: async (holeId) => {
    const ids = get().runs.filter((r) => r.holeId === holeId).map((r) => r.id);
    await db.runs.bulkDelete(ids);
    set({ runs: get().runs.filter((r) => r.holeId !== holeId) });
  },

  submitShiftReport: async (input) => {
    const result: ShiftReportResult = { added: 0, updated: 0, skipped: 0, errors: [] };
    const seen = new Set<string>();
    for (let i = 0; i < input.lines.length; i += 1) {
      const line = input.lines[i];
      const lineNo = i + 1;
      const runNo = line.runNo.trim();
      if (!runNo) {
        result.errors.push(`第${lineNo}行：回次号为空`);
        continue;
      }
      if (seen.has(runNo)) {
        result.errors.push(`第${lineNo}行：回次号 ${runNo} 在班报内重复`);
        continue;
      }
      seen.add(runNo);

      const rangeError = validateRange(line.fromDepth, line.toDepth);
      if (rangeError) {
        result.errors.push(`第${lineNo}行（${runNo}）：${rangeError}`);
        continue;
      }
      // 与既有回次的重叠校验：同号回次是修正对象，排除在外
      const existing = get().runs.find((r) => r.holeId === input.holeId && r.runNo === runNo);
      const overlapped = get().runs.filter(
        (r) => r.holeId === input.holeId && r.id !== existing?.id && rangesOverlap(line.fromDepth, line.toDepth, r.fromDepth, r.toDepth),
      );
      if (overlapped.length) {
        result.errors.push(`第${lineNo}行（${runNo}）：与既有回次 ${overlapped.map((r) => r.runNo).join('、')} 深度重叠`);
        continue;
      }

      if (existing) {
        const unchanged =
          Math.abs(existing.fromDepth - line.fromDepth) < 0.005 &&
          Math.abs(existing.toDepth - line.toDepth) < 0.005 &&
          Math.abs(existing.coreLength - line.coreLength) < 0.005;
        if (unchanged) {
          result.skipped += 1;
          continue;
        }
        await get().updateRun(existing.id, {
          fromDepth: line.fromDepth,
          toDepth: line.toDepth,
          coreLength: line.coreLength,
          waterLevel: input.waterLevel,
          shift: input.shift,
          drilledAt: input.drilledAt,
          recorder: input.recorder,
        });
        result.updated += 1;
        continue;
      }
      await get().addRun({
        runNo,
        holeId: input.holeId,
        fromDepth: line.fromDepth,
        toDepth: line.toDepth,
        coreLength: line.coreLength,
        waterLevel: input.waterLevel,
        shift: input.shift,
        drilledAt: input.drilledAt,
        recorder: input.recorder,
      });
      result.added += 1;
    }
    return result;
  },
}));

/** 采取率异常清单（低于 75% 判异常） */
export function anomalyList(runs: DrillRun[], holeNoOf: (holeId: string) => string): RunAnomaly[] {
  return runs
    .filter((run) => isAnomaly(run.recovery))
    .map((run) => ({
      run,
      holeNo: holeNoOf(run.holeId),
      grade: gradeOf(run.recovery),
      advice: RECOVERY_GRADE_TEXT.异常.advice,
    }))
    .sort((a, b) => a.run.recovery - b.run.recovery);
}
