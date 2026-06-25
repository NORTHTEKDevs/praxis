// Proxy metric for acceptance-test strength (no LLM, no full coverage analysis).
// Counts assert(...) expressions that compare run(...) (or any expression) against a
// CONCRETE literal (string/number/bool/null/array/object). Self-referential checks
// like assert(run(x) === run(x)) and content-free checks like assert(true) score 0.
// The verify gate rejects skills whose acceptance test scores 0 (garbage-in guard).
export function computeCheckStrength(acceptanceTest: string): number {
  if (!acceptanceTest || !acceptanceTest.trim()) return 0
  let strength = 0
  const calls = acceptanceTest.split(/assert\s*\(/).slice(1)
  for (const seg of calls) {
    // flatten newlines so a multi-line assert body still parses, then take the
    // assertion expression up to the closing paren / statement end
    const flat = seg.replace(/\n\s*/g, ' ')
    const expr = flat.split(/\)\s*;?\s*$/)[0]
    const parts = expr.split(/===|!==|==|!=/)
    if (parts.length < 2) continue
    const lhs = parts[0]
    const rhs = parts.slice(1).join('==')
    // run(...) anywhere in the operand, not just at the start, so a WRAPPED oracle like
    // `assert(JSON.stringify(run(3)) === "[1,2,3]")` is recognized (was scored 0 -> a legit
    // skill permanently quarantined). `run(` must be preceded by start-or-non-identifier so
    // `myrun(x)` does not match.
    const isRun = (s: string) => /(?:^|[^\w$])run\s*\(/.test(s)
    const hasLiteral = (s: string) => /(["'`])|(?:^|[^\w.])-?\d|\btrue\b|\bfalse\b|\bnull\b|\bundefined\b|\bNaN\b|\bInfinity\b|\[|\{/.test(s)
    // a real oracle compares run(...) against a CONCRETE literal. literal-vs-literal
    // (assert("a" === "a")) and run-vs-run (self-referential) score 0: the implementation
    // is never exercised, so they must NOT pass the verify gate.
    if (isRun(lhs) && isRun(rhs)) continue
    if ((isRun(lhs) && hasLiteral(rhs)) || (isRun(rhs) && hasLiteral(lhs))) strength++
  }
  return strength
}
