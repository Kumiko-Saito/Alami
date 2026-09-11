(() => {
  const STORAGE_PASSCODE = "konkatsu.admin.passcode";

  const views = {
    setup: document.getElementById("view-setup"),
    login: document.getElementById("view-login"),
    dashboard: document.getElementById("view-dashboard"),
  };

  const el = {
    adminStatus: document.getElementById("admin-status"),
    formSetup: document.getElementById("form-setup"),
    setupPasscode: document.getElementById("setup-passcode"),
    formLogin: document.getElementById("form-login"),
    loginPasscode: document.getElementById("login-passcode"),
    loginError: document.getElementById("login-error"),
    eventControl: document.getElementById("event-control"),
    statProfiles: document.getElementById("stat-profiles"),
    statSelections: document.getElementById("stat-selections"),
    statMatches: document.getElementById("stat-matches"),
    participantsBody: document.getElementById("participants-body"),
    selectionsBody: document.getElementById("selections-body"),
    matchesSection: document.getElementById("matches-section"),
    matchPairs: document.getElementById("match-pairs"),
    runnerUpsSection: document.getElementById("runner-ups-section"),
    runnerUpPairs: document.getElementById("runner-up-pairs"),
    fieldEditorList: document.getElementById("field-editor-list"),
    formAddField: document.getElementById("form-add-field"),
    feNewLabel: document.getElementById("fe-new-label"),
    feNewType: document.getElementById("fe-new-type"),
    feNewOptionsField: document.getElementById("fe-new-options-field"),
    feNewOptions: document.getElementById("fe-new-options"),
    feNewRequired: document.getElementById("fe-new-required"),
    btnEndEvent: document.getElementById("btn-end-event"),
    btnPurgeNow: document.getElementById("btn-purge-now"),
    resetConfirm: document.getElementById("reset-confirm"),
    btnFullReset: document.getElementById("btn-full-reset"),
    detailOverlay: document.getElementById("detail-overlay"),
    detailContent: document.getElementById("detail-content"),
    detailClose: document.getElementById("detail-close"),
    toast: document.getElementById("toast"),
  };

  let passcode = localStorage.getItem(STORAGE_PASSCODE) || "";
  let pollTimer = null;
  let lastStats = null;

  function showView(name) {
    Object.values(views).forEach((v) => (v.hidden = true));
    views[name].hidden = false;
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    setTimeout(() => el.toast.classList.remove("show"), 2200);
  }

  function escapeHTML(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
  }

  const genderLabel = (g) => (g === "male" ? "男性" : "女性");

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (passcode) headers["x-admin-passcode"] = passcode;
    const res = await fetch(path, { ...opts, headers });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  el.formSetup.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = el.setupPasscode.value.trim();
    const { ok } = await api("/api/admin/setup", { method: "POST", body: JSON.stringify({ passcode: value }) });
    if (!ok) {
      toast("設定に失敗しました");
      return;
    }
    passcode = value;
    localStorage.setItem(STORAGE_PASSCODE, passcode);
    startDashboard();
  });

  el.formLogin.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = el.loginPasscode.value;
    const { ok } = await api("/api/admin/login", { method: "POST", body: JSON.stringify({ passcode: value }) });
    if (!ok) {
      el.loginError.hidden = false;
      el.loginError.textContent = "パスコードが違います";
      return;
    }
    passcode = value;
    localStorage.setItem(STORAGE_PASSCODE, passcode);
    startDashboard();
  });

  // ---------- event control ----------

  function renderEventControl(eventState) {
    if (eventState.active) {
      el.adminStatus.hidden = false;
      el.adminStatus.textContent = `稼働中: ${eventState.name}`;
      el.eventControl.innerHTML = `
        <h2 class="display" style="font-size:1.1rem;">${escapeHTML(eventState.name)}</h2>
        ${eventState.scheduledLabel ? `<p class="helper">${escapeHTML(eventState.scheduledLabel)}</p>` : ""}
        <p class="helper">開始: ${eventState.startedAt ? new Date(eventState.startedAt).toLocaleString("ja-JP") : "-"}
          ／ 定員: 男女各${eventState.maxNumber}名 ／ 「気になる」上限: ${eventState.maxSelections}名</p>
      `;
    } else {
      el.adminStatus.hidden = false;
      el.adminStatus.textContent = "停止中";
      const endedNote = eventState.endedAt
        ? `<p class="helper">前回終了: ${new Date(eventState.endedAt).toLocaleString("ja-JP")}${
            eventState.detailsPurgedAt
              ? `／ 詳細情報は削除済み（${new Date(eventState.detailsPurgedAt).toLocaleString("ja-JP")}）`
              : `／ 終了から${eventState.deleteAfterHours}時間後に詳細情報が自動削除されます`
          }</p>`
        : "";
      el.eventControl.innerHTML = `
        <h2 class="display" style="font-size:1.1rem;">イベントを開始</h2>
        <p class="helper">開始すると参加者は本人確認・プロフィール登録ができるようになります。</p>
        ${endedNote}
        <form id="form-start" class="stack" style="margin-top:12px;">
          <div class="field">
            <label for="start-name">イベント名</label>
            <input id="start-name" value="${escapeHTML(eventState.name || "婚活マッチング")}" maxlength="60" />
          </div>
          <div class="field">
            <label for="start-schedule">開催日時（表示用メモ・任意）</label>
            <input id="start-schedule" value="${escapeHTML(eventState.scheduledLabel || "")}" maxlength="60" placeholder="例: 2026-09-13 14:00〜16:00" />
          </div>
          <div class="field">
            <label for="start-max">定員（男女それぞれ何番まで）</label>
            <input id="start-max" type="number" min="1" max="200" value="${eventState.maxNumber || 7}" />
          </div>
          <button type="submit" class="primary">開始する</button>
        </form>
      `;
      document.getElementById("form-start").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("start-name").value;
        const scheduledLabel = document.getElementById("start-schedule").value;
        const maxNumber = document.getElementById("start-max").value;
        const { ok } = await api("/api/admin/event/start", {
          method: "POST",
          body: JSON.stringify({ name, scheduledLabel, maxNumber }),
        });
        if (!ok) {
          toast("開始に失敗しました");
          return;
        }
        toast("イベントを開始しました");
        refresh();
      });
    }
  }

  // ---------- participants / selections / matches ----------

  function renderStats(stats) {
    lastStats = stats;
    el.statProfiles.textContent = stats.totals.profiles;
    el.statSelections.textContent = stats.totals.selections;
    el.statMatches.textContent = stats.totals.matches;

    el.participantsBody.innerHTML = stats.rows
      .map(
        (r) => `
        <tr>
          <td>${genderLabel(r.gender)}</td>
          <td>${r.rawNumber}</td>
          <td>${escapeHTML(r.myoji)}</td>
          <td>${r.detailsCompleted ? "済" : "未"}</td>
          <td><button type="button" class="ghost btn-detail" data-number="${escapeHTML(r.number)}" style="padding:6px 12px;">詳細</button></td>
        </tr>`
      )
      .join("");
    el.participantsBody.querySelectorAll(".btn-detail").forEach((btn) => {
      btn.addEventListener("click", () => openDetail(btn.dataset.number));
    });

    const rankLabels = ["第1希望", "第2希望", "第3希望"];
    el.selectionsBody.innerHTML = stats.selectionRows.length
      ? stats.selectionRows
          .map((row) => {
            const fromLabel = `${genderLabel(row.from.gender)}${row.from.rawNumber} ${escapeHTML(row.from.myoji)}`;
            const targetLabel = row.targets.length
              ? row.targets
                  .map((t, i) => `${rankLabels[i] || ""} ${genderLabel(t.gender)}${t.rawNumber} ${escapeHTML(t.myoji)}`)
                  .join("、")
              : "（未選択）";
            return `<tr><td>${fromLabel}</td><td>${targetLabel}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="2" class="helper">まだ選択がありません</td></tr>`;

    const coupleLine = (pair) =>
      `<div class="pill match" style="justify-content:flex-start; width:fit-content;">
        ${genderLabel(pair.male.gender)}${pair.male.rawNumber} ${escapeHTML(pair.male.myoji)} ⇔ ${genderLabel(
        pair.female.gender
      )}${pair.female.rawNumber} ${escapeHTML(pair.female.myoji)}
        <span class="helper" style="margin-left:6px;">（スコア ${pair.score}）</span>
      </div>`;

    if (!stats.finalCouples.length) {
      el.matchesSection.hidden = true;
    } else {
      el.matchesSection.hidden = false;
      el.matchPairs.innerHTML = stats.finalCouples.map(coupleLine).join("");
    }

    if (!stats.runnerUpCandidates.length) {
      el.runnerUpsSection.hidden = true;
    } else {
      el.runnerUpsSection.hidden = false;
      el.runnerUpPairs.innerHTML = stats.runnerUpCandidates.map(coupleLine).join("");
    }

    renderFieldEditor(stats.fields);
  }

  function openDetail(number) {
    const row = lastStats?.rows.find((r) => r.number === number);
    if (!row) return;
    const schema = lastStats.fields;
    const filled = schema.filter((def) => row.fields[def.key] !== undefined && row.fields[def.key] !== "");
    el.detailContent.innerHTML = `
      <h2 class="display" style="font-size:1.2rem;">${genderLabel(row.gender)} ${row.rawNumber}番　${escapeHTML(row.myoji)}</h2>
      <dl class="profile-rows">
        ${
          filled.length
            ? filled.map((def) => `<dt>${escapeHTML(def.label)}</dt><dd>${escapeHTML(row.fields[def.key])}</dd>`).join("")
            : `<dd class="helper">プロフィール未入力、または削除済みです</dd>`
        }
      </dl>
    `;
    el.detailOverlay.hidden = false;
  }
  el.detailClose.addEventListener("click", () => {
    el.detailOverlay.hidden = true;
  });

  // ---------- field schema editor ----------

  function renderFieldEditor(fields) {
    el.fieldEditorList.innerHTML = fields
      .map((f, i) => {
        const typeLabel = { text: "1行テキスト", textarea: "複数行テキスト", number: "数値", select: "選択式" }[f.type] || f.type;
        const optionsNote = f.type === "select" && f.options?.length ? `（${f.options.join(" / ")}）` : "";
        return `
        <div class="field-editor-row" data-key="${escapeHTML(f.key)}">
          <div>
            <div class="fe-label">${escapeHTML(f.label)}</div>
            <div class="fe-meta">${typeLabel}${f.required ? "・必須" : ""}${escapeHTML(optionsNote)}</div>
          </div>
          <div class="fe-actions">
            <button type="button" class="ghost fe-up" ${i === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="ghost fe-down" ${i === fields.length - 1 ? "disabled" : ""}>↓</button>
            <button type="button" class="ghost fe-delete">削除</button>
          </div>
        </div>`;
      })
      .join("");

    const keys = fields.map((f) => f.key);
    el.fieldEditorList.querySelectorAll(".field-editor-row").forEach((row, i) => {
      const key = row.dataset.key;
      row.querySelector(".fe-up")?.addEventListener("click", async () => {
        const order = [...keys];
        [order[i - 1], order[i]] = [order[i], order[i - 1]];
        await api("/api/admin/fields/reorder", { method: "POST", body: JSON.stringify({ keys: order }) });
        refresh();
      });
      row.querySelector(".fe-down")?.addEventListener("click", async () => {
        const order = [...keys];
        [order[i], order[i + 1]] = [order[i + 1], order[i]];
        await api("/api/admin/fields/reorder", { method: "POST", body: JSON.stringify({ keys: order }) });
        refresh();
      });
      row.querySelector(".fe-delete")?.addEventListener("click", async () => {
        if (!confirm(`「${row.querySelector(".fe-label").textContent}」を削除しますか？`)) return;
        await api(`/api/admin/fields/${encodeURIComponent(key)}`, { method: "DELETE" });
        refresh();
      });
    });
  }

  el.feNewType.addEventListener("change", () => {
    el.feNewOptionsField.hidden = el.feNewType.value !== "select";
  });

  el.formAddField.addEventListener("submit", async (e) => {
    e.preventDefault();
    const type = el.feNewType.value;
    const options = el.feNewOptions.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (type === "select" && options.length < 2) {
      toast("選択肢を2つ以上、1行に1つずつ入力してください");
      return;
    }
    const { ok } = await api("/api/admin/fields", {
      method: "POST",
      body: JSON.stringify({
        label: el.feNewLabel.value,
        type,
        required: el.feNewRequired.checked,
        maxLength: 200,
        options,
      }),
    });
    if (!ok) {
      toast("項目の追加に失敗しました");
      return;
    }
    el.feNewLabel.value = "";
    el.feNewOptions.value = "";
    el.feNewOptionsField.hidden = true;
    el.feNewType.value = "text";
    el.feNewRequired.checked = false;
    toast("項目を追加しました");
    refresh();
  });

  // ---------- polling / lifecycle ----------

  async function refresh() {
    const { ok, data, status } = await api("/api/admin/stats");
    if (!ok) {
      if (status === 401) {
        localStorage.removeItem(STORAGE_PASSCODE);
        passcode = "";
        stopPolling();
        boot();
      }
      return;
    }
    renderEventControl(data.event);
    renderStats(data);
  }

  function startDashboard() {
    showView("dashboard");
    refresh();
    stopPolling();
    pollTimer = setInterval(refresh, 4000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  el.btnEndEvent.addEventListener("click", async () => {
    if (!confirm("イベントを終了しますか？参加者はすぐにアクセスできなくなります。")) return;
    const { ok } = await api("/api/admin/event/end", { method: "POST" });
    if (!ok) {
      toast("終了処理に失敗しました");
      return;
    }
    toast("イベントを終了しました");
    refresh();
  });

  el.btnPurgeNow.addEventListener("click", async () => {
    if (!confirm("プロフィール詳細（年齢・職業など）を今すぐ削除しますか？名字とマッチング結果は残ります。")) return;
    const { ok } = await api("/api/admin/purge-now", { method: "POST" });
    if (!ok) {
      toast("削除に失敗しました");
      return;
    }
    toast("プロフィール詳細を削除しました");
    refresh();
  });

  el.btnFullReset.addEventListener("click", async () => {
    if (el.resetConfirm.value.trim() !== "リセット") {
      toast('確認欄に「リセット」と入力してください');
      return;
    }
    const { ok } = await api("/api/admin/event/full-reset", { method: "POST" });
    if (!ok) {
      toast("リセットに失敗しました");
      return;
    }
    el.resetConfirm.value = "";
    toast("完全リセットしました");
    refresh();
  });

  async function boot() {
    const { data } = await api("/api/event");
    if (!data.hasPasscode) {
      showView("setup");
      return;
    }
    if (!passcode) {
      showView("login");
      return;
    }
    const check = await api("/api/admin/stats");
    if (!check.ok) {
      localStorage.removeItem(STORAGE_PASSCODE);
      passcode = "";
      showView("login");
      return;
    }
    startDashboard();
  }

  boot();
})();
