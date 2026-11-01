/*
 * Google Photos 날짜별 일괄 삭제 (한국어/영어)
 * https://github.com/ChanhoPark-s/google-photos-bulk-delete-ko
 * MIT License
 *
 * 브라우저 콘솔에 전체 코드를 붙여넣어 실행합니다.
 * 스크롤하지 않으며, 화면에 보이는 날짜만 순차 처리합니다.
 * 아직 Google Photos의 모든 계정/UI에서 검증되지 않았습니다.
 */
(async () => {
  "use strict";

  const CONFIG = {
    maxDatesPerBatch: 4,       // 한 주기에서 선택할 날짜의 최대 수
    pollMs: 180,              // 상태 확인 간격
    afterClickMs: 120,        // 날짜 체크 후 대기
    dialogTimeoutMs: 10000,   // 확인창 등장 대기
    actionTimeoutMs: 20000,   // 확인창 변경 대기
    manualTimeoutMs: 90000,   // 미인식 버튼 직접 클릭 대기
    verifyTimeoutMs: 45000,   // 화면에서 삭제 반영 확인
    nextBatchDelayMs: 450,    // 다음 주기 전 대기
    maxCycles: 10000
  };

  const DATE_SELECTOR = '[role="checkbox"].R4HkWb';
  const ITEM_SELECTOR = '[role="checkbox"].ckGgle';

  if (location.hostname !== "photos.google.com") {
    console.error("[구글포토] https://photos.google.com/ 에서 실행하세요.");
    return;
  }
  if (window.GPDateDeleteKO?.running) {
    console.warn("[구글포토] 이미 실행 중입니다.");
    return;
  }

  const state = { running: false, stop: false, completedBatches: 0, dateGroups: 0 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log("[구글포토]", ...args);
  const warn = (...args) => console.warn("[구글포토]", ...args);

  const text = el => (
    el?.getAttribute("aria-label") ||
    el?.getAttribute("title") ||
    el?.innerText ||
    el?.textContent || ""
  ).replace(/\s+/g, " ").trim();

  const content = el =>
    (el?.innerText || el?.textContent || "")
      .replace(/\s+/g, " ").trim();

  function rendered(el) {
    if (!el?.isConnected || el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function onScreen(el) {
    if (!rendered(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 &&
      r.top < innerHeight && r.bottom > 0 &&
      r.left < innerWidth && r.right > 0;
  }

  const dateKey = el => el?.getAttribute("aria-label") || text(el);

  function visibleDateButtons() {
    return [...document.querySelectorAll(DATE_SELECTOR)]
      .filter(onScreen);
  }

  function selected() {
    return !!document.querySelector(
      DATE_SELECTOR + '[aria-checked="true"],' +
      ITEM_SELECTOR + '[aria-checked="true"]'
    );
  }

  function activeDialog() {
    const dialogs = [...document.querySelectorAll(
      '[aria-modal="true"],[role="alertdialog"],[role="dialog"]'
    )].filter(el => rendered(el) && el.querySelector("button") &&
      /휴지통|삭제|trash|delete|bin/i.test(content(el)));

    // 가장 안쪽의 관련 대화상자를 우선 사용
    return dialogs.sort((a, b) =>
      a.querySelectorAll("button").length -
      b.querySelectorAll("button").length
    )[0] || null;
  }

  function deleteButton() {
    const candidates = [
      'div[data-delete-origin] button',
      'button[aria-label="휴지통으로 이동"]',
      'button[aria-label="삭제"]',
      'button[aria-label="Move to trash"]',
      'button[aria-label="Move to bin"]',
      'button[aria-label="Delete"]'
    ];

    for (const selector of candidates) {
      const button = [...document.querySelectorAll(selector)].find(el =>
        rendered(el) && !el.disabled &&
        !el.closest('[aria-modal="true"],[role="dialog"],[role="alertdialog"]')
      );
      if (button) return button;
    }
    return null;
  }

  function confirmButton(dialog) {
    const positive = /^(휴지통으로 이동|휴지통에 넣기|삭제|확인|계속|알겠습니다|Move to trash|Move to bin|Delete|OK|Continue)$/i;
    const negative = /취소|닫기|나중에|Cancel|Close|Learn more/i;

    return [...dialog.querySelectorAll('button,[role="button"]')]
      .filter(el => rendered(el) && !el.disabled)
      .find(el => positive.test(text(el)) && !negative.test(text(el))) || null;
  }

  function isPermanentDialog(dialog) {
    return /영구\s*삭제|permanently delete|delete permanently|휴지통이 가득/i
      .test(content(dialog));
  }

  async function until(check, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (state.stop) throw new Error("사용자가 중단했습니다.");
      const result = check();
      if (result) return result;
      await sleep(CONFIG.pollMs);
    }
    return null;
  }

  async function stayInForeground() {
    while (document.hidden && !state.stop) await sleep(400);
    if (state.stop) throw new Error("사용자가 중단했습니다.");
  }

  function batchGone(keys) {
    const existing = new Set(
      [...document.querySelectorAll(DATE_SELECTOR)].map(dateKey)
    );
    return keys.every(key => !existing.has(key));
  }

  // 화면 상태 기준 검증이며 서버의 영구 삭제 여부는 검증하지 못합니다.
  function uiLooksComplete(keys) {
    return batchGone(keys) && !selected() && !activeDialog() && !deleteButton();
  }

  async function selectDates() {
    const keys = [...new Set(visibleDateButtons()
      .filter(el => el.getAttribute("aria-checked") === "false")
      .map(dateKey))]
      .slice(0, CONFIG.maxDatesPerBatch);

    for (const key of keys) {
      await stayInForeground();
      const button = visibleDateButtons().find(el =>
        dateKey(el) === key && el.getAttribute("aria-checked") === "false"
      );
      if (!button) throw new Error("날짜 버튼이 사라졌습니다: " + key);

      button.click();

      const checked = await until(() =>
        [...document.querySelectorAll(DATE_SELECTOR)].some(el =>
          dateKey(el) === key && el.getAttribute("aria-checked") === "true"
        ), 4000);

      if (!checked) throw new Error("날짜 선택 실패: " + key);
      log("날짜 선택:", key);
      await sleep(CONFIG.afterClickMs);
    }
    return keys;
  }

  function showDialogButtons(dialog) {
    console.table([...dialog.querySelectorAll("button")].map(el => ({
      label: text(el), disabled: !!el.disabled
    })));
  }

  async function handleConfirmation(keys) {
    const button = await until(deleteButton, 9000);
    if (!button) throw new Error("상단 휴지통 이동 버튼을 찾지 못했습니다.");
    button.click();
    log("휴지통 이동 버튼 클릭");

    const started = await until(() =>
      activeDialog() || uiLooksComplete(keys), CONFIG.dialogTimeoutMs);

    if (!started) {
      throw new Error("삭제 확인창 또는 삭제 결과를 확인하지 못했습니다.");
    }

    for (let step = 0; step < 4; step++) {
      if (uiLooksComplete(keys)) return;

      const dialog = await until(activeDialog, step === 0 ? 1200 : 1500);
      if (!dialog) break;
      if (isPermanentDialog(dialog)) {
        throw new Error("영구 삭제 안내가 나타났습니다. 자동 진행을 중단합니다.");
      }

      const beforeText = content(dialog);
      const positive = confirmButton(dialog);
      if (positive) {
        log("확인 버튼 클릭:", text(positive));
        positive.click();
        const progressed = await until(() =>
          !rendered(dialog) ||
          content(dialog) !== beforeText ||
          uiLooksComplete(keys), CONFIG.actionTimeoutMs);
        if (!progressed) throw new Error("확인 버튼 클릭 후 화면 변경을 확인하지 못했습니다.");
      } else {
        warn("확인 버튼을 식별하지 못했습니다. 확인창에서 직접 휴지통 이동을 눌러 주세요.");
        showDialogButtons(dialog);
        const progressed = await until(() =>
          !rendered(dialog) ||
          content(dialog) !== beforeText ||
          uiLooksComplete(keys), CONFIG.manualTimeoutMs);
        if (!progressed) {
          throw new Error("확인창 수동 처리 시간이 초과됐습니다.");
        }
      }
      await sleep(300);
    }
  }

  async function verify(keys) {
    log("이전 날짜 제거 및 선택 해제 확인 중...");
    let stable = 0;
    const ok = await until(() => {
      stable = uiLooksComplete(keys) ? stable + 1 : 0;
      return stable >= 4;
    }, CONFIG.verifyTimeoutMs);

    if (!ok) throw new Error(
      "화면에서 삭제 반영을 확인하지 못했습니다. 중복 삭제를 방지하려고 중단합니다."
    );
    log("이번 주기 화면 검증 통과");
  }

  const initial = visibleDateButtons();
  log("현재 화면에서 확인된 날짜:", initial.length);
  if (!initial.length) {
    warn("날짜 선택 버튼을 찾지 못했습니다. 화면을 새로고침하거나 README의 진단 방법을 확인하세요.");
    return;
  }
  if (selected() || activeDialog()) {
    warn("이미 선택된 항목 또는 열린 확인창이 있습니다. F5로 새로고침한 뒤 실행하세요.");
    return;
  }

  if (!confirm(
    "Google 포토의 현재 화면에 보이는 날짜별 사진/동영상을 휴지통으로 이동합니다.\n" +
    "필요한 파일을 백업했고, 동기화된 기기에도 영향을 줄 수 있음을 이해했나요?\n" +
    "스크롤은 하지 않으며, 화면에서 삭제 결과를 확인한 후 다음 날짜를 처리합니다.\n\n" +
    "실제 삭제를 시작하시겠습니까?"
  )) return;

  window.GPDateDeleteKO = {
    stop: () => { state.stop = true; warn("중단 요청됨"); },
    status: () => ({ ...state }),
    get running() { return state.running; }
  };

  state.running = true;

  try {
    log("날짜별 일괄 휴지통 이동 시작 (스크롤 없음)");
    log("중단 명령: window.GPDateDeleteKO.stop()");

    for (let cycle = 0; cycle < CONFIG.maxCycles; cycle++) {
      await stayInForeground();

      const keys = await selectDates();
      if (!keys.length) {
        let appeared = false;
        for (let retry = 0; retry < 5; retry++) {
          await sleep(600);
          if (visibleDateButtons().some(el =>
            el.getAttribute("aria-checked") === "false"
          )) { appeared = true; break; }
        }
        if (!appeared) {
          log("새 날짜가 화면에 나타나지 않아 종료합니다. 전체 라이브러리 삭제를 의미하지 않습니다.");
          break;
        }
        continue;
      }

      log("이번 주기:", keys.length, "개 날짜");
      await handleConfirmation(keys);
      await verify(keys);
      state.completedBatches++;
      state.dateGroups += keys.length;
      log("주기 완료:", state.completedBatches,
          "/ 처리한 날짜 그룹:", state.dateGroups);
      await sleep(CONFIG.nextBatchDelayMs);
    }

    log("작업 종료. 페이지 새로고침 후 남은 사진과 휴지통을 직접 확인하세요.");
  } catch (error) {
    console.error("[구글포토] 안전 중단:", error.message);
    warn("현재 화면과 삭제 확인창을 확인하세요. 중단 시 이미 선택된 항목이 남을 수 있습니다.");
  } finally {
    state.running = false;
  }
})();
