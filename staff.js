const STAFF_USER = "engr101staff";
const STAFF_PASS_HASH = "2b80e2889a934d5fd0955e292e050796392176d32870c74267506f07809b7fc1";
const STAFF_SESSION_KEY = "engr101-staff-session";
const STAFF_LOCAL_OVERRIDES_KEY = "engr101-staff-overrides";

let staffOverrides = { overrides: {}, updatedAt: null };
let staffLoggedIn = false;

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isStaffLoggedIn() {
  return staffLoggedIn || sessionStorage.getItem(STAFF_SESSION_KEY) === "1";
}

function setStaffLoggedIn(loggedIn) {
  staffLoggedIn = loggedIn;
  if (loggedIn) sessionStorage.setItem(STAFF_SESSION_KEY, "1");
  else sessionStorage.removeItem(STAFF_SESSION_KEY);
  updateStaffAuthUI();
}

function slotOverrideKey(day, time) {
  return `${day}-${time}`;
}

function getLocalStaffOverrides() {
  try {
    return JSON.parse(localStorage.getItem(STAFF_LOCAL_OVERRIDES_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveLocalStaffOverrides(overrides) {
  localStorage.setItem(STAFF_LOCAL_OVERRIDES_KEY, JSON.stringify(overrides));
}

function mergeStaffOverrideSources(remote, local) {
  const merged = { ...(remote?.overrides ?? {}) };
  for (const [key, value] of Object.entries(local ?? {})) {
    const remoteUpdated = merged[key]?.updatedAt ?? "";
    const localUpdated = value?.updatedAt ?? "";
    if (!merged[key] || localUpdated > remoteUpdated) {
      merged[key] = value;
    }
  }
  return merged;
}

function applyStaffOverrides(data) {
  const local = getLocalStaffOverrides();
  staffOverrides = {
    overrides: mergeStaffOverrideSources(data, local),
    updatedAt: data?.updatedAt ?? null,
  };
}

function getStaffOverride(day, time) {
  if (!day || !time) return null;
  return staffOverrides.overrides[slotOverrideKey(day, time)] ?? null;
}

function applyOverrideToSlot(day, slot) {
  if (!slot) return null;
  const override = getStaffOverride(day, slot.time);
  if (!override) return slot;
  return {
    ...slot,
    staff: [...(override.staff ?? [])],
    total: override.total ?? override.staff?.length ?? slot.total,
  };
}

function staffDisplayName(uniqname, scheduleData) {
  const names = scheduleData?.staff_names ?? {};
  return names[uniqname] ?? uniqname;
}

function allKnownStaff(scheduleData) {
  const names = scheduleData?.staff_names ?? {};
  const uniqnames = new Set(Object.keys(names));
  for (const slots of Object.values(scheduleData?.schedule ?? {})) {
    for (const slot of slots) {
      for (const member of slot.staff ?? []) uniqnames.add(member);
    }
  }
  return [...uniqnames]
    .sort((a, b) => staffDisplayName(a, scheduleData).localeCompare(staffDisplayName(b, scheduleData)))
    .map((uniqname) => ({
      uniqname,
      name: staffDisplayName(uniqname, scheduleData),
    }));
}

function updateStaffAuthUI() {
  const loginBtn = document.getElementById("staff-login-btn");
  const staffBar = document.getElementById("staff-bar");
  const loggedIn = isStaffLoggedIn();
  if (loginBtn) loginBtn.hidden = loggedIn;
  if (staffBar) staffBar.hidden = !loggedIn;
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.hidden = false;
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.hidden = true;
}

function bindModalDismiss() {
  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.dataset.closeModal));
  });
  document.querySelectorAll(".modal-backdrop").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (event.target === el) el.hidden = true;
    });
  });
}

async function fetchStaffOverrides() {
  const url = typeof assetUrl === "function" ? assetUrl("staff-overrides.json") : "/api/staff-overrides";
  const resp = await fetch(`${url}?t=${Date.now()}`);
  if (!resp.ok) {
    applyStaffOverrides({ overrides: {} });
    return;
  }
  applyStaffOverrides(await resp.json());
}

async function publishStaffOverrides(nextOverrides) {
  const payload = {
    overrides: nextOverrides,
    updatedAt: new Date().toISOString(),
  };

  if (!isGitHubPages()) {
    const resp = await fetch("/api/staff-overrides", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Staff-Auth": sessionStorage.getItem(STAFF_SESSION_KEY) === "1" ? "ok" : "",
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Save failed (${resp.status})`);
    }
    applyStaffOverrides(await resp.json());
    saveLocalStaffOverrides(nextOverrides);
    return { published: true, message: "Saved for everyone." };
  }

  const cfg = window.STAFF_PUBLISH ?? {};
  if (cfg.token) {
    const path = "staff-overrides.json";
    const body = JSON.stringify(payload, null, 2);
    const content = btoa(unescape(encodeURIComponent(body)));
    const headers = {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };

    let sha;
    const current = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, { headers });
    if (current.ok) sha = (await current.json()).sha;

    const putResp = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: "Update staff on duty overrides",
        content,
        sha,
      }),
    });
    if (!putResp.ok) {
      const err = await putResp.json().catch(() => ({}));
      throw new Error(err.message || `Publish failed (${putResp.status})`);
    }
    applyStaffOverrides(payload);
    saveLocalStaffOverrides(nextOverrides);
    return { published: true, message: "Published for everyone." };
  }

  saveLocalStaffOverrides(nextOverrides);
  applyStaffOverrides(payload);
  return {
    published: false,
    message: "Saved on this browser only. Ask the admin to add STAFF_PUBLISH_TOKEN for shared updates.",
  };
}

function renderStaffEditList(members, scheduleData) {
  const list = document.getElementById("staff-edit-list");
  if (!list) return;
  if (!members.length) {
    list.innerHTML = '<p class="empty-note">No staff selected for this block.</p>';
    return;
  }
  list.innerHTML = members
    .map(
      (uniqname) => `
      <div class="staff-edit-row">
        <div>
          <div class="staff-edit-name">${staffDisplayName(uniqname, scheduleData)}</div>
          <div class="staff-edit-uniq">${uniqname}</div>
        </div>
        <button type="button" class="ghost-btn staff-remove-btn" data-uniqname="${uniqname}">Remove</button>
      </div>
    `
    )
    .join("");
}

function initStaffAuth(scheduleData, onChange) {
  staffLoggedIn = sessionStorage.getItem(STAFF_SESSION_KEY) === "1";
  bindModalDismiss();
  updateStaffAuthUI();

  const loginBtn = document.getElementById("staff-login-btn");
  const logoutBtn = document.getElementById("staff-logout-btn");
  const editBtn = document.getElementById("staff-edit-btn");
  const loginForm = document.getElementById("staff-login-form");
  const editForm = document.getElementById("staff-edit-form");
  const addSelect = document.getElementById("staff-add-select");
  const addBtn = document.getElementById("staff-add-btn");
  const editStatus = document.getElementById("staff-edit-status");

  let editMembers = [];

  function populateAddSelect() {
    if (!addSelect) return;
    const options = allKnownStaff(scheduleData)
      .filter((member) => !editMembers.includes(member.uniqname))
      .map(
        (member) =>
          `<option value="${member.uniqname}">${member.name} (${member.uniqname})</option>`
      )
      .join("");
    addSelect.innerHTML = `<option value="">Add staff member…</option>${options}`;
  }

  function openEditModal() {
    const { day, dayLabel, slot } = getScheduleContext();
    if (!slot) {
      if (editStatus) editStatus.textContent = "No active office hours block to edit.";
      return;
    }
    const effective = applyOverrideToSlot(day, slot);
    editMembers = [...(effective?.staff ?? [])];
    document.getElementById("staff-edit-slot-label").textContent = `${dayLabel} · ${formatSlotRange(slot.time)}`;
    renderStaffEditList(editMembers, scheduleData);
    populateAddSelect();
    if (editStatus) editStatus.textContent = "";
    openModal("staff-edit-modal");
  }

  loginBtn?.addEventListener("click", () => openModal("staff-login-modal"));

  logoutBtn?.addEventListener("click", () => {
    setStaffLoggedIn(false);
  });

  editBtn?.addEventListener("click", openEditModal);

  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const user = document.getElementById("staff-username").value.trim();
    const pass = document.getElementById("staff-password").value;
    const errorEl = document.getElementById("staff-login-error");
    const hash = await sha256(pass);
    if (user === STAFF_USER && hash === STAFF_PASS_HASH) {
      setStaffLoggedIn(true);
      if (errorEl) errorEl.textContent = "";
      closeModal("staff-login-modal");
      loginForm.reset();
      return;
    }
    if (errorEl) errorEl.textContent = "Wrong username or password.";
  });

  document.getElementById("staff-edit-list")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".staff-remove-btn");
    if (!btn) return;
    editMembers = editMembers.filter((uniqname) => uniqname !== btn.dataset.uniqname);
    renderStaffEditList(editMembers, scheduleData);
    populateAddSelect();
  });

  addBtn?.addEventListener("click", () => {
    const uniqname = addSelect?.value;
    if (!uniqname || editMembers.includes(uniqname)) return;
    editMembers.push(uniqname);
    renderStaffEditList(editMembers, scheduleData);
    populateAddSelect();
  });

  editForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const { day, slot } = getScheduleContext();
    if (!slot) return;
    const key = slotOverrideKey(day, slot.time);
    const next = { ...staffOverrides.overrides };
    next[key] = {
      staff: [...editMembers],
      total: editMembers.length,
      updatedAt: new Date().toISOString(),
    };
    if (editStatus) {
      editStatus.textContent = "Saving…";
      editStatus.className = "staff-edit-status";
    }
    try {
      const result = await publishStaffOverrides(next);
      if (editStatus) {
        editStatus.textContent = result.message;
        editStatus.className = `staff-edit-status ${result.published ? "ok" : "warn"}`;
      }
      closeModal("staff-edit-modal");
      onChange?.();
    } catch (err) {
      if (editStatus) {
        editStatus.textContent = err.message;
        editStatus.className = "staff-edit-status error";
      }
    }
  });
}
