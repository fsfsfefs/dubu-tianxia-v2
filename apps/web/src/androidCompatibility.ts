/** APIs absent in Android 14's factory WebView but used by current PDF.js. */
export function installAndroidCompatibility() {
  if (typeof (Promise as unknown as {withResolvers?: unknown}).withResolvers !== 'function') {
    Object.defineProperty(Promise, 'withResolvers', {configurable: true, writable: true,
      value: function(this: PromiseConstructor) {
        let resolve!: (value: unknown) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new this((yes, no) => {resolve = yes; reject = no;});
        return {promise, resolve, reject};
      },
    });
  }
  if (typeof AbortSignal.any !== 'function') {
    Object.defineProperty(AbortSignal, 'any', {configurable: true, writable: true,
      value: function(input: Iterable<AbortSignal>) {
        const signals = Array.from(input);
        if (signals.some(signal => !(signal instanceof AbortSignal))) throw new TypeError('Expected AbortSignal');
        const controller = new AbortController();
        const cleanup = () => signals.forEach(signal => signal.removeEventListener('abort', abort));
        const abort = (event: Event) => {cleanup(); controller.abort((event.target as AbortSignal).reason);};
        const stopped = signals.find(signal => signal.aborted);
        if (stopped) controller.abort(stopped.reason);
        else signals.forEach(signal => signal.addEventListener('abort', abort, {once: true}));
        return controller.signal;
      },
    });
  }
}
