Findings for Context sidebar render lag

Sources:
- React startTransition docs: https://react.dev/reference/react/startTransition
- React useTransition docs: https://react.dev/reference/react/useTransition
- React Suspense docs: https://react.dev/reference/react/Suspense
- React lazy docs: https://react.dev/reference/react/lazy
- React useDeferredValue docs: https://react.dev/reference/react/useDeferredValue
- web.dev content-visibility: https://web.dev/content-visibility
- web.dev rendering performance: https://web.dev/rendering-performance/?hl=en%3A

Key points:
- React transitions mark state updates as non-blocking; React can interrupt and restart expensive background renders when higher-priority input arrives.
- Suspense primarily coordinates fallback UI for components/data that suspend, including code loaded with React.lazy. It does not make synchronous DOM/layout/paint work disappear.
- useDeferredValue is useful when a value-driven expensive subtree can lag behind an immediate UI update.
- Browser layout and paint remain critical. Flex layout changes can force layout of affected elements, and content-visibility/containment can reduce rendering work for isolated or offscreen subtrees.
- For the measured Helmor behavior, no IPC occurred; DOM appeared around 53-55ms, while RAF/presentation lagged later. This points at frontend render/layout/paint and not backend latency.
