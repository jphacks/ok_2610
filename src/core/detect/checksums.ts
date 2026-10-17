/** クレジットカード番号の Luhn チェック。13〜19桁で、全桁同じ数字は除く */
export function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** マイナンバー（個人番号）のチェックディジット検証。12桁 */
export function myNumberValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 12) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  const body = digits.slice(0, 11);
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = Number(body[11 - n]);
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const remainder = sum % 11;
  const check = remainder <= 1 ? 0 : 11 - remainder;
  return check === Number(digits[11]);
}
