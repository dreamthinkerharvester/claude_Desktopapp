// 터미널 출력 정렬: 한글·한자 등 넓은 글자는 2칸으로 셉니다
const WIDE = /[ᄀ-ᇿ⺀-鿿가-힣豈-﫿＀-￯]/;

export function displayWidth(text) {
  return [...String(text ?? '')].reduce((w, ch) => w + (WIDE.test(ch) ? 2 : 1), 0);
}

export function pad(text, width) {
  const s = String(text ?? '');
  return s + ' '.repeat(Math.max(1, width - displayWidth(s)));
}
