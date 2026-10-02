/** 对账状态 */
export type ReconcileStatus = 'matched' | 'partial' | 'failed';

/**
 * 段匹配类型：
 * - exact：回次与岩性区间边界对齐（精确匹配）
 * - overlap：回次与岩性区间重叠但边界未对齐
 * - extra-run：有回次但无对应岩性区间
 * - extra-litho：有岩性区间但无对应回次
 */
export type MatchType = 'exact' | 'overlap' | 'extra-run' | 'extra-litho';

/** 对账段：回次与岩性区间的比段结果 */
export interface SectionMatch {
  id: string;
  /** 回次 id（无对应回次时为空） */
  runId?: string;
  /** 岩性区间 id（无对应岩性时为空） */
  lithoId?: string;
  /** 回次号（冗余，展示用） */
  runNo?: string;
  /** 岩性（冗余，展示用） */
  lithology?: string;
  /** 现场孔深起（m）—— 班组长原始记录，始终保留 */
  runFromHole?: number;
  /** 现场孔深止（m） */
  runToHole?: number;
  /** 换算垂深起（m）—— 仅用于对照，不覆盖孔深 */
  runFromV?: number;
  /** 换算垂深止（m） */
  runToV?: number;
  /** 岩性垂深起（m） */
  lithoFromV?: number;
  /** 岩性垂深止（m） */
  lithoToV?: number;
  /** 匹配类型 */
  matchType: MatchType;
  /** 组长是否已决定 */
  decided?: boolean;
  /** 组长决定备注 */
  decision?: string;
  /** 备注 */
  note?: string;
}

/** 对账记录：一次对账的完整结果（持久化，重试时保留已比好的段） */
export interface ReconcileRecord {
  id: string;
  /** 所属钻孔 */
  holeId: string;
  /** 对账状态 */
  status: ReconcileStatus;
  /** 对账段列表 */
  sections: SectionMatch[];
  /** 对账人 */
  createdBy: string;
  /** 对账时间 ISO */
  createdAt: string;
  /** 备注 */
  note?: string;
}
