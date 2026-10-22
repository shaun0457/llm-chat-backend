const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A token estimate, not a bound: one token per CJK (Han, Hiragana, Katakana, Hangul) code
 * point, plus one per three other code points, rounded up. Real tokenizers differ by model and
 * can count more; the history budget's margin and the provider's own context error cover that.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (CJK.test(character)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 3);
}
