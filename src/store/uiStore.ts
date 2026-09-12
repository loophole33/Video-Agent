import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { PatchOp } from '../types/graph';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
}

export interface Dialog {
  kind: 'budget' | 'policy' | 'info';
  title: string;
  body: string;
  detail?: string;
  actions?: { label: string; run?: () => void; tone?: 'primary' | 'ghost' }[];
}

export interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  logHeight: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: 268,
  rightWidth: 330,
  logHeight: 230,
  leftCollapsed: false,
  rightCollapsed: false,
};

const LAYOUT_KEY = 'mva.layout.v1';

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<LayoutState>) };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

interface UiState {
  selectedIds: string[];
  inspectorTab: 'params' | 'run' | 'logs';
  logOpen: boolean;
  toasts: Toast[];
  dialog: Dialog | null;
  quickCreate: { flow: { x: number; y: number }; screen: { x: number; y: number } } | null;
  ghostOps: PatchOp[] | null;
  showHelp: boolean;
  activeTemplateId: string | null;
  layout: LayoutState;

  setSelection: (ids: string[]) => void;
  setInspectorTab: (t: UiState['inspectorTab']) => void;
  toggleLog: (b?: boolean) => void;
  toast: (tone: ToastTone, message: string) => void;
  dismissToast: (id: string) => void;
  openDialog: (d: Dialog) => void;
  closeDialog: () => void;
  openQuickCreate: (flow: { x: number; y: number }, screen: { x: number; y: number }) => void;
  closeQuickCreate: () => void;
  setGhostOps: (ops: PatchOp[] | null) => void;
  setShowHelp: (b: boolean) => void;
  setActiveTemplate: (id: string | null) => void;
  setLayout: (patch: Partial<LayoutState>) => void;
  resetLayout: () => void;
}

export const DEFAULT_LAYOUT_STATE = DEFAULT_LAYOUT;

export const useUi = create<UiState>()(
  immer((set) => ({
    selectedIds: [],
    inspectorTab: 'params',
    logOpen: true,
    toasts: [],
    dialog: null,
    quickCreate: null,
    ghostOps: null,
    showHelp: false,
    activeTemplateId: null,
    layout: loadLayout(),

    setSelection: (ids) => set((s) => { s.selectedIds = ids; }),
    setInspectorTab: (t) => set((s) => { s.inspectorTab = t; }),
    toggleLog: (b) => set((s) => { s.logOpen = b ?? !s.logOpen; }),

    toast: (tone, message) =>
      set((s) => {
        const id = `t_${Math.random().toString(36).slice(2, 8)}`;
        s.toasts.push({ id, tone, message });
        if (s.toasts.length > 4) s.toasts.shift();
      }),

    dismissToast: (id) => set((s) => { s.toasts = s.toasts.filter((t) => t.id !== id); }),
    openDialog: (d) => set((s) => { s.dialog = d; }),
    closeDialog: () => set((s) => { s.dialog = null; }),

    openQuickCreate: (flow, screen) => set((s) => { s.quickCreate = { flow, screen }; }),
    closeQuickCreate: () => set((s) => { s.quickCreate = null; }),
    setGhostOps: (ops) => set((s) => { s.ghostOps = ops; }),
    setShowHelp: (b) => set((s) => { s.showHelp = b; }),
    setActiveTemplate: (id) => set((s) => { s.activeTemplateId = id; }),

    setLayout: (patch) =>
      set((s) => {
        s.layout = { ...s.layout, ...patch };
        try {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(s.layout));
        } catch {
          /* 存不了就算了，不影响使用 */
        }
      }),

    resetLayout: () =>
      set((s) => {
        s.layout = { ...DEFAULT_LAYOUT };
        try {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(s.layout));
        } catch {
          /* ignore */
        }
      }),
  })),
);
