const REFRESH_MS = 15000;
const GITHUB_PAGES_REFRESH_MS = 5000;
const OVERRIDES_REFRESH_MS = 30000;
const SCHEDULE_REFRESH_MS = 300000;
const UI_REFRESH_MS = 10000;
const TICK_MS = 1000;
const TZ = "America/Detroit";
const QUEUE_API =
  "https://eecsoh.eecs.umich.edu/api/queues/1xHcWfn2KW5HHly5Y3rLA2g5kW2";

let queueData = null;
let scheduleData = null;
let lastUpdated = null;
let queueFetchInFlight = false;

function isGitHubPages() {
  return location.hostname.endsWith("github.io");
}

function appBase() {
  if (!isGitHubPages()) return "";

  const parts = location.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "";

  const first = parts[0].replace(/\.html$/, "");
  if (first === "index") return "";

  return `/${first}/`;
}

function assetUrl(name) {
  return `${appBase()}${name}`;
}

function setRefreshNote() {
  const queueNote = document.getElementById("queue-note");
  if (queueNote) {
    queueNote.textContent = isGitHubPages()
      ? "Match your place # or join time from eecsoh"
      : "Names visible when staff session is connected";
  }
}

const THEMES = ["pink", "maize", "light", "dark", "sunrise", "sunset"];
const THEME_KEY = "engr101-dashboard-theme";

function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : "pink";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  const select = document.getElementById("theme-select");
  if (select && select.value !== next) select.value = next;
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved || "pink");
  const select = document.getElementById("theme-select");
  if (select) {
    select.addEventListener("change", (event) => applyTheme(event.target.value));
  }
}

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

function todayDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatDateLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatLiveTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function tickLiveClock() {
  const now = new Date();
  const timeEl = document.getElementById("live-time");
  const dateEl = document.getElementById("live-date");
  if (timeEl) timeEl.textContent = formatLiveTime(now);
  if (dateEl) dateEl.textContent = formatDateLabel(now);
}

function slotOverrideKey(time, dateKey = todayDateKey()) {
  return `${dateKey}_${time}`;
}

function isOverrideForToday(key, dateKey = todayDateKey()) {
  return key.startsWith(`${dateKey}_`);
}

function pruneStaleOverrides(overrides, dateKey = todayDateKey()) {
  const pruned = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (isOverrideForToday(key, dateKey)) {
      pruned[key] = value;
    }
  }
  return pruned;
}

function getLocalStaffOverrides() {
  try {
    return JSON.parse(localStorage.getItem(STAFF_LOCAL_OVERRIDES_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveLocalStaffOverrides(overrides) {
  localStorage.setItem(
    STAFF_LOCAL_OVERRIDES_KEY,
    JSON.stringify(pruneStaleOverrides(overrides))
  );
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
  return normalizeOverrides(pruneStaleOverrides(merged));
}

function staffListsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((name, index) => name === sortedB[index]);
}

function parseOverrideKey(key) {
  const separator = key.indexOf("_");
  if (separator === -1) return null;
  return {
    dateKey: key.slice(0, separator),
    time: key.slice(separator + 1),
  };
}

function getBaseSlotStaff(day, time) {
  const daySchedule = scheduleData?.schedule?.[day] ?? [];
  const slot = daySchedule.find((entry) => entry.time === time);
  return slot?.staff ?? [];
}

function overrideDiffersFromSchedule(day, time, overrideStaff) {
  return !staffListsEqual(overrideStaff ?? [], getBaseSlotStaff(day, time));
}

function normalizeOverrides(overrides) {
  if (!scheduleData?.schedule) return overrides;

  const { day } = nowParts();
  const normalized = { ...overrides };

  for (const [key, value] of Object.entries(normalized)) {
    const parsed = parseOverrideKey(key);
    if (!parsed || !isOverrideForToday(key)) continue;
    if (!overrideDiffersFromSchedule(day, parsed.time, value?.staff)) {
      delete normalized[key];
    }
  }

  return normalized;
}

function isSlotOverridden(day, slot) {
  const override = getStaffOverride(slot.time);
  if (!override) return false;
  return overrideDiffersFromSchedule(day, slot.time, override.staff);
}

function applyStaffOverrides(data) {
  const local = getLocalStaffOverrides();
  const merged = mergeStaffOverrideSources(data, local);
  staffOverrides = {
    overrides: merged,
    updatedAt: data?.updatedAt ?? null,
  };
  saveLocalStaffOverrides(merged);
}

function getStaffOverride(time, dateKey = todayDateKey()) {
  if (!time) return null;
  return staffOverrides.overrides[slotOverrideKey(time, dateKey)] ?? null;
}

function applyOverrideToSlot(day, slot) {
  if (!slot) return null;
  const override = getStaffOverride(slot.time);
  if (!override || !overrideDiffersFromSchedule(day, slot.time, override.staff)) return slot;
  return {
    ...slot,
    staff: [...(override.staff ?? [])],
    total: override.total ?? override.staff?.length ?? slot.total,
  };
}

function staffDisplayName(uniqname, scheduleDataRef = scheduleData) {
  const names = scheduleDataRef?.staff_names ?? {};
  return names[uniqname] ?? uniqname;
}

function allKnownStaff(scheduleDataRef) {
  const names = scheduleDataRef?.staff_names ?? {};
  const uniqnames = new Set(Object.keys(names));
  for (const slots of Object.values(scheduleDataRef?.schedule ?? {})) {
    for (const slot of slots) {
      for (const member of slot.staff ?? []) uniqnames.add(member);
    }
  }
  return [...uniqnames]
    .sort((a, b) => staffDisplayName(a, scheduleDataRef).localeCompare(staffDisplayName(b, scheduleDataRef)))
    .map((uniqname) => ({
      uniqname,
      name: staffDisplayName(uniqname, scheduleDataRef),
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
  const url = isGitHubPages() ? assetUrl("staff-overrides.json") : "/api/staff-overrides";
  const resp = await fetch(`${url}?t=${Date.now()}`);
  if (!resp.ok) {
    applyStaffOverrides({ overrides: {} });
    return;
  }
  applyStaffOverrides(await resp.json());
}

async function publishStaffOverrides(nextOverrides) {
  const todayOverrides = pruneStaleOverrides(nextOverrides);
  const payload = {
    overrides: todayOverrides,
    updatedAt: new Date().toISOString(),
    date: todayDateKey(),
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
    saveLocalStaffOverrides(todayOverrides);
    return { published: true, message: "Saved for everyone (today only)." };
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
    saveLocalStaffOverrides(todayOverrides);
    return { published: true, message: "Published for everyone (today only)." };
  }

  saveLocalStaffOverrides(todayOverrides);
  applyStaffOverrides(payload);
  return {
    published: false,
    message: "Saved on this browser only for today. Ask the admin to add STAFF_PUBLISH_TOKEN for shared updates.",
  };
}

function renderStaffEditList(members, scheduleDataRef) {
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
          <div class="staff-edit-name">${staffDisplayName(uniqname, scheduleDataRef)}</div>
          <div class="staff-edit-uniq">${uniqname}</div>
        </div>
        <button type="button" class="ghost-btn staff-remove-btn" data-uniqname="${uniqname}">Remove</button>
      </div>
    `
    )
    .join("");
}

function initStaffAuth(scheduleDataRef, onChange) {
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
  const slotSelect = document.getElementById("staff-slot-select");

  let editMembers = [];
  let editDay = null;
  let editSlotTime = null;

  function populateAddSelect() {
    if (!addSelect) return;
    const options = allKnownStaff(scheduleDataRef)
      .filter((member) => !editMembers.includes(member.uniqname))
      .map(
        (member) =>
          `<option value="${member.uniqname}">${member.name} (${member.uniqname})</option>`
      )
      .join("");
    addSelect.innerHTML = `<option value="">Add staff member…</option>${options}`;
  }

  function slotByTime(daySchedule, time) {
    return daySchedule.find((slot) => slot.time === time) ?? null;
  }

  function loadEditSlot(day, time) {
    const daySchedule = scheduleDataRef?.schedule?.[day] ?? [];
    const baseSlot = slotByTime(daySchedule, time);
    if (!baseSlot) {
      editMembers = [];
      renderStaffEditList(editMembers, scheduleDataRef);
      populateAddSelect();
      return;
    }
    editDay = day;
    editSlotTime = time;
    const effective = applyOverrideToSlot(day, baseSlot);
    editMembers = [...(effective?.staff ?? [])];
    const dateLabel = formatDateLabel();
    document.getElementById("staff-edit-day-label").textContent = dateLabel;
    document.getElementById("staff-edit-slot-label").textContent =
      `${dateLabel} · ${formatSlotRange(time)}`;
    renderStaffEditList(editMembers, scheduleDataRef);
    populateAddSelect();
  }

  function populateSlotSelect() {
    if (!slotSelect) return false;
    const { day, dayLabel, daySchedule, slot } = getScheduleContext();
    if (!daySchedule.length) {
      slotSelect.innerHTML = "";
      return false;
    }

    slotSelect.innerHTML = daySchedule
      .map(
        (entry) =>
          `<option value="${entry.time}">${formatSlotRange(entry.time)}</option>`
      )
      .join("");

    const defaultTime = slot?.time ?? daySchedule[0].time;
    slotSelect.value = defaultTime;
    document.getElementById("staff-edit-day-label").textContent = formatDateLabel();
    loadEditSlot(day, defaultTime);
    return true;
  }

  function openEditModal() {
    if (editStatus) {
      editStatus.textContent = "";
      editStatus.className = "staff-edit-status";
    }
    openModal("staff-edit-modal");

    if (!populateSlotSelect()) {
      if (editStatus) {
        editStatus.textContent = "No office hours scheduled today to edit.";
        editStatus.className = "staff-edit-status error";
      }
    }
  }

  loginBtn?.addEventListener("click", () => openModal("staff-login-modal"));

  logoutBtn?.addEventListener("click", () => {
    setStaffLoggedIn(false);
  });

  editBtn?.addEventListener("click", openEditModal);

  slotSelect?.addEventListener("change", () => {
    const { day } = getScheduleContext();
    loadEditSlot(day, slotSelect.value);
  });

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
    renderStaffEditList(editMembers, scheduleDataRef);
    populateAddSelect();
  });

  addBtn?.addEventListener("click", () => {
    const uniqname = addSelect?.value;
    if (!uniqname || editMembers.includes(uniqname)) return;
    editMembers.push(uniqname);
    renderStaffEditList(editMembers, scheduleDataRef);
    populateAddSelect();
  });

  editForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editDay || !editSlotTime) {
      if (editStatus) {
        editStatus.textContent = "Pick a time block to edit.";
        editStatus.className = "staff-edit-status error";
      }
      return;
    }
    const key = slotOverrideKey(editSlotTime);
    const next = pruneStaleOverrides({ ...staffOverrides.overrides });
    if (overrideDiffersFromSchedule(editDay, editSlotTime, editMembers)) {
      next[key] = {
        staff: [...editMembers],
        total: editMembers.length,
        updatedAt: new Date().toISOString(),
      };
    } else {
      delete next[key];
    }
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

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatClock(isoString) {
  return new Date(isoString).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelativeJoin(isoString) {
  const seconds = waitSecondsSince(isoString);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m ago` : `${hours}h ago`;
}

function sortQueueEntries(queue) {
  return [...queue].sort((a, b) => {
    const aPinned = Boolean(a.pinned);
    const bPinned = Boolean(b.pinned);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;

    const aHelping = Boolean(a.helping);
    const bHelping = Boolean(b.helping);
    if (aHelping !== bHelping) return aHelping ? -1 : 1;

    const aPriority = a.priority ?? 0;
    const bPriority = b.priority ?? 0;
    if (aPriority !== bPriority) return bPriority - aPriority;

    const aId = a.id ?? "";
    const bId = b.id ?? "";
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

function waitSecondsSince(joinedAt) {
  return (Date.now() - new Date(joinedAt).getTime()) / 1000;
}

function getUniqname(entry) {
  if (entry.uniqname) return entry.uniqname;
  if (entry.username) return entry.username;
  const email = entry.email || entry.student_email;
  if (email) return email.split("@")[0];
  if (entry.name && !entry.name.includes(" ")) return entry.name;
  return null;
}

function setUniqnameColumnVisible(visible) {
  document.querySelectorAll(".col-uniqname").forEach((el) => {
    el.hidden = !visible;
  });
}

function nowParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    day: lookup.weekday.toLowerCase(),
    dayLabel: lookup.weekday,
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
  };
}

function parseTimeToMinutes(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function formatSlotRange(timeStr) {
  const start = parseTimeToMinutes(timeStr);
  const end = start + 30;
  const fmt = (mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const period = h >= 12 ? "PM" : "AM";
    const hour12 = h % 12 || 12;
    return m === 0 ? `${hour12} ${period}` : `${hour12}:${String(m).padStart(2, "0")} ${period}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

function findCurrentSlot(daySchedule, hour, minute) {
  if (!daySchedule?.length) return null;

  const nowMins = hour * 60 + minute;
  let current = null;

  for (const slot of daySchedule) {
    const slotStart = parseTimeToMinutes(slot.time);
    if (nowMins >= slotStart && nowMins < slotStart + 30) {
      current = slot;
      break;
    }
  }

  if (!current) {
    let nearest = null;
    let nearestDiff = Infinity;
    for (const slot of daySchedule) {
      const diff = Math.abs(parseTimeToMinutes(slot.time) - nowMins);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearest = slot;
      }
    }
    if (nearest && nearestDiff <= 90) current = nearest;
  }

  return current;
}

function getScheduleContext() {
  const { day, dayLabel, hour, minute } = nowParts();
  const daySchedule = scheduleData?.schedule?.[day] ?? [];
  const baseSlot = findCurrentSlot(daySchedule, hour, minute);
  const slot = baseSlot ? applyOverrideToSlot(day, baseSlot) : null;
  const staff = slot?.staff ?? [];
  const staffCount = Math.max(1, slot?.total ?? staff.length ?? 1);

  return { day, dayLabel, daySchedule, slot, staff, staffCount };
}

function estimateWaitSeconds(positionIndex, cooldown, staffCount, helpingCount) {
  const throughput = Math.max(1, Math.max(staffCount, helpingCount));
  return Math.ceil((positionIndex / throughput) * cooldown);
}

function buildStudents(queue, cooldown, staffCount, helpingCount) {
  const sorted = sortQueueEntries(queue);
  const helpingActive = sorted.filter((entry) => entry.helping).length;

  return sorted.map((entry, index) => {
    const isHelping = Boolean(entry.helping);
    const waitingIndex = sorted.slice(0, index).filter((item) => !item.helping).length;

    return {
      position: index + 1,
      uniqname: getUniqname(entry),
      joinedAt: entry.id_timestamp,
      waitSeconds: waitSecondsSince(entry.id_timestamp),
      estimatedSeconds: isHelping
        ? 0
        : estimateWaitSeconds(waitingIndex, cooldown, staffCount, helpingActive),
      status: isHelping ? "helping" : "waiting",
      pinned: Boolean(entry.pinned),
      priority: entry.priority ?? 0,
    };
  });
}

function renderStaffList(staff, slot) {
  const container = document.getElementById("staff-list");
  const windowEl = document.getElementById("staff-window");

  if (!slot || staff.length === 0) {
    windowEl.textContent = "No scheduled OH";
    container.innerHTML =
      '<p class="empty-note">No staff scheduled for the current half-hour block.</p>';
    return;
  }

  windowEl.textContent = formatSlotRange(slot.time);
  container.innerHTML = staff
    .map((uniqname) => {
      const fullName = staffDisplayName(uniqname, scheduleData);
      const showUniq = fullName !== uniqname;
      return `
      <div class="staff-chip">
        <span class="staff-name">${fullName}</span>
        ${showUniq ? `<span class="staff-uniq">${uniqname}</span>` : ""}
      </div>
    `;
    })
    .join("");
}

function renderTimeline(daySchedule, currentSlot, day) {
  const timeline = document.getElementById("timeline");
  if (!daySchedule.length) {
    timeline.innerHTML = '<p class="empty-note">No office hours scheduled today.</p>';
    return;
  }

  timeline.innerHTML = daySchedule
    .map((slot) => {
      const effective = applyOverrideToSlot(day, slot) ?? slot;
      const active = currentSlot && currentSlot.time === slot.time;
      const staffText = effective.staff.length
        ? effective.staff.map((uniq) => staffDisplayName(uniq, scheduleData)).join(", ")
        : "—";
      const overridden = isSlotOverridden(day, slot);
      return `
        <article class="timeline-item ${active ? "active" : ""}">
          <div class="timeline-time">${formatSlotRange(slot.time)}${overridden ? ' <span class="override-tag">updated</span>' : ""}</div>
          <div class="timeline-meta">
            <span class="timeline-count">${effective.total} staff</span>
            <span class="timeline-names">${staffText}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function render(data) {
  const queue = data.queue ?? [];
  const cooldown = data.config?.cooldown ?? 600;
  const { day, dayLabel, daySchedule, slot, staff, staffCount } = getScheduleContext();
  const students = buildStudents(queue, cooldown, staffCount, queue.filter((e) => e.helping).length);
  const waiting = students.filter((s) => s.status === "waiting");
  const helping = students.filter((s) => s.status === "helping");

  const waitTimes = waiting.map((s) => s.waitSeconds);
  const avgWait = waitTimes.length ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length : 0;
  const maxWait = waitTimes.length ? Math.max(...waitTimes) : 0;
  const nextEst = waiting.length ? waiting[0].estimatedSeconds : 0;

  const statusEl = document.getElementById("queue-status");
  statusEl.innerHTML = `<span class="status-dot"></span><span>${data.open ? "Queue Open" : "Queue Closed"}</span>`;
  statusEl.className = `status-pill ${data.open ? "open" : "closed"}`;

  document.getElementById("slot-label").textContent = slot
    ? `${formatDateLabel()} · ${formatSlotRange(slot.time)}`
    : `${formatDateLabel()} · Outside scheduled hours`;

  document.getElementById("today-name").textContent = dayLabel;
  document.getElementById("last-updated").textContent = lastUpdated
    ? lastUpdated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : "—";

  document.getElementById("queue-length").textContent = waiting.length;
  document.getElementById("helping-count").textContent = helping.length;
  document.getElementById("staff-count").textContent = slot ? staffCount : "0";
  document.getElementById("avg-wait").textContent = formatDuration(avgWait);
  document.getElementById("max-wait").textContent = formatDuration(maxWait);
  document.getElementById("next-est").textContent =
    waiting.length > 0 ? `~${formatDuration(nextEst)}` : "—";

  renderStaffList(staff, slot);
  renderTimeline(daySchedule, slot, day);

  const showUniqnames = data._dashboard?.uniqnames_visible ?? false;
  setUniqnameColumnVisible(showUniqnames);

  const hintEl = document.getElementById("queue-hint");
  if (hintEl) {
    hintEl.hidden = students.length === 0;
    hintEl.textContent = showUniqnames
      ? "Staff view — student names are shown when your eecsoh session is connected."
      : "On eecsoh, your phone shows your place #. On this board, find the same number — or match the join time shown for each row.";
  }

  const tbody = document.getElementById("queue-body");
  tbody.innerHTML = "";

  if (students.length === 0) {
    document.getElementById("empty-state").hidden = false;
    document.getElementById("queue-table").hidden = true;
    return;
  }

  document.getElementById("empty-state").hidden = true;
  document.getElementById("queue-table").hidden = false;

  students.forEach((student) => {
    const tr = document.createElement("tr");
    if (student.status === "helping") tr.classList.add("row-helping");
    if (student.pinned) tr.classList.add("row-pinned");

    const flags = [];
    if (student.pinned) flags.push('<span class="badge pinned">Pinned</span>');
    if (student.priority !== 0) {
      const sign = student.priority > 0 ? "+" : "";
      flags.push(`<span class="badge priority">Priority ${sign}${student.priority}</span>`);
    }

    tr.innerHTML = `
      <td class="position">#${student.position}</td>
      ${showUniqnames ? `<td class="uniqname col-uniqname">${student.uniqname ?? "—"}</td>` : ""}
      <td class="join-time">
        <span class="join-clock">${formatClock(student.joinedAt)}</span>
        <span class="join-relative" data-join="${student.joinedAt}">${formatRelativeJoin(student.joinedAt)}</span>
      </td>
      <td class="wait-time" data-wait="${student.joinedAt}">${formatDuration(student.waitSeconds)}</td>
      <td>${student.status === "helping" ? "—" : `~${formatDuration(student.estimatedSeconds)}`}</td>
      <td>
        <span class="badge ${student.status}">${student.status === "helping" ? "Being helped" : "Waiting"}</span>
        ${flags.join(" ")}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function tickWaitTimes() {
  document.querySelectorAll("[data-wait]").forEach((cell) => {
    cell.textContent = formatDuration(waitSecondsSince(cell.dataset.wait));
  });
  document.querySelectorAll("[data-join]").forEach((cell) => {
    cell.textContent = formatRelativeJoin(cell.dataset.join);
  });
}

async function fetchSchedule() {
  const url = isGitHubPages() ? assetUrl("schedule.json") : "/api/schedule";
  const resp = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) throw new Error("Could not load staff schedule");
  scheduleData = await resp.json();
  staffOverrides.overrides = normalizeOverrides(staffOverrides.overrides);
  saveLocalStaffOverrides(staffOverrides.overrides);
}

async function refreshStaffOverrides() {
  try {
    await fetchStaffOverrides();
    if (queueData) render(queueData);
  } catch {
    /* keep showing last known overrides */
  }
}

async function refreshSchedule() {
  try {
    await fetchSchedule();
    if (queueData) render(queueData);
  } catch {
    /* keep showing last known schedule */
  }
}

function refreshUIFromCache() {
  if (queueData) render(queueData);
}

async function fetchQueueFromProxy() {
  const proxy = window.QUEUE_PROXY_URL;
  if (!proxy) throw new Error("No queue proxy configured");
  const resp = await fetch(proxy, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Proxy HTTP ${resp.status}`);
  return resp.json();
}

async function fetchQueueFromSnapshot() {
  const resp = await fetch(`${assetUrl("queue-snapshot.json")}?t=${Date.now()}`);
  if (!resp.ok) throw new Error(`Snapshot HTTP ${resp.status}`);
  return resp.json();
}

async function fetchQueue() {
  if (queueFetchInFlight) return;
  queueFetchInFlight = true;

  const errorEl = document.getElementById("error-state");
  try {
    let data;
    if (isGitHubPages()) {
      try {
        data = await fetchQueueFromProxy();
      } catch {
        data = await fetchQueueFromSnapshot();
      }
    } else {
      const resp = await fetch("/api/queue", { cache: "no-store" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      data = await resp.json();
    }
    queueData = data;
    lastUpdated = new Date();
    errorEl.hidden = true;
    render(queueData);
  } catch (err) {
    if (queueData) {
      errorEl.hidden = true;
      render(queueData);
    } else {
      errorEl.hidden = false;
      errorEl.textContent = `Could not load queue data: ${err.message}`;
    }
  } finally {
    queueFetchInFlight = false;
  }
}

async function init() {
  initTheme();
  setRefreshNote();
  updateStaffAuthUI();
  tickLiveClock();

  try {
    await fetchSchedule();
  } catch (err) {
    document.getElementById("staff-list").innerHTML =
      `<p class="empty-note">${err.message}</p>`;
  }

  try {
    await fetchStaffOverrides();
  } catch {
    applyStaffOverrides({ overrides: {} });
  }

  if (scheduleData) {
    initStaffAuth(scheduleData, () => {
      if (queueData) render(queueData);
    });
  }

  await fetchQueue();
}

init();

const queueRefreshMs = isGitHubPages() ? GITHUB_PAGES_REFRESH_MS : REFRESH_MS;
setInterval(fetchQueue, queueRefreshMs);
setInterval(refreshStaffOverrides, OVERRIDES_REFRESH_MS);
setInterval(refreshSchedule, SCHEDULE_REFRESH_MS);
setInterval(refreshUIFromCache, UI_REFRESH_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    fetchQueue();
    refreshStaffOverrides();
  }
});

setInterval(tickWaitTimes, TICK_MS);
setInterval(tickLiveClock, TICK_MS);
