import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { LithoLog } from '../types/litho-log';
import type { ReconSegment, ReconSession, ReconVerdict, SegmentStatus } from '../types/reconcile';
import { buildSegments, classifyRange, mergeWithStored, summarizeSegments, RECON_TOLERANCE_M } from '../utils/reconcile';
import { tvdRangeOf } from '../utils/survey';

/** 对账入参：两侧数据由各自主管页面持有，对账只读不改 */
export interface ReconcileInput {
  hole: DrillHole;
  runs: DrillRun[];
  lithos: LithoLog[];
  operator: string;
  tolerance?: number;
}

export interface RetryContext {
  hole: DrillHole;
  runs: DrillRun[];
  lithos: LithoLog[];
  tolerance?: number;
}

interface ReconState {
  segments: ReconSegment[];
  sessions: ReconSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 全孔对账：重算各段并与历史合并，已比好的段与人工裁定保留，留痕一个批次 */
  runReconcile: (input: ReconcileInput) => Promise<ReconSession>;
  /** 按段重试：只重算该段，其余段不动 */
  retrySegment: (segmentId: string, ctx: RetryContext) => Promise<SegmentStatus | undefined>;
  /** 挂起：对不上的段摆出待班组长定，不阻塞其他段 */
  pendSegment: (segmentId: string, note?: string) => Promise<void>;
  /** 班组长裁定：记录定论口径，不改双方原始数据 */
  resolveSegment: (segmentId: string, verdict: ReconVerdict, verdictBy: string, note?: string) => Promise<void>;
  removeByHole: (holeId: string) => Promise<void>;
}

/** 回次（孔深）换算垂深后的区间组 */
function runIntervalsOf(hole: DrillHole, runs: DrillRun[]) {
  return runs
    .filter((run) => run.holeId === hole.id)
    .map((run) => {
      const { fromTvd, toTvd } = tvdRangeOf(run.fromDepth, run.toDepth, hole.surveyData);
      return { id: run.id, from: fromTvd, to: toTvd };
    });
}

function lithoIntervalsOf(hole: DrillHole, lithos: LithoLog[]) {
  return lithos.filter((log) => log.holeId === hole.id).map((log) => ({ id: log.id, from: log.fromDepth, to: log.toDepth }));
}

/** 对账段与批次：段级状态各自推进，互不相拖 */
export const useReconStore = create<ReconState>()((set, get) => ({
  segments: [],
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const [segments, sessions] = await Promise.all([db.reconSegments.toArray(), db.reconSessions.orderBy('createdAt').toArray()]);
    set({ segments, sessions, hydrated: true });
  },

  runReconcile: async (input) => {
    const tolerance = input.tolerance ?? RECON_TOLERANCE_M;
    const now = new Date().toISOString();
    const holeRuns = input.runs.filter((run) => run.holeId === input.hole.id);
    const holeLithos = input.lithos.filter((log) => log.holeId === input.hole.id);
    const fresh = buildSegments(holeRuns, holeLithos, input.hole.surveyData, tolerance);
    const stored = get().segments.filter((seg) => seg.holeId === input.hole.id);
    const merged = mergeWithStored(fresh, stored, now);
    const segments: ReconSegment[] = merged.map(({ id, ...rest }) => ({ ...rest, id: id ?? uid('seg'), holeId: input.hole.id }));

    const counts = summarizeSegments(segments);
    const session: ReconSession = {
      id: uid('recon'),
      holeId: input.hole.id,
      createdAt: now,
      operator: input.operator.trim() || '对账人',
      tolerance,
      ...counts,
      result: counts.missingLitho + counts.missingRun + counts.pending === 0 ? 'balanced' : 'unbalanced',
    };

    await db.transaction('rw', db.reconSegments, db.reconSessions, async () => {
      await db.reconSegments.where('holeId').equals(input.hole.id).delete();
      await db.reconSegments.bulkPut(segments);
      await db.reconSessions.put(session);
    });
    set({
      segments: [...get().segments.filter((seg) => seg.holeId !== input.hole.id), ...segments],
      sessions: [session, ...get().sessions],
    });
    return session;
  },

  retrySegment: async (segmentId, ctx) => {
    const segment = get().segments.find((seg) => seg.id === segmentId);
    if (!segment || segment.status === 'resolved') return undefined;
    const tolerance = ctx.tolerance ?? RECON_TOLERANCE_M;
    const classified = classifyRange(
      segment.fromTvd,
      segment.toTvd,
      runIntervalsOf(ctx.hole, ctx.runs),
      lithoIntervalsOf(ctx.hole, ctx.lithos),
      tolerance,
    );
    const next: ReconSegment = {
      ...segment,
      status: classified.status,
      residual: classified.residual,
      runIds: classified.runIds,
      lithoIds: classified.lithoIds,
      note: classified.note,
      verdict: undefined,
      verdictBy: undefined,
      verdictAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    await db.reconSegments.put(next);
    set({ segments: get().segments.map((seg) => (seg.id === segmentId ? next : seg)) });
    return next.status;
  },

  pendSegment: async (segmentId, note) => {
    const segment = get().segments.find((seg) => seg.id === segmentId);
    if (!segment || segment.status === 'matched' || segment.status === 'resolved') return;
    const next: ReconSegment = { ...segment, status: 'pending', note: note?.trim() || segment.note, updatedAt: new Date().toISOString() };
    await db.reconSegments.put(next);
    set({ segments: get().segments.map((seg) => (seg.id === segmentId ? next : seg)) });
  },

  resolveSegment: async (segmentId, verdict, verdictBy, note) => {
    const segment = get().segments.find((seg) => seg.id === segmentId);
    if (!segment || segment.status === 'matched' || segment.status === 'resolved') return;
    const now = new Date().toISOString();
    const next: ReconSegment = {
      ...segment,
      status: 'resolved',
      verdict,
      verdictBy: verdictBy.trim() || '班组长',
      verdictAt: now,
      note: note?.trim() || segment.note,
      updatedAt: now,
    };
    await db.reconSegments.put(next);
    set({ segments: get().segments.map((seg) => (seg.id === segmentId ? next : seg)) });
  },

  removeByHole: async (holeId) => {
    await db.transaction('rw', db.reconSegments, db.reconSessions, async () => {
      await db.reconSegments.where('holeId').equals(holeId).delete();
      await db.reconSessions.where('holeId').equals(holeId).delete();
    });
    set({
      segments: get().segments.filter((seg) => seg.holeId !== holeId),
      sessions: get().sessions.filter((session) => session.holeId !== holeId),
    });
  },
}));
