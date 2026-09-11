const path = require("path");
const crypto = require("crypto");
const express = require("express");
const store = require("./store");

const app = express();
const PORT = process.env.PORT || 3000;
const KEY_RE = /^[MF][1-9][0-9]*$/;
const MYOJI_RE = /^[ぁ-ゖー]{1,20}$/; // hiragana only
const FIELD_TYPES = new Set(["text", "textarea", "number", "select"]);

function sanitizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => (typeof o === "string" ? o.trim().slice(0, 40) : ""))
    .filter(Boolean)
    .slice(0, 20);
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function db() {
  return store.state;
}

function requireAdmin(req, res, next) {
  const passcode = db().event.adminPasscode;
  if (!passcode) return res.status(409).json({ error: "not_set_up" });
  const provided = req.get("x-admin-passcode");
  if (provided !== passcode) return res.status(401).json({ error: "unauthorized" });
  next();
}

function composeKey(gender, rawNumber) {
  return (gender === "male" ? "M" : "F") + rawNumber;
}

function opponentGender(gender) {
  return gender === "male" ? "female" : "male";
}

function sortedFields(state) {
  return [...state.fieldSchema].sort((a, b) => a.order - b.order);
}

function publicProfile(p) {
  if (!p) return null;
  const { number, gender, rawNumber, myoji, fields, detailsCompleted } = p;
  return { number, gender, rawNumber, myoji, fields: { ...fields }, detailsCompleted: Boolean(detailsCompleted) };
}

function summary(p) {
  if (!p) return null;
  return { number: p.number, gender: p.gender, rawNumber: p.rawNumber, myoji: p.myoji };
}

// Position in the ranked targets array (0 = 第1希望) converts to points.
const RANK_POINTS = [3, 2, 1];

function rankPoints(state, from, to) {
  const idx = state.selections[from]?.targets.indexOf(to);
  return idx !== undefined && idx >= 0 ? RANK_POINTS[idx] || 0 : 0;
}

// Resolves every mutual (both ranked each other in their top 3) candidate
// pair down to one couple per person: highest combined preference score
// wins, and a tie is broken in favor of whichever pair the WOMAN ranked
// more highly — the organizer's requested tie-break rule.
function computeFinalCouples(state) {
  const profiles = Object.values(state.profiles);
  const males = profiles.filter((p) => p.gender === "male");
  const females = profiles.filter((p) => p.gender === "female");

  const candidates = [];
  for (const m of males) {
    for (const f of females) {
      const mPts = rankPoints(state, m.number, f.number);
      const fPts = rankPoints(state, f.number, m.number);
      if (mPts > 0 && fPts > 0) {
        candidates.push({ male: summary(m), female: summary(f), mPts, fPts, score: mPts + fPts });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.fPts - a.fPts);

  const usedMale = new Set();
  const usedFemale = new Set();
  const couples = [];
  const runnerUps = [];
  for (const c of candidates) {
    if (usedMale.has(c.male.number) || usedFemale.has(c.female.number)) {
      runnerUps.push(c);
      continue;
    }
    usedMale.add(c.male.number);
    usedFemale.add(c.female.number);
    couples.push(c);
  }

  return { couples, runnerUps };
}

// ---------- event status ----------

app.get("/api/event", (req, res) => {
  const { active, epoch, name, maxNumber, maxSelections, scheduledLabel, endedAt } = db().event;
  res.json({
    active,
    epoch,
    name,
    maxNumber,
    maxSelections,
    scheduledLabel,
    endedAt,
    hasPasscode: Boolean(db().event.adminPasscode),
  });
});

app.get("/api/fields", (req, res) => {
  res.json({ fields: sortedFields(db()) });
});

// ---------- identity (gender + number + surname-in-hiragana) ----------

app.post("/api/identify", (req, res) => {
  const state = db();
  if (!state.event.active) return res.status(409).json({ error: "event_inactive" });

  const { gender, rawNumber, myoji } = req.body || {};
  const maxNumber = state.event.maxNumber;
  const num = Number(rawNumber);

  if (gender !== "male" && gender !== "female") {
    return res.status(400).json({ error: "invalid_gender" });
  }
  if (!Number.isInteger(num) || num < 1 || num > maxNumber) {
    return res.status(400).json({ error: "invalid_number" });
  }
  if (typeof myoji !== "string" || !MYOJI_RE.test(myoji.trim())) {
    return res.status(400).json({ error: "invalid_myoji" });
  }

  const key = composeKey(gender, num);
  const normalizedMyoji = myoji.trim();
  const existing = state.profiles[key];

  if (!existing) {
    const now = Date.now();
    state.profiles[key] = {
      number: key,
      gender,
      rawNumber: num,
      myoji: normalizedMyoji,
      fields: {},
      detailsCompleted: false,
      createdAt: now,
      updatedAt: now,
    };
    store.save();
    return res.json({ ok: true, isNew: true, profile: publicProfile(state.profiles[key]) });
  }

  if (existing.myoji !== normalizedMyoji) {
    return res.status(401).json({ error: "myoji_mismatch" });
  }
  res.json({ ok: true, isNew: false, profile: publicProfile(existing) });
});

// ---------- participant profile details ----------

app.post("/api/profile", (req, res) => {
  const state = db();
  if (!state.event.active) return res.status(409).json({ error: "event_inactive" });

  const { number, fields } = req.body || {};
  if (typeof number !== "string" || !KEY_RE.test(number)) {
    return res.status(400).json({ error: "invalid_number" });
  }
  const profile = state.profiles[number];
  if (!profile) return res.status(404).json({ error: "not_identified" });
  if (typeof fields !== "object" || fields === null) {
    return res.status(400).json({ error: "invalid_fields" });
  }

  const schema = sortedFields(state);
  const cleaned = {};
  for (const def of schema) {
    const raw = fields[def.key];
    if (def.type === "number") {
      const n = raw === "" || raw === undefined || raw === null ? "" : Number(raw);
      if (def.required && (n === "" || Number.isNaN(n))) {
        return res.status(400).json({ error: "missing_required_field", field: def.key });
      }
      cleaned[def.key] = n === "" || Number.isNaN(n) ? "" : n;
    } else if (def.type === "select") {
      const s = typeof raw === "string" ? raw.trim() : "";
      if (s && !(def.options || []).includes(s)) {
        return res.status(400).json({ error: "invalid_option", field: def.key });
      }
      if (def.required && !s) {
        return res.status(400).json({ error: "missing_required_field", field: def.key });
      }
      cleaned[def.key] = s;
    } else {
      const s = typeof raw === "string" ? raw.trim() : "";
      if (def.required && !s) {
        return res.status(400).json({ error: "missing_required_field", field: def.key });
      }
      const max = def.maxLength || 400;
      cleaned[def.key] = s.slice(0, max);
    }
  }

  profile.fields = cleaned;
  profile.detailsCompleted = schema.filter((f) => f.required).every((f) => cleaned[f.key] !== "" && cleaned[f.key] !== undefined);
  profile.updatedAt = Date.now();

  store.save();
  res.json({ ok: true, profile: publicProfile(profile) });
});

app.get("/api/profile/:number", (req, res) => {
  const state = db();
  if (!state.event.active) return res.status(409).json({ error: "event_inactive" });
  const profile = state.profiles[req.params.number];
  if (!profile) return res.json({ exists: false });
  res.json({ exists: true, profile: publicProfile(profile) });
});

app.get("/api/roster/:gender", (req, res) => {
  const state = db();
  if (!state.event.active) return res.status(409).json({ error: "event_inactive" });
  const gender = req.params.gender;
  if (gender !== "male" && gender !== "female") return res.status(400).json({ error: "invalid_gender" });

  const roster = [];
  for (let i = 1; i <= state.event.maxNumber; i++) {
    const key = composeKey(gender, i);
    roster.push({ rawNumber: i, exists: Boolean(state.profiles[key]) });
  }
  res.json({ roster });
});

// ---------- "気になる" selections (never exposes match state to participants) ----------

app.get("/api/myselections/:number", (req, res) => {
  const state = db();
  if (!state.event.active) return res.status(409).json({ error: "event_inactive" });
  const number = req.params.number;
  if (!state.profiles[number]) return res.json({ exists: false });
  res.json({ exists: true, targets: state.selections[number]?.targets || [] });
});

app.post("/api/selections", (req, res) => {
  const state = db();
  if (!state.event.active) return res.status(409).json({ error: "event_inactive" });

  const { from, targets } = req.body || {};
  if (typeof from !== "string" || !KEY_RE.test(from) || !state.profiles[from]) {
    return res.status(400).json({ error: "invalid_request" });
  }
  if (!Array.isArray(targets) || targets.length > state.event.maxSelections) {
    return res.status(400).json({ error: "too_many_targets" });
  }
  const uniqueTargets = [...new Set(targets)];
  const expectedGender = opponentGender(state.profiles[from].gender);
  for (const t of uniqueTargets) {
    if (typeof t !== "string" || !KEY_RE.test(t) || !state.profiles[t]) {
      return res.status(400).json({ error: "invalid_target" });
    }
    if (state.profiles[t].gender !== expectedGender) {
      return res.status(400).json({ error: "invalid_target_gender" });
    }
  }

  state.selections[from] = { targets: uniqueTargets, updatedAt: Date.now() };
  store.save();
  res.json({ ok: true });
});

// ---------- admin: event & field schema ----------

app.post("/api/admin/setup", (req, res) => {
  const state = db();
  if (state.event.adminPasscode) return res.status(409).json({ error: "already_set_up" });
  const { passcode } = req.body || {};
  if (typeof passcode !== "string" || passcode.trim().length < 4) {
    return res.status(400).json({ error: "passcode_too_short" });
  }
  state.event.adminPasscode = passcode.trim();
  store.save();
  res.json({ ok: true });
});

app.post("/api/admin/login", (req, res) => {
  const state = db();
  if (!state.event.adminPasscode) return res.status(409).json({ error: "not_set_up" });
  const { passcode } = req.body || {};
  if (passcode !== state.event.adminPasscode) return res.status(401).json({ error: "unauthorized" });
  res.json({ ok: true });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const state = db();
  const profiles = Object.values(state.profiles);

  const rows = profiles
    .map((p) => ({
      number: p.number,
      gender: p.gender,
      rawNumber: p.rawNumber,
      myoji: p.myoji,
      fields: { ...p.fields },
      detailsCompleted: Boolean(p.detailsCompleted),
      updatedAt: p.updatedAt,
    }))
    .sort((a, b) => (a.gender === b.gender ? a.rawNumber - b.rawNumber : a.gender.localeCompare(b.gender)));

  const selectionRows = Object.entries(state.selections)
    .filter(([from]) => state.profiles[from])
    .map(([from, sel]) => ({
      from: summary(state.profiles[from]),
      targets: sel.targets.map((t) => summary(state.profiles[t])).filter(Boolean),
      updatedAt: sel.updatedAt,
    }));

  const { couples, runnerUps } = computeFinalCouples(state);

  res.json({
    event: state.event,
    fields: sortedFields(state),
    totals: {
      profiles: profiles.length,
      selections: selectionRows.length,
      matches: couples.length,
    },
    rows,
    selectionRows,
    finalCouples: couples,
    runnerUpCandidates: runnerUps,
  });
});

app.post("/api/admin/event/start", requireAdmin, (req, res) => {
  const state = db();
  const { name, maxNumber, scheduledLabel } = req.body || {};
  state.event.active = true;
  state.event.startedAt = Date.now();
  state.event.endedAt = null;
  state.event.detailsPurgedAt = null;
  if (typeof name === "string" && name.trim()) state.event.name = name.trim().slice(0, 60);
  if (typeof scheduledLabel === "string") state.event.scheduledLabel = scheduledLabel.trim().slice(0, 60);
  const parsedMax = Number(maxNumber);
  if (Number.isInteger(parsedMax) && parsedMax >= 1 && parsedMax <= 200) {
    state.event.maxNumber = parsedMax;
  }
  store.save();
  res.json({ ok: true, event: state.event });
});

app.post("/api/admin/event/end", requireAdmin, (req, res) => {
  const state = db();
  state.event.active = false;
  state.event.endedAt = Date.now();
  store.save();
  res.json({ ok: true, event: state.event });
});

app.post("/api/admin/purge-now", requireAdmin, (req, res) => {
  const state = db();
  for (const profile of Object.values(state.profiles)) {
    profile.fields = {};
    profile.detailsCompleted = false;
  }
  state.event.detailsPurgedAt = Date.now();
  store.save();
  res.json({ ok: true });
});

app.post("/api/admin/event/full-reset", requireAdmin, (req, res) => {
  const state = store.reset({ keepPasscode: true, keepName: true, keepMaxNumber: true, keepFieldSchema: true });
  res.json({ ok: true, event: state.event });
});

app.post("/api/admin/fields", requireAdmin, (req, res) => {
  const state = db();
  const { label, type, required, maxLength, options } = req.body || {};
  if (typeof label !== "string" || !label.trim()) return res.status(400).json({ error: "invalid_label" });
  if (!FIELD_TYPES.has(type)) return res.status(400).json({ error: "invalid_type" });
  const cleanedOptions = sanitizeOptions(options);
  if (type === "select" && cleanedOptions.length < 2) {
    return res.status(400).json({ error: "invalid_options" });
  }

  const maxOrder = state.fieldSchema.reduce((m, f) => Math.max(m, f.order), -1);
  const field = {
    key: `f${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    label: label.trim().slice(0, 40),
    type,
    required: Boolean(required),
    maxLength: type === "number" || type === "select" ? 0 : Math.min(Math.max(Number(maxLength) || 200, 1), 1000),
    options: type === "select" ? cleanedOptions : [],
    order: maxOrder + 1,
  };
  state.fieldSchema.push(field);
  store.save();
  res.json({ ok: true, fields: sortedFields(state) });
});

app.patch("/api/admin/fields/:key", requireAdmin, (req, res) => {
  const state = db();
  const field = state.fieldSchema.find((f) => f.key === req.params.key);
  if (!field) return res.status(404).json({ error: "not_found" });

  const { label, type, required, maxLength, options } = req.body || {};
  if (typeof label === "string" && label.trim()) field.label = label.trim().slice(0, 40);
  if (FIELD_TYPES.has(type)) field.type = type;
  if (typeof required === "boolean") field.required = required;
  if (maxLength !== undefined) {
    field.maxLength = field.type === "number" || field.type === "select" ? 0 : Math.min(Math.max(Number(maxLength) || 200, 1), 1000);
  }
  if (options !== undefined) field.options = sanitizeOptions(options);

  store.save();
  res.json({ ok: true, fields: sortedFields(state) });
});

app.delete("/api/admin/fields/:key", requireAdmin, (req, res) => {
  const state = db();
  state.fieldSchema = state.fieldSchema.filter((f) => f.key !== req.params.key);
  store.save();
  res.json({ ok: true, fields: sortedFields(state) });
});

app.post("/api/admin/fields/reorder", requireAdmin, (req, res) => {
  const state = db();
  const { keys } = req.body || {};
  if (!Array.isArray(keys)) return res.status(400).json({ error: "invalid_request" });
  keys.forEach((key, index) => {
    const field = state.fieldSchema.find((f) => f.key === key);
    if (field) field.order = index;
  });
  store.save();
  res.json({ ok: true, fields: sortedFields(state) });
});

app.listen(PORT, () => {
  console.log(`konkatsu-matching-app listening on http://localhost:${PORT}`);
});

// Keep the 24h-later purge running even with no HTTP traffic.
setInterval(() => store.state, 5 * 60 * 1000);
