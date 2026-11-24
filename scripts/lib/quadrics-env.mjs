export function quadricsEnv(name, env = process.env) {
  // An explicitly empty new value still takes precedence over an older value.
  return env[`QUADRICS_${name}`] ?? env[`CARTLIO_${name}`];
}
