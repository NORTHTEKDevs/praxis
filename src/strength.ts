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
    // take the assertion expression up to the closing paren / statement end
    const expr = seg.split(/\)\s*;?\s*$/m)[0].split('\n')[0]
    const parts = expr.split(/===|!==|==|!=/)
    if (parts.length < 2) continue
    const lhs = parts[0]
    const rhs = parts.slice(1).join('==')
    const isRun = (s: string) => /^\s*run\s*\(/.test(s.trim())
    const hasLiteral = (s: string) => /(["'`])|(?:^|[^\w.])-?\d|\btrue\b|\bfalse\b|\bnull\b|\[|\{/.test(s)
    if (isRun(lhs) && isRun(rhs)) continue // self-referential -> no concrete oracle
    if ((isRun(lhs) && hasLiteral(rhs)) || (isRun(rhs) && hasLiteral(lhs))) strength++
    else if (hasLiteral(lhs) || hasLiteral(rhs)) strength++
  }
  return strength
}
