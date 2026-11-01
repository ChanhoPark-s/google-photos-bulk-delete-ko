/**
 * 정적 점검 전용: Google 포토 로그인 화면에서의 실제 동작은 검증하지 않습니다.
 * 실행: node --test tests/check-source.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync(
  new URL("../delete-photos.js", import.meta.url),
  "utf8"
);

test("브라우저 콘솔 스크립트에 JavaScript 구문 오류가 없다", () => {
  assert.doesNotThrow(() => new Function(script));
});

test("한 번에 선택할 날짜 상한이 10일이다", () => {
  assert.match(script, /maxDatesPerBatch:\s*10\b/);
});

test("화면에 표시된 날짜 전체 선택 체크박스를 사용한다", () => {
  assert.match(script, /\[role="checkbox"\]\.R4HkWb/);
  assert.match(script, /getBoundingClientRect/);
});

test("사용자 요청대로 자동 스크롤을 하지 않는다", () => {
  assert.doesNotMatch(script, /\.scroll(By|To|IntoView)\s*\(/);
});

test("선택, 휴지통 확인, 결과 검증을 차례로 완료하도록 한다", () => {
  assert.match(
    script,
    /await selectVisibleDays\(\)[\s\S]*await confirmTrash\(before, watch\)[\s\S]*await verify\(before, watch\)/
  );
});

test("선택 실패 시 반복 클릭하지 않고 중단한다", () => {
  assert.match(script, /날짜가 선택되지 않아 다음 클릭을 중단/);
});

test("영구 삭제 확인창에서는 자동으로 진행하지 않는다", () => {
  assert.match(script, /isPermanentAction\(dialog\)/);
  assert.match(script, /영구 삭제 확인창 감지/);
});

test("중단 및 상태 확인 명령이 제공된다", () => {
  assert.match(script, /GPDateDeleteKO\s*=/);
  assert.match(script, /stop:\s*\(\)\s*=>/);
  assert.match(script, /status:\s*\(\)\s*=>/);
});

test("사진 업로드 또는 외부 호출 코드를 포함하지 않는다", () => {
  assert.doesNotMatch(script, /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\s*\(/);
});
