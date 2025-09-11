// Minimal stub for Node's `fs` to satisfy Metro resolution in React Native.
// If any code attempts to use it at runtime, throw a clear error.
module.exports = new Proxy({}, {
  get() {
    return () => {
      throw new Error('fs is not available in React Native. Avoid importing server-side modules in the app.');
    };
  }
});

