import { performance } from 'node:perf_hooks';

// Preserve dynamic receivers: lazy pg.Pool proxies bind methods to their real
// pool, and writes to a proxy itself may never be observed by its get trap.
export function measureMethod(target, name, record, { capture = () => undefined, appliesTo = () => true } = {}) {
  const original = target[name];
  target[name] = function (...args) {
    if (!appliesTo(this)) return original.apply(this, args);
    const context = capture(), started = performance.now(); let recorded = false;
    const done = error => { if (!recorded) { recorded = true; record(performance.now() - started, error, args[0], context); } };
    const last = args.length - 1;
    if (typeof args[last] === 'function') {
      const callback = args[last]; args[last] = (...values) => { done(values[0]); callback(...values); };
      try { return original.apply(this, args); } catch (error) { done(error); throw error; }
    }
    try { return original.apply(this, args).then(value => { done(); return value; }, error => { done(error); throw error; }); }
    catch (error) { done(error); throw error; }
  };
}
