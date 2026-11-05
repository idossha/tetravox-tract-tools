/**
 * The global `JSX` namespace the classic transform looks for.
 *
 * `tsconfig.json` compiles JSX to `createElement(...)` — the SDK's re-export of the host's own
 * React — because the automatic runtime would emit `import { jsx } from 'react/jsx-runtime'`, and a
 * bare specifier in a downloaded bundle is the one thing that cannot survive the loader. The
 * classic transform resolves element types through a **global** `JSX` namespace, which
 * `@types/react` 19 no longer declares (it moved everything under `React.JSX`), so this file points
 * the global at React's.
 *
 * Types only. `@types/react` is a devDependency and nothing here survives compilation; the module's
 * one React is still the host's, handed over on `globalThis.__tetravoxModuleSdk`.
 */

import type * as react from 'react';

declare global {
  namespace JSX {
    type Element = react.JSX.Element;
    type ElementType = react.JSX.ElementType;
    type ElementClass = react.JSX.ElementClass;
    type IntrinsicElements = react.JSX.IntrinsicElements;
    type IntrinsicAttributes = react.JSX.IntrinsicAttributes;
    type IntrinsicClassAttributes<T> = react.JSX.IntrinsicClassAttributes<T>;
    type ElementAttributesProperty = react.JSX.ElementAttributesProperty;
    type ElementChildrenAttribute = react.JSX.ElementChildrenAttribute;
    type LibraryManagedAttributes<C, P> = react.JSX.LibraryManagedAttributes<C, P>;
  }
}
