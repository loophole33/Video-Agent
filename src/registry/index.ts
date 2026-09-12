/** 注册表装配点：所有节点类型的唯一注册入口 */
import { nodeRegistry } from './nodeRegistry';
import { audioSpec, imageSpec, textSpec, videoSpec } from './specs/basic';
import { composeSpec, promptCompileSpec, qaCheckSpec, scriptSpec } from './specs/pipeline';

nodeRegistry
  .register(textSpec)
  .register(imageSpec)
  .register(videoSpec)
  .register(audioSpec)
  .register(scriptSpec)
  .register(promptCompileSpec)
  .register(qaCheckSpec)
  .register(composeSpec);

export { nodeRegistry };
export type { NodeTypeSpec } from './types';
