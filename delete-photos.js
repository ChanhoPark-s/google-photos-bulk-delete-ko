/*
 * Google Photos 날짜별 일괄 휴지통 이동 v1.2 (한국어/영어)
 * https://github.com/ChanhoPark-s/google-photos-bulk-delete-ko
 * 주의: 실제 삭제 작업. 중요한 사진은 먼저 백업하세요.
 * 자동 스크롤 없음 / 개별 사진 클릭 없음 / 날짜 선택 -> 삭제 확인 -> 화면 안정화
 */
(async () => {
  "use strict";

  const CFG = {
    maxDatesPerBatch: 10,
    pollMs: 180,
    loadWaitMs: 12000,
    selectWaitMs: 6000,
    dialogWaitMs: 12000,
    settleWaitMs: 45000,
    manualWaitMs: 90000,
    nextBatchMs: 650,
    maxCycles: 10000
  };

  if (location.hostname !== "photos.google.com") {
    console.error("[구글포토] photos.google.com에서 실행하세요.");
    return;
  }
  if (window.GPDateDeleteKO?.running) {
    console.warn("[구글포토] 이전 작업이 실행 중입니다.");
    return;
  }

  const state = {
    running: false, stop: false, step: "준비",
    completedBatches: 0, dateGroups: 0, lastError: null
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log("[구글포토]", ...args);
  const warn = (...args) => console.warn("[구글포토]", ...args);
  const DATE = '[role="checkbox"].R4HkWb';
  const ITEM = '[role="checkbox"].ckGgle';

  function label(el) {
    return (
      el?.getAttribute("aria-label") ||
      el?.getAttribute("title") ||
      el?.innerText ||
      el?.textContent || ""
    ).replace(/\s+/g, " ").trim();
  }

  function shown(el) {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  }

  function dates() {
    // '화면 안에 있는지' 좌표 검사 금지:
    // F12 창/브라우저 크기에 따라 날짜 체크박스가 0개로 오판되는 것을 방지.
    return [...document.querySelectorAll('[role="checkbox"]')].filter(el => {
      const aria = el.getAttribute("aria-label") || "";
      const dateBox = el.matches(DATE) ||
        /모든\s*(사진|항목)\s*선택|Select all photos from/i.test(aria);
      return shown(el) && !el.matches(ITEM) &&
        !el.closest('[role="dialog"],[aria-modal="true"]') &&
        dateBox;
    });
  }

  function dateKey(el) {
    return el.getAttribute("aria-label") || label(el);
  }

  function chosenState() {
    return !!document.querySelector(
      '[role="checkbox"].R4HkWb[aria-checked="true"],' +
      '[role="checkbox"].R4HkWb[aria-checked="mixed"],' +
      ITEM + '[aria-checked="true"]'
    );
  }

  function selectedTotal() {
    const title = document.querySelector("span.rtExYb");
    const m = label(title).replace(/,/g, "").match(/\d+/);
    return m ? Number(m[0]) : null;
  }

  function dialog() {
    const all = [...document.querySelectorAll(
      '[aria-modal="true"],[role="alertdialog"],[role="dialog"]'
    )].filter(el => shown(el) && el.querySelector("button") &&
      /휴지통|삭제|trash|delete|bin/i.test(el.innerText || el.textContent || ""));
    return all.sort((a, b) =>
      a.querySelectorAll("button").length -
      b.querySelectorAll("button").length)[0] || null;
  }

  function deleteButton() {
    for (const css of [
      'div[data-delete-origin] button',
      'button[aria-label="휴지통으로 이동"]',
      'button[aria-label="삭제"]',
      'button[aria-label="Move to trash"]',
      'button[aria-label="Move to bin"]',
      'button[aria-label="Delete"]'
    ]) {
      const found = [...document.querySelectorAll(css)].find(el =>
        shown(el) && !el.disabled &&
        !el.closest('[aria-modal="true"],[role="dialog"],[role="alertdialog"]')
      );
      if (found) return found;
    }
    return null;
  }

  function confirmButton(box) {
    const accept = /^(휴지통으로 이동|휴지통에 넣기|삭제|확인|계속|알겠습니다|Move to trash|Move to bin|Delete|OK|Continue)$/i;
    return [...box.querySelectorAll('button,[role="button"]')].find(el =>
      shown(el) && !el.disabled && accept.test(label(el))) || null;
  }

  function isPermanent(box) {
    return /휴지통이 가득|trash is full|bin is full/i.test(box.innerText || "") ||
      [...box.querySelectorAll("button")].some(el =>
        /^(영구\s*삭제|Permanently delete|Delete permanently)$/i.test(label(el))
      );
  }

  function snapshot() {
    const names = dates().map(dateKey);
    const photoKeys = [...document.querySelectorAll(ITEM)].slice(0, 20).map(el => {
      const tile = el.closest("[data-id],[data-uid],a[href]") || el;
      return [
        label(el),
        tile.getAttribute("data-id") || "",
        tile.getAttribute("data-uid") || "",
        tile.getAttribute("href") || ""
      ].join("|");
    });
    return JSON.stringify({names, photoKeys});
  }

  function completedUI() {
    return !chosenState() && !dialog() && !deleteButton();
  }

  async function until(check, timeoutMs) {
    let deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (state.stop) throw Error("중단 요청");
      if (document.hidden) {
        const start = Date.now();
        while (document.hidden && !state.stop) await sleep(300);
        deadline += Date.now() - start;
        continue;
      }
      const value = check();
      if (value) return value;
      await sleep(CFG.pollMs);
    }
    return null;
  }

  function diagnostic() {
    console.table(
      [...document.querySelectorAll('[role="checkbox"]')].slice(0, 20)
        .map(el => ({
          class: el.className,
          label: (el.getAttribute("aria-label") || "").slice(0, 90),
          checked: el.getAttribute("aria-checked"),
          rendered: shown(el)
        }))
    );
    log("날짜 체크박스 DOM 개수:", dates().length);
    log("개별 사진 체크박스 DOM 개수:",
      document.querySelectorAll(ITEM).length);
  }

  async function selectDates() {
    state.step = "날짜 선택";
    const available = await until(() => {
      const list = dates().filter(el =>
        el.getAttribute("aria-checked") === "false" && dateKey(el));
      return list.length ? list : null;
    }, CFG.loadWaitMs);

    if (!available) return [];

    // 선택된 날짜를 나중에 다시 찾을 수 있도록 라벨로 추적
    const keys = [...new Set(available.map(dateKey))]
      .slice(0, CFG.maxDatesPerBatch);
    const chosen = [];

    for (const key of keys) {
      const button = dates().find(el =>
        dateKey(el) === key && el.getAttribute("aria-checked") === "false"
      );
      if (!button) {
        throw Error("선택 전에 날짜 버튼이 사라졌습니다: " + key);
      }

      const beforeCount = selectedTotal();
      button.click(); // 한 번만 클릭. 재클릭하면 선택이 취소될 수 있음.
      const selectedOK = await until(() => {
        if (dates().some(el =>
          dateKey(el) === key &&
          el.getAttribute("aria-checked") === "true"
        )) return true;
        const afterCount = selectedTotal();
        return beforeCount !== null && afterCount !== null &&
          afterCount > beforeCount;
      }, CFG.selectWaitMs);

      if (!selectedOK) {
        diagnostic();
        throw Error("날짜 선택이 확인되지 않아 중단: " + key);
      }
      chosen.push(key);
      log("선택:", chosen.length + "/" + keys.length, key);
      await sleep(140);
    }
    return chosen;
  }

  async function confirmTrash() {
    state.step = "휴지통 이동";
    const btn = await until(deleteButton, 9000);
    if (!btn) throw Error("휴지통 이동 버튼을 찾지 못했습니다.");
    btn.click();
    log("휴지통 이동 버튼 클릭");

    const start = await until(() =>
      dialog() || completedUI(), CFG.dialogWaitMs);
    if (!start) throw Error("삭제 확인창과 화면 반응을 찾지 못했습니다.");

    for (let n = 0; n < 4; n++) {
      const box = dialog();
      if (!box) return;
      if (isPermanent(box)) {
        throw Error("영구 삭제 확인창이 나타나 자동 진행하지 않습니다.");
      }

      const before = box.innerText || box.textContent || "";
      const yes = confirmButton(box);
      if (yes) {
        log("확인창 처리:", label(yes));
        yes.click();
      } else {
        warn("확인 버튼을 식별하지 못했습니다. 화면에서 직접 확인하세요.");
        console.table([...box.querySelectorAll("button")]
          .map(el => ({button: label(el)})));
      }

      const changed = await until(() =>
        !shown(box) || (box.innerText || box.textContent || "") !== before,
        yes ? 25000 : CFG.manualWaitMs);
      if (!changed) throw Error("확인창이 변경되지 않아 중단합니다.");
      await sleep(250);
      await until(() => !dialog() || dialog() !== box, 1000);
    }

    if (dialog()) throw Error("삭제 확인창이 계속 남아 있습니다.");
  }

  async function verify(before) {
    state.step = "삭제 후 화면 안정화";
    let stableFrom = 0;
    const ok = await until(() => {
      if (!completedUI()) {
        stableFrom = 0;
        return false;
      }
      if (!stableFrom) stableFrom = Date.now();
      return Date.now() - stableFrom >= 1700;
    }, CFG.settleWaitMs);

    if (!ok) throw Error("삭제 후 선택 해제·확인창 종료를 확인하지 못했습니다.");

    if (snapshot() === before) {
      warn("화면 구성이 이전과 같습니다. 실제 삭제 성공을 확인할 수 없어 종료합니다.");
      return false;
    }
    log("이번 주기 UI 상태 확인 완료. 서버의 최종 삭제 여부는 별도 확인 필요.");
    return true;
  }

  if (!dates().length) {
    // 즉시 0개라고 결론 내리지 않고 로딩 시간을 제공
    log("날짜 버튼을 찾는 중... (최대 12초)");
    await until(() => dates().length > 0, CFG.loadWaitMs);
  }
  if (!dates().length) {
    warn("로드된 날짜 선택 버튼이 없습니다. 기본 사진 목록인지 확인하세요.");
    diagnostic();
    return;
  }
  if (chosenState() || dialog()) {
    warn("이미 선택된 항목 또는 확인창이 있습니다. F5로 초기화하세요.");
    return;
  }
  if (!confirm(
    "Google 포토의 사진/동영상을 날짜별로 휴지통으로 이동합니다.\n" +
    "한 번에 최대 10개 날짜를 선택하며 자동 스크롤은 하지 않습니다.\n" +
    "동기화된 기기에도 영향이 갈 수 있으니 필요한 사진을 백업했는지 확인하세요.\n\n" +
    "실제 삭제를 시작할까요?"
  )) return;

  window.GPDateDeleteKO = {
    stop: () => { state.stop = true; warn("중단 요청됨"); },
    status: () => ({...state}),
    get running() { return state.running; }
  };
  state.running = true;
  let lastSnapshot = "";
  let unchangedBatches = 0;

  try {
    log("시작. 날짜 요소", dates().length, "개. 개별 사진 클릭/자동 스크롤 없음.");
    log("중단: window.GPDateDeleteKO.stop()");
    for (let cycle = 0; cycle < CFG.maxCycles; cycle++) {
      if (state.stop) break;
      if (chosenState() || dialog()) {
        throw Error("이전 선택 또는 확인창이 남아 있어 다음 주기를 중단합니다.");
      }
      const before = snapshot();
      const chosen = await selectDates();
      if (!chosen.length) {
        log("현재 로드된 날짜가 없어 종료합니다. 전체 삭제 완료라는 뜻은 아닙니다.");
        diagnostic();
        break;
      }

      await confirmTrash();
      const changed = await verify(before);
      if (!changed) break;

      state.completedBatches++;
      state.dateGroups += chosen.length;
      log("완료 주기:", state.completedBatches,
        "/ 처리한 날짜 그룹:", state.dateGroups);

      const after = snapshot();
      unchangedBatches = after === lastSnapshot ? unchangedBatches + 1 : 0;
      if (unchangedBatches >= 2) {
        warn("동일 화면이 반복되어 안전 중단합니다.");
        break;
      }
      lastSnapshot = after;
      await sleep(CFG.nextBatchMs);
    }
    log("종료. 새로고침해서 남은 사진과 휴지통을 확인하세요.");
  } catch (error) {
    state.lastError = error.message;
    console.error("[구글포토] 안전 중단:", error.message);
  } finally {
    state.running = false;
    state.step = "종료";
  }
})();
