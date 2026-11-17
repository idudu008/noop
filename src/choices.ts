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

const confirmedChoice = (s: string) => {
  const match = s.match(/^(?:确定补全|确认补全|确定|确认|同意|批准|接受|采用)[。！!，,\s:：]*(?:选择|采用|方案)?[\s:：]*([A-Za-z]|\d+(?:\s*[,，]\s*\d+)*)(?=$|[\s:：.)、,，;；])/);
  return match ? choice(match[1]) : "";
};

const recommendedNumbers = (expected: string | undefined, options: string | undefined) => {
  const count = numberedOptions(options);
  const leading = numericChoices(choice(expected));
  if (!count) return leading;
  const values = new Set(leading);
  for (const match of (expected ?? "").matchAll(/(?:执行|完成|推进|处理|先做|再做|after|then)\s*(\d+(?:\s*[,，、]\s*\d+)*)/gi)) {
    for (const token of match[1].split(/\s*[,，、]\s*/)) {
      const value = Number(token);
      if (value >= 1 && value <= count) values.add(value);
    }
  }
  return [...values].sort((a, b) => a - b);
};

const sameNumbers = (left: number[], right: number[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export type AnswerClassification = "accepted" | "extended" | "rewritten";

/** Compare an owner's natural-language answer with an option selection without treating clear confirmations as overrides. */
export function answersMatch(answer: string | undefined, expected: string | undefined, options?: string): boolean {
  const actual = choice(answer);
  const wanted = choice(expected);
  if (!actual || !wanted) return false;
  if (actual === wanted) return true;
  const confirmed = confirmedChoice((answer ?? "").trim());
  if (confirmed) {
    const confirmedNumbers = numericChoices(confirmed);
    const wantedNumbers = recommendedNumbers(expected, options);
    return confirmedNumbers.length && wantedNumbers.length
      ? sameNumbers(confirmedNumbers, wantedNumbers)
      : confirmed === wanted;
  }
  if (affirmativeRecommendation((answer ?? "").trim())) return true;
  if (!/^(?:all|全部)(?=$|[\s:：，,。])/i.test((answer ?? "").trim())) return false;
  const count = numberedOptions(options);
  const selected = recommendedNumbers(expected, options);
  return count > 0 && selected.length === count && selected.every((value, index) => value === index + 1);
}

/** Accepted means semantically equivalent; extended adds options; rewritten changes or removes recommended choices. */
export function classifyAnswer(answer: string | undefined, expected: string | undefined, options?: string): AnswerClassification {
  if (answersMatch(answer, expected, options)) return "accepted";
  const count = numberedOptions(options);
  const wanted = recommendedNumbers(expected, options);
  const all = /^(?:all|全部)(?=$|[\s:：，,。])/i.test((answer ?? "").trim());
  const actual = all && count ? Array.from({ length: count }, (_, index) => index + 1) : numericChoices(choice(answer));
  return wanted.length && actual.length > wanted.length && wanted.every((value) => actual.includes(value))
    ? "extended"
    : "rewritten";
}

/** Decision files can be copied or renamed; metrics count the latest answer for each metadata id once. */
export function dedupeDecisions<T extends { id?: string; answered?: string }>(rows: T[]): T[] {
  const unique = new Map<string, T>();
  rows.forEach((row, index) => {
    const key = row.id || `__missing_id_${index}`;
    const previous = unique.get(key);
    const answered = Date.parse(row.answered ?? "") || 0;
    const previousAnswered = Date.parse(previous?.answered ?? "") || 0;
    if (!previous || answered >= previousAnswered) unique.set(key, row);
  });
  return [...unique.values()];
}
