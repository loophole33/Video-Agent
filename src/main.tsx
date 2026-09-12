import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { useGraph } from './store/graphStore';
import { useRun } from './store/runStore';
import { useUi } from './store/uiStore';
import { useAgent } from './store/agentStore';
import { mockRuntime } from './engine/mockEngine';
import { buildPlan } from './canvas/topo';
import { applyPatch, invertOps } from './canvas/applyPatch';
import { nodeRegistry } from './registry';
import { startRun, cancelRun, graphCost } from './engine/actions';
import { useModelStore } from './engine/realVideo';
import { useCanvas } from './store/canvasStore';
import { gatewayHealth, listModels, runSkill, generateVideo } from './engine/modelGateway';
import { TEMPLATES } from './data/templates';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 调试/E2E 句柄：与真实项目里暴露 window.__MVA__ 的做法一致（仅 dev 构建注入）
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__mva = {
    useGraph,
    useRun,
    useUi,
    useAgent,
    mockRuntime,
    buildPlan,
    applyPatch,
    invertOps,
    nodeRegistry,
    startRun,
    cancelRun,
    graphCost,
    TEMPLATES,
    // 模型网关与能力探测（E2E / 调试用）
    useModelStore,
    useCanvas,
    gatewayHealth,
    listModels,
    runSkill,
    generateVideo,
  };
}

