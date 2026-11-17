/** Leading option letter/number of an answer ("B: merge…" → "B"; "1,3" → "1,3"); free text → whole text. */
export function choice(s: string | undefined): string {
  const t = (s ?? "").trim();
  const m = t.match(/^([A-Za-z]|\d+(?:\s*[,，]\s*\d+)*)(?=$|[\s:：.)、,，;；])/);
  return m ? m[1].replace(/\s/g, "").replace(/，/g, ",").toUpperCase() : t.toLowerCase();
}

const affirmativeRecommendation = (s: string) =>
  /^(?:确定补全|确认补全|确定|确认)(?:[。！!，,\s]|$)/.test(s) ||
  /^(?:按|按照)(?:当前|上述|该)?推荐/.test(s) ||
  /^(?:同意|批准|接受|采用)(?:推荐|建议|方案)?(?:[。！!，,\s]|$)/.test(s);

const numberedOptions = (options: string | undefined) => (options ?? "").split(/\s+\|\s+/)
  .filter((option) => /^\d+\s*[.:：.)、]/.test(option.trim())).length;

const numericChoices = (s: string) => /^\d+(?:,\d+)*$/.test(s) ? s.split(",").map(Number) : [];

/** Compare an owner's natural-language answer with an option selection without treating clear confirmations as overrides. */
export function answersMatch(answer: string | undefined, expected: string | undefined, options?: string): boolean {
  const actual = choice(answer);
  const wanted = choice(expected);
  if (!actual || !wanted) return false;
  if (actual === wanted) return true;
  if (affirmativeRecommendation((answer ?? "").trim())) return true;
  if (!/^(?:all|全部)(?=$|[\s:：，,。])/i.test((answer ?? "").trim())) return false;
  const count = numberedOptions(options);
  const selected = numericChoices(wanted);
  return count > 0 && selected.length === count && selected.every((value, index) => value === index + 1);
}
