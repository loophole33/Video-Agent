import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { GraphPatch } from '../types/graph';
import { respond } from '../engine/mockAgent';
import { mockRuntime } from '../engine/mockEngine';
import { useGraph } from './graphStore';
import { useUi } from './uiStore';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  ts: number;
  patchId?: string;
  questions?: string[];
}

interface AgentState {
  messages: ChatMessage[];
  proposals: GraphPatch[];
  thinking: boolean;
  send: (text: string) => void;
  accept: (patchId: string) => void;
  reject: (patchId: string, reason?: string) => void;
  previewGhost: (patchId: string | null) => void;
  dismissAll: () => void;
}

const greeting: ChatMessage = {
  id: 'm0',
  role: 'agent',
  text: '说一句话我就把工作流搭出来，比如「给这款气泡水做条 20s 抖音种草视频，突出 0 糖」。也可以直接让我改现有节点。',
  ts: Date.now(),
};

export const useAgent = create<AgentState>()(
  immer((set, get) => ({
    messages: [greeting],
    proposals: [],
    thinking: false,

    send: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      set((s) => {
        s.messages.push({ id: `m_${Math.random().toString(36).slice(2, 8)}`, role: 'user', text: trimmed, ts: Date.now() });
        s.thinking = true;
      });

      // 模拟一次 LLM 往返（真实实现走 SSE 流式）
      window.setTimeout(() => {
        const graph = useGraph.getState().graph;
        const result = respond(graph, trimmed);
        set((s) => {
          s.thinking = false;
          s.messages.push({
            id: `m_${Math.random().toString(36).slice(2, 8)}`,
            role: 'agent',
            text: result.reply,
            ts: Date.now(),
            patchId: result.patch?.patch_id,
            questions: result.questions,
          });
          if (result.patch) s.proposals.push(result.patch);
        });
        if (result.action === 'run') {
          const budget = graph.constraints.budgetLimitCny;
          void mockRuntime.run({ graph, mode: 'full', budget });
        }
      }, 420);
    },

    accept: (patchId) => {
      const patch = get().proposals.find((p) => p.patch_id === patchId);
      if (!patch) return;
      useGraph.getState().applyAgentPatch(patch);
      set((s) => {
        s.proposals = s.proposals.filter((p) => p.patch_id !== patchId);
      });
      useUi.getState().setGhostOps(null);
      useUi.getState().toast('success', `已应用 Agent 提案（${patch.ops.length} 处改动，Ctrl/Cmd+Z 可整批撤销）`);
    },

    reject: (patchId, reason) => {
      set((s) => {
        s.proposals = s.proposals.filter((p) => p.patch_id !== patchId);
      });
      useUi.getState().setGhostOps(null);
      useUi.getState().toast('info', reason ? `已拒绝提案：${reason}` : '已拒绝提案');
    },

    previewGhost: (patchId) => {
      const patch = get().proposals.find((p) => p.patch_id === patchId);
      useUi.getState().setGhostOps(patch ? patch.ops : null);
    },

    dismissAll: () =>
      set((s) => {
        s.proposals = [];
      }),
  })),
);
