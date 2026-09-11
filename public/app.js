(() => {
  const STORAGE_NUMBER = "konkatsu.number";
  const STORAGE_EPOCH = "konkatsu.epoch";
  const MYOJI_RE = /^[ぁ-ゖー]{1,20}$/;

  const views = {
    loading: document.getElementById("view-loading"),
    blocked: document.getElementById("view-blocked"),
    register: document.getElementById("view-register"),
    profileForm: document.getElementById("view-profile-form"),
    list: document.getElementById("view-list"),
  };

  const el = {
    eventName: document.getElementById("event-name"),
    myNumberBadge: document.getElementById("my-number-badge"),
    blockedTitle: document.getElementById("blocked-title"),
    blockedMessage: document.getElementById("blocked-message"),
    formRegister: document.getElementById("form-register"),
    genderToggle: document.getElementById("gender-toggle"),
    inputNumber: document.getElementById("input-number"),
    inputMyoji: document.getElementById("input-myoji"),
    registerError: document.getElementById("register-error"),
    profileFormTitle: document.getElementById("profile-form-title"),
    formProfile: document.getElementById("form-profile"),
    profileFields: document.getElementById("profile-fields"),
    myProfileCard: document.getElementById("my-profile-card"),
    rankTitle: document.getElementById("rank-title"),
    rosterList: document.getElementById("roster-list"),
    rankSelects: [0, 1, 2].map((i) => document.getElementById(`rank-select-${i}`)),
    btnConfirmSelection: document.getElementById("btn-confirm-selection"),
    toast: document.getElementById("toast"),
  };

  let myNumber = localStorage.getItem(STORAGE_NUMBER) || "";
  let selectedGender = "";
  let currentRoster = [];
  let currentOpponentGender = "";
  let toastTimer = null;

  function genderWord(g) {
    return g === "male" ? "男性" : "女性";
  }
  function opponentOf(g) {
    return g === "male" ? "female" : "male";
  }

  function showView(name) {
    Object.values(views).forEach((v) => (v.hidden = true));
    views[name].hidden = false;
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
  }

  function escapeHTML(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
  }

  async function api(path, opts) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  function fillNumberOptions(select, maxNumber) {
    select.innerHTML = "";
    for (let i = 1; i <= maxNumber; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = String(i);
      select.appendChild(opt);
    }
  }

  function clearLocalIdentity() {
    localStorage.removeItem(STORAGE_NUMBER);
    localStorage.removeItem(STORAGE_EPOCH);
    myNumber = "";
  }

  function renderBlocked(eventState) {
    el.eventName.textContent = eventState.name || "婚活マッチング";
    el.myNumberBadge.hidden = true;
    if (eventState.endedAt) {
      el.blockedTitle.textContent = "イベントは終了しました";
      el.blockedMessage.textContent = "ご参加ありがとうございました。";
    } else {
      el.blockedTitle.textContent = "まもなく開始します";
      el.blockedMessage.textContent = "スタッフの案内があるまでお待ちください。";
    }
    showView("blocked");
  }

  // ---------- dynamic profile fields ----------

  async function fetchFieldSchema() {
    const { data } = await api("/api/fields");
    return data?.fields || [];
  }

  function fieldInputHTML(def, value) {
    const v = value ?? "";
    if (def.type === "textarea") {
      return `<textarea data-key="${escapeHTML(def.key)}" maxlength="${def.maxLength || 400}" ${
        def.required ? "required" : ""
      }>${escapeHTML(v)}</textarea>`;
    }
    if (def.type === "number") {
      return `<input type="number" data-key="${escapeHTML(def.key)}" value="${escapeHTML(v)}" ${
        def.required ? "required" : ""
      } />`;
    }
    if (def.type === "select") {
      const options = (def.options || [])
        .map((o) => `<option value="${escapeHTML(o)}" ${o === v ? "selected" : ""}>${escapeHTML(o)}</option>`)
        .join("");
      return `<select data-key="${escapeHTML(def.key)}" ${def.required ? "required" : ""}>
        <option value="">選択してください</option>${options}
      </select>`;
    }
    return `<input type="text" data-key="${escapeHTML(def.key)}" maxlength="${def.maxLength || 100}" value="${escapeHTML(
      v
    )}" ${def.required ? "required" : ""} />`;
  }

  async function openProfileForm(profile) {
    const schema = await fetchFieldSchema();
    el.profileFormTitle.textContent = profile?.detailsCompleted ? "プロフィールを編集" : "プロフィール入力";
    el.profileFields.innerHTML = schema
      .map(
        (def) => `
        <div class="field">
          <label>${escapeHTML(def.label)}${def.required ? " *" : ""}</label>
          ${fieldInputHTML(def, profile?.fields?.[def.key])}
        </div>`
      )
      .join("");
    showView("profileForm");
  }

  function profileFieldsHTML(fields, schema) {
    return `<dl class="profile-rows">${schema
      .filter((def) => fields[def.key] !== undefined && fields[def.key] !== "")
      .map((def) => `<dt>${escapeHTML(def.label)}</dt><dd>${escapeHTML(fields[def.key])}</dd>`)
      .join("")}</dl>`;
  }

  // ---------- own profile / list screen ----------

  function renderMyProfile(profile) {
    el.myNumberBadge.hidden = false;
    el.myNumberBadge.textContent = `${genderWord(profile.gender)} ${profile.rawNumber}番`;
    const nickname = profile.fields?.nickname || profile.myoji;
    el.myProfileCard.innerHTML = `
      <div class="profile-head">
        <div class="badge">${escapeHTML(profile.rawNumber)}</div>
        <div class="names">
          <span class="nickname">${escapeHTML(nickname)}</span>
          <span class="meta">あなたのプロフィール</span>
        </div>
      </div>
      <button class="ghost" id="btn-edit-profile" style="margin-top:6px;">プロフィールを編集</button>
    `;
    document.getElementById("btn-edit-profile").addEventListener("click", () => openProfileForm(profile));
  }

  async function toggleRosterDetail(row, key, exists) {
    const detail = row.querySelector(".roster-detail");
    const isOpen = row.classList.toggle("open");
    detail.hidden = !isOpen;
    if (!isOpen || detail.dataset.loaded) return;

    if (!exists) {
      detail.innerHTML = `<p class="helper" style="padding-top:12px;">まだ登録されていません。</p>`;
      detail.dataset.loaded = "1";
      return;
    }
    const [{ data: profileRes }, schema] = await Promise.all([
      api(`/api/profile/${encodeURIComponent(key)}`),
      fetchFieldSchema(),
    ]);
    if (profileRes?.exists) {
      detail.innerHTML = profileFieldsHTML(profileRes.profile.fields, schema);
    } else {
      detail.innerHTML = `<p class="helper" style="padding-top:12px;">まだ登録されていません。</p>`;
    }
    detail.dataset.loaded = "1";
  }

  function renderRoster(roster, opponentGender) {
    el.rosterList.innerHTML = roster
      .map((r) => {
        const key = (opponentGender === "male" ? "M" : "F") + r.rawNumber;
        return `
        <div class="roster-row" data-key="${escapeHTML(key)}">
          <div class="roster-head">
            <button type="button" class="roster-toggle">
              <span class="badge">${r.rawNumber}</span>
              <span class="name">${genderWord(opponentGender)} ${r.rawNumber}番${r.exists ? "" : "（未登録）"}</span>
              <span class="chev">▾</span>
            </button>
          </div>
          <div class="roster-detail" hidden></div>
        </div>`;
      })
      .join("");

    el.rosterList.querySelectorAll(".roster-row").forEach((row) => {
      const key = row.dataset.key;
      const exists = roster.find((r) => (opponentGender === "male" ? "M" : "F") + r.rawNumber === key)?.exists;
      row.querySelector(".roster-toggle").addEventListener("click", () => toggleRosterDetail(row, key, exists));
    });
  }

  // ---------- ranked "気になる" selection (1st〜3rd choice) ----------

  function renderRankSelects(currentTargets) {
    const chosen = el.rankSelects.map((sel) => sel.value);

    el.rankSelects.forEach((select, i) => {
      const keep = currentTargets[i] || "";
      const options = currentRoster
        .filter((r) => r.exists)
        .filter((r) => {
          const key = (currentOpponentGender === "male" ? "M" : "F") + r.rawNumber;
          return key === keep || !chosen.includes(key);
        })
        .map((r) => {
          const key = (currentOpponentGender === "male" ? "M" : "F") + r.rawNumber;
          return `<option value="${key}" ${key === keep ? "selected" : ""}>${genderWord(currentOpponentGender)} ${r.rawNumber}番</option>`;
        })
        .join("");
      select.innerHTML = `<option value="">選ばない</option>${options}`;
      select.value = keep;
    });
  }

  el.rankSelects.forEach((select) => {
    select.addEventListener("change", () => renderRankSelects(el.rankSelects.map((s) => s.value)));
  });

  async function refreshMain() {
    const { ok, status, data } = await api(`/api/profile/${encodeURIComponent(myNumber)}`);
    if (status === 409) {
      clearLocalIdentity();
      const { data: eventState } = await api("/api/event");
      renderBlocked(eventState);
      return;
    }
    if (!ok || !data || !data.exists) {
      clearLocalIdentity();
      showView("register");
      return;
    }
    if (!data.profile.detailsCompleted) {
      await openProfileForm(data.profile);
      return;
    }

    const opponentGender = opponentOf(data.profile.gender);
    currentOpponentGender = opponentGender;
    renderMyProfile(data.profile);
    el.rankTitle.textContent = `希望順位を選んでください（${genderWord(opponentGender)}）`;

    const [{ data: rosterData }, { data: selData }] = await Promise.all([
      api(`/api/roster/${opponentGender}`),
      api(`/api/myselections/${encodeURIComponent(myNumber)}`),
    ]);
    currentRoster = rosterData?.roster || [];
    renderRoster(currentRoster, opponentGender);
    const existing = selData?.targets || [];
    renderRankSelects([existing[0] || "", existing[1] || "", existing[2] || ""]);
    showView("list");
  }

  el.genderToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".gender-btn");
    if (!btn) return;
    selectedGender = btn.dataset.gender;
    el.genderToggle.querySelectorAll(".gender-btn").forEach((b) => b.classList.toggle("selected", b === btn));
  });

  el.formRegister.addEventListener("submit", async (e) => {
    e.preventDefault();
    el.registerError.hidden = true;

    if (!selectedGender) {
      el.registerError.hidden = false;
      el.registerError.textContent = "性別を選択してください";
      return;
    }
    const rawNumber = Number(el.inputNumber.value);
    const myoji = el.inputMyoji.value.trim();
    if (!MYOJI_RE.test(myoji)) {
      el.registerError.hidden = false;
      el.registerError.textContent = "名字はひらがなのみで入力してください";
      return;
    }

    const { ok, status, data } = await api("/api/identify", {
      method: "POST",
      body: JSON.stringify({ gender: selectedGender, rawNumber, myoji }),
    });
    if (!ok) {
      el.registerError.hidden = false;
      el.registerError.textContent =
        status === 401
          ? "番号と名字の組み合わせが確認できません。受付にご確認ください。"
          : "入力内容をご確認ください。";
      return;
    }

    const { data: eventState } = await api("/api/event");
    myNumber = data.profile.number;
    localStorage.setItem(STORAGE_NUMBER, myNumber);
    localStorage.setItem(STORAGE_EPOCH, String(eventState.epoch));

    if (data.profile.detailsCompleted) {
      await refreshMain();
    } else {
      await openProfileForm(data.profile);
    }
  });

  el.formProfile.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fields = {};
    el.profileFields.querySelectorAll("[data-key]").forEach((input) => {
      fields[input.dataset.key] = input.value;
    });
    const { ok, data } = await api("/api/profile", { method: "POST", body: JSON.stringify({ number: myNumber, fields }) });
    if (!ok) {
      toast(data?.error === "missing_required_field" ? "必須項目を入力してください" : "保存に失敗しました");
      return;
    }
    toast("保存しました");
    await refreshMain();
  });

  el.btnConfirmSelection.addEventListener("click", async () => {
    const targets = el.rankSelects.map((s) => s.value).filter(Boolean);
    el.btnConfirmSelection.disabled = true;
    const { ok } = await api("/api/selections", {
      method: "POST",
      body: JSON.stringify({ from: myNumber, targets }),
    });
    el.btnConfirmSelection.disabled = false;
    toast(ok ? "決定しました" : "保存に失敗しました");
  });

  async function boot() {
    showView("loading");
    const { data: eventState } = await api("/api/event");
    el.eventName.textContent = eventState.name || "婚活マッチング";

    if (!eventState.active) {
      renderBlocked(eventState);
      return;
    }

    const storedEpoch = localStorage.getItem(STORAGE_EPOCH);
    if (!myNumber || String(eventState.epoch) !== storedEpoch) {
      clearLocalIdentity();
      selectedGender = "";
      el.genderToggle.querySelectorAll(".gender-btn").forEach((b) => b.classList.remove("selected"));
      el.inputMyoji.value = "";
      fillNumberOptions(el.inputNumber, eventState.maxNumber);
      showView("register");
      return;
    }

    await refreshMain();
  }

  boot();
})();
