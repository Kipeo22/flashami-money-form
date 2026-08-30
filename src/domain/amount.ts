export function parseAmountYen(raw: string): number {
  const normalized = raw.normalize('NFKC').replace(/[\s,￥¥円]/g, '');
  if (!/^\d+$/.test(normalized)) {
    throw new Error('金額は日本円の整数で入力してください。例: 12500');
  }

  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw new Error('金額は1円から10億円までで入力してください。');
  }
  return amount;
}
