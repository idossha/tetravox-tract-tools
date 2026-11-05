import { createElement } from '@tetravox/module-sdk';
import type { ModuleHost, ModuleInstance } from '@tetravox/module-sdk';
import { createModel } from './model';
import { TractPanel } from './Panel';

export const activate = (host: ModuleHost): ModuleInstance => {
  const model = createModel(host);
  return {
    Panel: () => createElement(TractPanel, { model }),
    runCommand: (id, args) => model.run(id, args),
    runOperation: (op, args) => model.operation(op, args),
    restoreBlock: (block) => model.restore(block),
    dirty: () => false,
    dispose: () => model.dispose(),
  };
};
