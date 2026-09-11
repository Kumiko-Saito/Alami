// Tiny synchronous JSON-file store. The event is short-lived so a full
// database is overkill — a flat file with an in-memory mirror is enough,
// and it survives an accidental server restart mid-event.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

const DEFAULT_FIELDS = [
  { key: "nickname", label: "ニックネーム", type: "text", required: true, maxLength: 20, options: [], order: 0 },
  { key: "age", label: "ご年齢", type: "number", required: false, maxLength: 0, options: [], order: 1 },
  { key: "residence", label: "今住んでいる場所", type: "text", required: true, maxLength: 40, options: [], order: 2 },
  { key: "occupation", label: "職業", type: "text", required: true, maxLength: 60, options: [], order: 3 },
  {
    key: "income",
    label: "年収",
    type: "select",
    required: false,
    maxLength: 0,
    options: ["〜400万円", "400万〜600万円", "600万〜800万円", "800万円以上"],
    order: 4,
  },
  { key: "hobby", label: "趣味/最近ハマっていること", type: "text", required: true, maxLength: 100, options: [], order: 5 },
  { key: "holidaySpent", label: "休日の過ごし方", type: "textarea", required: true, maxLength: 200, options: [], order: 6 },
  { key: "refresh", label: "リフレッシュ方法は？", type: "text", required: true, maxLength: 100, options: [], order: 7 },
  { key: "personality", label: "自分の性格を一言で言うと？", type: "text", required: true, maxLength: 60, options: [], order: 8 },
];

function emptyState() {
  return {
    event: {
      active: false,
      epoch: Date.now(), // bumped on a full reset so stale devices know to re-register
      name: "婚活イベント",
      scheduledLabel: "", // free-text note for organizers, e.g. "2026-09-13 14:00〜16:00" — not enforced
      maxNumber: 7, // participants per gender are numbered 1..maxNumber
      maxSelections: 3,
      deleteAfterHours: 24,
      startedAt: null,
      endedAt: null,
      detailsPurgedAt: null,
      adminPasscode: null,
    },
    fieldSchema: DEFAULT_FIELDS.map((f) => ({ ...f })),
    profiles: {}, // "M3"/"F3" -> { number, gender, rawNumber, myoji, fields:{...}, detailsCompleted, createdAt, updatedAt }
    selections: {}, // fromKey -> { targets: [toKey,...], updatedAt }
  };
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const initial = emptyState();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const fresh = emptyState();
    return {
      ...fresh,
      ...parsed,
      event: { ...fresh.event, ...(parsed.event || {}) },
      fieldSchema: Array.isArray(parsed.fieldSchema) && parsed.fieldSchema.length ? parsed.fieldSchema : fresh.fieldSchema,
    };
  } catch {
    return emptyState();
  }
}

let state = load();
let saveTimer = null;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  }, 50);
}

// Strips personal detail fields (age, residence, hobby, ...) from every
// profile once `deleteAfterHours` have passed since the event ended, but
// keeps number/gender/myoji and every selection so match pairs stay
// reviewable by the organizer indefinitely.
function maybePurge() {
  const ev = state.event;
  if (!ev.endedAt || ev.detailsPurgedAt) return;
  const dueAt = ev.endedAt + ev.deleteAfterHours * 3600 * 1000;
  if (Date.now() < dueAt) return;

  for (const profile of Object.values(state.profiles)) {
    profile.fields = {};
    profile.detailsCompleted = false;
  }
  ev.detailsPurgedAt = Date.now();
  persist();
}

module.exports = {
  get state() {
    maybePurge();
    return state;
  },
  save: persist,
  reset({ keepPasscode = true, keepName = true, keepMaxNumber = true, keepFieldSchema = true } = {}) {
    const fresh = emptyState();
    if (keepPasscode) fresh.event.adminPasscode = state.event.adminPasscode;
    if (keepName) fresh.event.name = state.event.name;
    if (keepMaxNumber) fresh.event.maxNumber = state.event.maxNumber;
    if (keepFieldSchema) fresh.fieldSchema = state.fieldSchema;
    fresh.event.epoch = Date.now();
    state = fresh;
    persist();
    return state;
  },
};
