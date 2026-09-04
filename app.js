const REFRESH_MS = 15000;
const TICK_MS = 1000;
const TZ = "America/Detroit";
const QUEUE_API =
  "https://eecsoh.eecs.umich.edu/api/queues/1xHcWfn2KW5HHly5Y3rLA2g5kW2";

let queueData = null;
let scheduleData = null;
let lastUpdated = null;

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
  const note = document.getElementById("refresh-note");
  if (!note) return;
  note.textContent = isGitHubPages()
    ? "Queue updates every 2 min on GitHub Pages"
    : "Refreshes every 15s";
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
    hour: "numeric",
    minute: "numeric",
    hour12: false,
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
    if (nearest && nearestDiff <= 30) current = nearest;
  }

  return current;
}

function getScheduleContext() {
  const { day, dayLabel, hour, minute } = nowParts();
  const daySchedule = scheduleData?.schedule?.[day] ?? [];
  const slot = findCurrentSlot(daySchedule, hour, minute);
  const staff = slot?.staff ?? [];
  const staffCount = Math.max(1, slot?.total ?? staff.length ?? 1);

  return { day, dayLabel, daySchedule, slot, staff, staffCount };
}

function estimateWaitSeconds(positionIndex, cooldown, staffCount, helpingCount) {
  const throughput = Math.max(1, Math.max(staffCount, helpingCount));
  return Math.ceil((positionIndex / throughput) * cooldown);
}

function buildStudents(queue, cooldown, staffCount, helpingCount) {
  const waiting = queue.filter((entry) => !entry.helping);
  const helping = queue.filter((entry) => entry.helping);

  const rows = [];

  helping.forEach((entry, index) => {
    rows.push({
      position: index + 1,
      uniqname: getUniqname(entry),
      joinedAt: entry.id_timestamp,
      waitSeconds: waitSecondsSince(entry.id_timestamp),
      estimatedSeconds: 0,
      status: "helping",
    });
  });

  waiting.forEach((entry, index) => {
    const position = helping.length + index + 1;
    rows.push({
      position,
      uniqname: getUniqname(entry),
      joinedAt: entry.id_timestamp,
      waitSeconds: waitSecondsSince(entry.id_timestamp),
      estimatedSeconds: estimateWaitSeconds(index, cooldown, staffCount, helping.length),
      status: "waiting",
    });
  });

  return rows;
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
    .map(
      (name) => `
      <div class="staff-chip">
        <span class="staff-avatar">${name.slice(0, 2).toUpperCase()}</span>
        <span class="staff-name">${name}</span>
      </div>
    `
    )
    .join("");
}

function renderTimeline(daySchedule, currentSlot) {
  const timeline = document.getElementById("timeline");
  if (!daySchedule.length) {
    timeline.innerHTML = '<p class="empty-note">No office hours scheduled today.</p>';
    return;
  }

  timeline.innerHTML = daySchedule
    .map((slot) => {
      const active = currentSlot && currentSlot.time === slot.time;
      const staffText = slot.staff.length ? slot.staff.join(", ") : "—";
      return `
        <article class="timeline-item ${active ? "active" : ""}">
          <div class="timeline-time">${formatSlotRange(slot.time)}</div>
          <div class="timeline-meta">
            <span class="timeline-count">${slot.total} staff</span>
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
  const { dayLabel, daySchedule, slot, staff, staffCount } = getScheduleContext();
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
    ? `${dayLabel} · ${formatSlotRange(slot.time)}`
    : `${dayLabel} · Outside scheduled hours`;

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
  renderTimeline(daySchedule, slot);

  const showUniqnames = data._dashboard?.uniqnames_visible ?? false;
  setUniqnameColumnVisible(showUniqnames);

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
    tr.innerHTML = `
      <td class="position">#${student.position}</td>
      ${showUniqnames ? `<td class="uniqname col-uniqname">${student.uniqname ?? "—"}</td>` : ""}
      <td>${formatClock(student.joinedAt)}</td>
      <td class="wait-time" data-wait="${student.joinedAt}">${formatDuration(student.waitSeconds)}</td>
      <td>${student.status === "helping" ? "—" : `~${formatDuration(student.estimatedSeconds)}`}</td>
      <td><span class="badge ${student.status}">${student.status === "helping" ? "Being helped" : "Waiting"}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function tickWaitTimes() {
  document.querySelectorAll("[data-wait]").forEach((cell) => {
    cell.textContent = formatDuration(waitSecondsSince(cell.dataset.wait));
  });
}

async function fetchSchedule() {
  const url = isGitHubPages() ? assetUrl("schedule.json") : "/api/schedule";
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Could not load staff schedule");
  scheduleData = await resp.json();
}

async function fetchQueue() {
  const errorEl = document.getElementById("error-state");
  try {
    let resp;
    if (isGitHubPages()) {
      resp = await fetch(`${assetUrl("queue-snapshot.json")}?t=${Date.now()}`);
    } else {
      resp = await fetch("/api/queue");
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    queueData = await resp.json();
    lastUpdated = new Date();
    errorEl.hidden = true;
    render(queueData);
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = `Could not load queue data: ${err.message}`;
  }
}

async function init() {
  setRefreshNote();
  try {
    await fetchSchedule();
  } catch (err) {
    document.getElementById("staff-list").innerHTML =
      `<p class="empty-note">${err.message}</p>`;
  }
  await fetchQueue();
}

init();
if (isGitHubPages()) {
  setInterval(fetchQueue, 30000);
} else {
  setInterval(fetchQueue, REFRESH_MS);
}
setInterval(tickWaitTimes, TICK_MS);
