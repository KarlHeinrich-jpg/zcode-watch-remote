export function makeLogger(prefix = 'bridge') {
  const ts = () => new Date().toISOString().slice(11, 19);
  return {
    info: (...a) => console.log(`[${ts()}] [${prefix}]`, ...a),
    warn: (...a) => console.warn(`[${ts()}] [${prefix}]`, ...a),
    error: (...a) => console.error(`[${ts()}] [${prefix}]`, ...a),
    debug: (...a) => {
      if (process.env.ZCODE_REMOTE_DEBUG) console.log(`[${ts()}] [${prefix}:debug]`, ...a);
    },
  };
}
