// The app assigns this global before any extension activates; the SDK shim throws without it.
import * as react from 'react';
import { MODULE_HOST_VERSION, stemOf } from '@tetravox/module-sdk/manifest-types.mjs';

class ModuleHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleHostError';
  }
}

(globalThis as Record<string, unknown>)['__tetravoxModuleSdk'] = {
  hostVersion: MODULE_HOST_VERSION,
  react,
  ModuleHostError,
  stemOf,
  contacts: {},
};
