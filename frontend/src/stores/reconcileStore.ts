import { create } from 'zustand';
import { db } from '../utils/db';
import type { ReconcileRecord } from '../types/reconcile';

interface ReconcileState {
  records: ReconcileRecord[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  saveRecord: (record: ReconcileRecord) => Promise<void>;
  removeRecord: (id: string) => Promise<void>;
  recordsOf: (holeId: string) => ReconcileRecord[];
  latestOf: (holeId: string) => ReconcileRecord | undefined;
}

/** 对账记录持久化：提交对账时写入，重试时保留已比好的段 */
export const useReconcileStore = create<ReconcileState>()((set, get) => ({
  records: [],
  hydrated: false,

  hydrate: async () => {
    const records = await db.reconciles.orderBy('createdAt').toArray();
    set({ records, hydrated: true });
  },

  saveRecord: async (record) => {
    await db.reconciles.put(record);
    set({ records: [...get().records.filter((r) => r.id !== record.id), record] });
  },

  removeRecord: async (id) => {
    await db.reconciles.delete(id);
    set({ records: get().records.filter((r) => r.id !== id) });
  },

  recordsOf: (holeId) => get().records.filter((r) => r.holeId === holeId),

  latestOf: (holeId) =>
    get()
      .records.filter((r) => r.holeId === holeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
}));
