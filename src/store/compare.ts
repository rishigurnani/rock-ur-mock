import { create } from 'zustand';

interface Compare { ids: string[]; toggle: (id: string) => void; clear: () => void }

/** Mock Stats view-selection: which saved drafts are checked to compare. A view
 *  concern, kept out of the domain draft store (shared by SetupPanel + MockStats). */
export const useCompare = create<Compare>((set) => ({
  ids: [],
  toggle: (id) => set((s) => ({ ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id] })),
  clear: () => set({ ids: [] }),
}));
