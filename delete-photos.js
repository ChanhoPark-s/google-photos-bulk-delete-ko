/*
 * Google Photos 날짜별 일괄 휴지통 이동 (ko/en), v1.1
 * https://github.com/ChanhoPark-s/google-photos-bulk-delete-ko
 * MIT License
 *
 * 실행 방법: photos.google.com 사진 목록에서 F12 > Console > 전체 붙여넣기.
 * 날짜 선택 -> 휴지통 확인 -> 화면 검증 -> 다음 날짜 순서로 실행합니다.
 * 자동 스크롤 없음. 실제 UI는 계정/언어별로 다를 수 있습니다.
 */
(async () => {
  "use strict";

  const CONFIG = {
    maxDatesPerBatch: 10,        // 요청한 상한: 화면에 보이는 날짜 최대 10개
    maxSelectedItems: 500,       // 선택 인식 시 과도한 일괄 처리 방지(조정 가능)
    pollMs: 180,
    clickDelayMs: 150,
    selectTimeoutMs: 6000,
    dialogTimeoutMs: 12000,
    actionTimeoutMs: 25000,
    manualTimeoutMs: 90000,
    verifyTimeoutMs: 90000,      // 큰 삭제의 반영은 오래 걸릴 수 있음
    nextBatchDelayMs: 700,
    maxCycles: 10000
  };

  const DATE_SELECTOR = '[role="checkbox"].R4HkWb';
  const PHOTO_SELECTOR = '[role="checkbox"].ckGgle';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log("[구글포토]", ...args);
  const warn = (...args) => console.warn("[구글포토]", ...args);

  if (location.hostname !== "photos.google.com") {
    console.error("[구글포토] https://photos.google.com/ 의 사진 목록에서 실행하세요.");
    return;
  }
  if (window.GPDateDeleteKO?.running) {
    warn("이미 삭제 작업이 실행 중입니다.");
    return;
  }

  const status = {
    running: false, stop: false, stage: "준비",
    completedBatches: 0, dateGroups: 0, lastMessage: ""
  };

  function text(el) {
    return (
      el?.getAttribute("aria-label") ||
      el?.getAttribute("title") ||
      el?.innerText ||
      el?.textContent ||
      ""
    ).replace(/\s+/g, " ").trim();
  }
  function bodyText(el) {
    return (el?.innerText || el?.textContent || "")
      .replace(/\s+/g, " ").trim();
  }
  function rendered(el) {
    if (!el?.isConnected || el.getClientRects().length === 0) return false;
    const css = getComputedStyle(el);
    return css.display !== "none" && css.visibility !== "hidden";
  }
  function onScreen(el) {
    if (!rendered(el)) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 &&
      b.bottom > 0 && b.top < innerHeight &&
      b.right > 0 && b.left < innerWidth;
  }
  function dateName(el) {
    return el?.getAttribute("aria-label") || text(el);
  }
  function dateButtons() {
    return [...document.querySelectorAll(DATE_SELECTOR)].filter(onScreen);
  }
  function anySelected() {
    return !!document.querySelector(
      DATE_SELECTOR + '[aria-checked="true"],' +
      DATE_SELECTOR + '[aria-checked="mixed"],' +
      PHOTO_SELECTOR + '[aria-checked="true"]'
    );
  }
  function countSelected() {
    const el = document.querySelector("span.rtExYb");
    const match = text(el).replace(/[,\s]/g, "").match(/\d+/);
    return match ? Number(match[0]) : null;
  }
  function activeDialog() {
    const dialogs = [...document.querySelectorAll(
      '[aria-modal="true"],[role="alertdialog"],[role="dialog"]'
    )].filter(el =>
      rendered(el) && el.querySelector("button") &&
      /휴지통|삭제|trash|delete|bin|계속/i.test(bodyText(el))
    );
    return dialogs.sort((a, b) =>
      a.querySelectorAll("button").length -
      b.querySelectorAll("button").length
    )[0] || null;
  }
  function deleteButton() {
    const selectors = [
      'div[data-delete-origin] button',
      'button[aria-label="휴지통으로 이동"]',
      'button[aria-label="삭제"]',
      'button[aria-label="Move to trash"]',
      'button[aria-label="Move to bin"]',
      'button[aria-label="Delete"]'
    ];
    for (const selector of selectors) {
      const btn = [...document.querySelectorAll(selector)].find(el =>
        rendered(el) && !el.disabled &&
        !el.closest('[aria-modal="true"],[role="dialog"],[role="alertdialog"]')
      );
      if (btn) return btn;
    }
    return null;
  }
  function findConfirm(dialog) {
    const positives = /^(휴지통으로 이동|휴지통에 넣기|삭제|확인|계속|알겠습니다|Move to trash|Move to bin|Delete|OK|Continue)$/i;
    const negatives = /취소|닫기|Cancel|Close|Learn more|나중에/i;
    return [...dialog.querySelectorAll('button,[role="button"]')]
      .filter(el => rendered(el) && !el.disabled)
      .find(el => positives.test(text(el)) && !negatives.test(text(el))) || null;
  }
  function isPermanentAction(dialog) {
    // 일반 안내문의 "30일 후 영구 삭제" 설명까지 위험 행동으로 오인하지 않음.
    const buttons = [...dialog.querySelectorAll('button,[role="button"]')];
    return /휴지통이 가득|trash is full|bin is full/i.test(bodyText(dialog)) ||
      buttons.some(el =>
        /^(영구\s*삭제|Delete permanently|Permanently delete)$/i.test(text(el))
      );
  }
  function photoSignature() {
    // 체크 여부는 제외: 선택/해제 자체를 삭제 완료의 증거로 보지 않음.
    return [...document.querySelectorAll(PHOTO_SELECTOR)].slice(0, 24)
      .map(el => {
        const parent = el.closest("[data-id],[data-uid],a[href]") || el;
        return [
          el.getAttribute("aria-label") || "",
          parent.getAttribute("data-id") || "",
          parent.getAttribute("data-uid") || "",
          parent.getAttribute("href") || ""
        ].join("~");
      }).join("|");
  }
  function takeSnapshot() {
    return {
      dates: [...document.querySelectorAll(DATE_SELECTOR)].map(dateName),
      photos: photoSignature()
    };
  }
  function photoOrDateChanged(before) {
    const now = takeSnapshot();
    const dates = new Set(now.dates);
    return before.dates.some(key => !dates.has(key)) ||
      (before.photos.length > 0 && now.photos !== before.photos);
  }
  function settled() {
    return !activeDialog() && !anySelected() && !deleteButton();
  }
  async function waitFor(fn, timeoutMs, onPoll) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (status.stop) throw new Error("사용자 요청으로 중단됨");
      if (document.hidden) {
        await sleep(400);
        continue;
      }
      const result = fn();
      if (result) return result;
      if (onPoll) onPoll();
      await sleep(CONFIG.pollMs);
    }
    return null;
  }
  async function foreground() {
    while (document.hidden && !status.stop) await sleep(400);
    if (status.stop) throw new Error("사용자 요청으로 중단됨");
  }
  function debug(label) {
    warn(label);
    console.table({
      화면날짜수: dateButtons().length,
      선택된항목존재: anySelected(),
      선택수표시: countSelected(),
      삭제버튼존재: !!deleteButton(),
      확인창존재: !!activeDialog()
    });
  }

  // 토스트를 놓치지 않도록 휴지통 클릭 시점부터 UI 문구 변화를 관찰
  function watchCompletionToast() {
    let moved = false;
    const toastPattern =
      /휴지통으로 이동됨|휴지통으로 이동했습니다|휴지통으로 이동되었습니다|Moved to (the )?(trash|bin)/i;
    function check(node) {
      if (!(node instanceof Element)) return;
      if (node.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')) return;
      if (!node.matches('[role="status"],[role="alert"],[aria-live],.VfPpkd-Sx9Kwc,.snackbar')) return;
      if (toastPattern.test(bodyText(node))) moved = true;
    }
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.target instanceof Element) check(record.target);
        else if (record.target?.parentElement) check(record.target.parentElement);
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          check(node);
          for (const child of node.querySelectorAll(
            '[role="status"],[role="alert"],[aria-live],.snackbar'
          )) check(child);
        }
      }
    });
    observer.observe(document.body, {subtree: true, childList: true, characterData: true});
    return {
      get moved() { return moved; },
      close() { observer.disconnect(); }
    };
  }

  async function selectVisibleDays() {
    status.stage = "날짜 선택";
    const keys = [...new Set(dateButtons()
      .filter(el => el.getAttribute("aria-checked") === "false")
      .map(dateName))]
      .slice(0, CONFIG.maxDatesPerBatch);

    const chosen = [];
    for (const key of keys) {
      await foreground();

      const checkbox = dateButtons().find(el =>
        dateName(el) === key &&
        el.getAttribute("aria-checked") === "false"
      );
      if (!checkbox) {
        throw new Error("날짜 버튼이 로딩 중에 바뀌었습니다: " + key);
      }

      const beforeCount = countSelected();
      checkbox.click(); // 실패 시 무작정 재클릭하지 않음(해제 위험)

      const ok = await waitFor(() => {
        const checked = [...document.querySelectorAll(DATE_SELECTOR)].some(el =>
          dateName(el) === key &&
          el.getAttribute("aria-checked") === "true"
        );
        const afterCount = countSelected();
        const countRising = beforeCount !== null &&
          afterCount !== null && afterCount > beforeCount;
        return checked || countRising;
      }, CONFIG.selectTimeoutMs);

      if (!ok) {
        debug("날짜 선택이 반영되지 않았습니다: " + key);
        throw new Error("날짜가 선택되지 않아 다음 클릭을 중단했습니다: " + key);
      }
      if (!anySelected()) {
        throw new Error("날짜 버튼은 반응했지만 사진 선택 상태가 확인되지 않습니다.");
      }

      chosen.push(key);
      log("날짜 선택", chosen.length + "/" + keys.length, key);

      // 선택 수 UI가 확인되는 경우 과도한 묶음 생성을 차단
      const number = countSelected();
      if (number !== null && number > CONFIG.maxSelectedItems) {
        throw new Error(
          "선택된 항목 " + number + "개가 안전 상한(" + CONFIG.maxSelectedItems +
          ")을 초과했습니다. 이번 삭제는 진행하지 않습니다. 선택 해제 후 묶음 크기를 줄여주세요."
        );
      }
      if (number !== null && number === CONFIG.maxSelectedItems) {
        log("선택 수", number, "장: 이번 묶음 선택 종료");
        break;
      }
      await sleep(CONFIG.clickDelayMs);
    }
    return chosen;
  }

  async function confirmTrash(before, watch) {
    status.stage = "휴지통 확인";
    const btn = await waitFor(deleteButton, 9000);
    if (!btn) throw new Error("선택 후 휴지통 버튼을 찾지 못했습니다.");
    btn.click();
    log("휴지통 이동 버튼 클릭");

    const initial = await waitFor(() =>
      activeDialog() || (settled() && (watch.moved || photoOrDateChanged(before))),
      CONFIG.dialogTimeoutMs
    );
    if (!initial) {
      debug("휴지통 클릭 후 확인창/목록 변화가 감지되지 않았습니다.");
      throw new Error("휴지통 확인창 또는 처리 반영을 확인하지 못했습니다.");
    }
    for (let step = 0; step < 4; step++) {
      if (settled() && (watch.moved || photoOrDateChanged(before))) return;

      const dialog = await waitFor(activeDialog, step === 0 ? 1500 : 1700);
      if (!dialog) break;
      if (isPermanentAction(dialog)) {
        throw new Error("영구 삭제 확인창 감지: 자동 진행하지 않습니다.");
      }

      const oldText = bodyText(dialog);
      const positive = findConfirm(dialog);
      if (positive) {
        log("확인창 진행:", text(positive));
        positive.click();
      } else {
        warn("확인 버튼을 자동으로 식별하지 못했습니다. 화면에서 직접 진행 버튼을 눌러주세요.");
        console.table([...dialog.querySelectorAll("button")]
          .map(b => ({label: text(b), disabled: !!b.disabled})));
      }
      const changed = await waitFor(() =>
        !rendered(dialog) ||
        bodyText(dialog) !== oldText ||
        (settled() && (watch.moved || photoOrDateChanged(before))),
        positive ? CONFIG.actionTimeoutMs : CONFIG.manualTimeoutMs
      );
      if (!changed) throw new Error("확인창 변화가 없어 중단했습니다.");
      await sleep(350);
    }
  }

  async function verify(before, watch) {
    status.stage = "삭제 결과 검증";
    log("삭제 반영 확인: 선택 해제 + 화면 변화/완료 알림을 기다리는 중...");
    let stable = 0;
    let lastLog = Date.now();
    const ok = await waitFor(() => {
      const evidence = watch.moved || photoOrDateChanged(before);
      const ready = settled();
      stable = ready && evidence ? stable + 1 : 0;
      return stable >= 4;
    }, CONFIG.verifyTimeoutMs, () => {
      if (Date.now() - lastLog > 8000) {
        log("확인 대기 중:", {
          단계: status.stage,
          선택됨: anySelected(),
          삭제버튼: !!deleteButton(),
          확인창: !!activeDialog(),
          목록변화: photoOrDateChanged(before),
          삭제알림: watch.moved
        });
        lastLog = Date.now();
      }
    });
    if (!ok) {
      debug("삭제 결과가 불확실합니다.");
      throw new Error(
        "삭제 처리를 확인하지 못했습니다. 같은 날짜를 반복 클릭하지 않고 종료합니다. " +
        "페이지를 새로고침하고 실제 남은 사진을 확인하세요."
      );
    }
    log("✅ 삭제 주기 검증 완료 (웹 화면 기준)");
  }

  const days = dateButtons();
  log("현재 보이는 날짜", days.length, "개 (최대", CONFIG.maxDatesPerBatch, "개/회)");
  if (!days.length) {
    warn("날짜 체크박스가 없습니다. 기본 사진 목록에서 실행했는지 확인하세요.");
    return;
  }
  if (anySelected() || activeDialog()) {
    warn("이미 선택 상태 또는 확인창이 남아 있습니다. F5 새로고침 후 다시 실행하세요.");
    return;
  }
  if (!confirm(
    "Google 포토 날짜별 일괄 휴지통 이동\n\n" +
    "필요한 사진을 백업했고, 동기화된 기기의 사진에도 영향을 줄 수 있음을 확인했나요?\n" +
    "현재 화면에 보이는 날짜 중 최대 10개씩 순차 처리합니다.\n" +
    "자동 스크롤과 영구 삭제는 하지 않습니다.\n\n" +
    "실제 삭제를 시작할까요?"
  )) return;

  window.GPDateDeleteKO = {
    stop: () => { status.stop = true; warn("중단 요청됨"); },
    status: () => ({ ...status }),
    get running() { return status.running; }
  };
  status.running = true;

  try {
    log("시작. 중단: window.GPDateDeleteKO.stop()");
    for (let cycle = 0; cycle < CONFIG.maxCycles; cycle++) {
      await foreground();

      // 이전 주기의 선택이 남아 있다면 다음 날짜를 클릭하지 않음
      if (anySelected() || activeDialog()) {
        throw new Error("이전 주기의 선택/확인창이 남아 있어 안전 중단했습니다.");
      }

      const before = takeSnapshot();
      const chosen = await selectVisibleDays();
      if (!chosen.length) {
        log("현재 화면에 새 날짜가 없어서 종료합니다. 전체 라이브러리 삭제를 의미하지 않습니다.");
        break;
      }

      const watch = watchCompletionToast();
      try {
        await confirmTrash(before, watch);
        await verify(before, watch);
      } finally {
        watch.close();
      }

      status.completedBatches++;
      status.dateGroups += chosen.length;
      log("완료:", status.completedBatches, "회 / 날짜 그룹", status.dateGroups, "개");
      await sleep(CONFIG.nextBatchDelayMs);
    }
    log("종료. 사진 목록을 새로고침하고 휴지통을 직접 확인하세요.");
  } catch (error) {
    status.lastMessage = error.message;
    console.error("[구글포토] 안전 중단:", error.message);
    warn("선택/확인창이 남았으면 직접 확인 후 F5로 초기화하세요.");
  } finally {
    status.running = false;
    status.stage = "종료";
  }
})();
