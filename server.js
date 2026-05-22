const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Ścieżki do plików
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'reservations.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Upewnij się, że katalog i plik danych istnieją
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

// I/O
function loadReservations() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Błąd odczytu pliku:', e);
    return [];
  }
}
function saveReservations(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// Przedziały czasu — półotwarte [start, end)
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// PIN — haszowanie i weryfikacja
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPin(pin, salt, hash) {
  const test = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

// Tokeny „magic link”
function hashToken(token, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(token), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyToken(token, salt, hash) {
  const test = crypto.scryptSync(String(token), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

function checkMagicToken(reservation, tokenPlain) {
  const list = Array.isArray(reservation.magicTokens) ? reservation.magicTokens : [];
  const now = Date.now();
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.expiresAt && Date.parse(t.expiresAt) < now) continue;
    if (t.singleUse && t.usedAt) continue;
    if (verifyToken(tokenPlain, t.salt, t.hash)) {
      return { ok: true, index: i, token: t };
    }
  }
  return { ok: false };
}

function consumeMagicToken(reservations, idxReservation, idxToken) {
  const r = reservations[idxReservation];
  if (r.magicTokens && r.magicTokens[idxToken] && r.magicTokens[idxToken].singleUse) {
    r.magicTokens[idxToken].usedAt = new Date().toISOString();
    reservations[idxReservation] = r;
    saveReservations(reservations);
  }
}

async function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  // 1) Jeśli jest skonfigurowany prawdziwy SMTP – użyj go
  if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  }

  // 2) Tryb developerski bez sieci: loguj e‑maile w konsoli (pole "message")
  if (process.env.DEV_MAIL_MODE === 'console' || process.env.DEV_MAIL_MODE === 'json') {
    return nodemailer.createTransport({ jsonTransport: true });
  }

  // 3) Próba Ethereal (test). Jeśli się nie uda – fallback do console/json
  try {
    const test = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
      host: test.smtp.host,
      port: test.smtp.port,
      secure: test.smtp.secure,
      auth: { user: test.user, pass: test.pass }
    });
  } catch (e) {
    console.warn('Ethereal niedostępny – przełączam na jsonTransport (log w konsoli).');
    return nodemailer.createTransport({ jsonTransport: true });
  }
}

// MIGRACJA: spotNumber -> chargerNumber (bez „miejsc”)
function migrateData() {
  const all = loadReservations();
  let changed = false;
  for (const r of all) {
    if (r.chargerNumber == null && r.spotNumber != null) {
      r.chargerNumber = r.spotNumber;
      delete r.spotNumber;
      changed = true;
    }
  }
  if (changed) {
    console.log('Migracja: zaktualizowano spotNumber -> chargerNumber');
    saveReservations(all);
  }
}
migrateData();

// Middleware
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// API: lista rezerwacji (dla kalendarza)
app.get('/api/reservations', (req, res) => {
  const { start, end } = req.query;
  let startMs = start ? Date.parse(start) : null;
  let endMs = end ? Date.parse(end) : null;

  const all = loadReservations();
  let filtered = all;

  if (startMs !== null && endMs !== null) {
    filtered = all.filter(r =>
      overlaps(startMs, endMs, Date.parse(r.start), Date.parse(r.end))
    );
  }

  const events = filtered.map(r => ({
    id: r.id,
    title: `Ładowarka ${r.chargerNumber} — ${r.plate || 'Rezerwacja'}`,
    start: r.start,
    end: r.end,
    extendedProps: {
      name: r.name || '',
      plate: r.plate || '',
      chargerNumber: r.chargerNumber
    }
  }));

  res.json(events);
});

// API: tworzenie rezerwacji
app.post('/api/reservations', async (req, res) => {
  try {
    const {
      name, plate, start, end,
      preferredCharger, preferredSpot, // legacy pole preferencji (obsłużymy dla zgodności)
      pin,
      email
    } = req.body || {};

    if (!start || !end) {
      return res.status(400).json({ error: 'Brak start lub end' });
    }

    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (isNaN(startMs) || isNaN(endMs)) {
      return res.status(400).json({ error: 'Nieprawidłowy format daty' });
    }
    if (endMs <= startMs) {
      return res.status(400).json({ error: 'Czas zakończenia musi być po czasie rozpoczęcia' });
    }

    // Limit długości (24h)
const maxDurationMs = 24 * 60 * 60 * 1000;
// Blokujemy równe 24h i dłużej, by wykluczyć „całodniowe”
if (endMs - startMs >= maxDurationMs) {
  return res.status(400).json({ error: 'Maksymalna długość rezerwacji to krócej niż 24 godziny' });
}

    // Walidacja e‑mail
    const ownerEmail = String(email || '').trim();
    if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      return res.status(400).json({ error: 'Nieprawidłowy adres e‑mail' });
    }

    // Wczytaj i znajdź kolizje
    const reservations = loadReservations();
    const overlapping = reservations.filter(r =>
      overlaps(startMs, endMs, Date.parse(r.start), Date.parse(r.end))
    );

    // Zajęte ładowarki
    const usedChargers = new Set(overlapping.map(r => r.chargerNumber));

    // Preferencja ładowarki
    let assignedCharger = null;
    const pref = Number(preferredCharger ?? preferredSpot);
    if (Number.isInteger(pref) && pref >= 1 && pref <= 4 && !usedChargers.has(pref)) {
      assignedCharger = pref;
    }
    if (!assignedCharger) {
      for (let s = 1; s <= 4; s++) {
        if (!usedChargers.has(s)) {
          assignedCharger = s;
          break;
        }
      }
    }
    if (!assignedCharger) {
      return res.status(409).json({ error: 'Brak wolnych ładowarek w wybranym przedziale czasu' });
    }

    // PIN: walidacja/generacja i haszowanie
    let pinToStore = String(pin || '').trim();
    let pinOnce = null;
    if (pinToStore) {
      if (!/^\d{4,6}$/.test(pinToStore)) {
        return res.status(400).json({ error: 'PIN musi mieć 4–6 cyfr' });
      }
      pinOnce = pinToStore;
    } else {
      pinToStore = String(Math.floor(100000 + Math.random() * 900000)); // 6 cyfr
      pinOnce = pinToStore;
    }
    const { salt: pinSalt, hash: pinHash } = hashPin(pinToStore);

    const newRes = {
      id: uuid(),
      name: String(name || '').trim(),
      plate: String(plate || '').trim(),
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      chargerNumber: assignedCharger,
      createdAt: new Date().toISOString(),
      pinSalt,
      pinHash,
      email: ownerEmail || '',
      magicTokens: []
    };

    reservations.push(newRes);
    saveReservations(reservations);

    // Zwracamy bezpieczne dane + pinOnce (jednorazowo)
    const { pinSalt: _, pinHash: __, ...safeRes } = newRes;
    res.status(201).json({ ...safeRes, pinOnce });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Nie udało się utworzyć rezerwacji' });
  }
});

// API: usuwanie rezerwacji (PIN, token lub ADMIN_PIN)
app.delete('/api/reservations/:id', (req, res) => {
  const { id } = req.params;
  const { pin, token } = req.body || {};
  const adminPin = process.env.ADMIN_PIN || null;

  const reservations = loadReservations();
  const idx = reservations.findIndex(r => r.id === id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Nie znaleziono rezerwacji' });
  }

  const r = reservations[idx];

  // Token z e‑maila
  if (token) {
    const check = checkMagicToken(r, String(token));
    if (!check.ok) return res.status(401).json({ error: 'Token nieprawidłowy lub wygasł' });
    consumeMagicToken(reservations, idx, check.index);
    reservations.splice(idx, 1);
    saveReservations(reservations);
    return res.json({ ok: true, deletedId: id, via: 'magic-link' });
  }

  // Admin PIN
  if (adminPin && String(pin) === String(adminPin)) {
    reservations.splice(idx, 1);
    saveReservations(reservations);
    return res.json({ ok: true, deletedId: id, via: 'admin' });
  }

  // PIN rezerwacji
  if (r.pinHash && r.pinSalt) {
    if (!pin) return res.status(401).json({ error: 'Wymagany PIN' });
    const ok = verifyPin(String(pin), r.pinSalt, r.pinHash);
    if (!ok) return res.status(403).json({ error: 'Nieprawidłowy PIN' });
  }

  reservations.splice(idx, 1);
  saveReservations(reservations);
  res.json({ ok: true, deletedId: id });
});

// API: wysyłka linku zarządzania rezerwacją na e‑mail
app.post('/api/reservations/:id/send-link', async (req, res) => {
  try {
    const { id } = req.params;
    const reservations = loadReservations();
    const idx = reservations.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Nie znaleziono rezerwacji' });

    const r = reservations[idx];
    if (!r.email) {
      return res.status(400).json({ error: 'Brak e‑maila przypisanego do rezerwacji' });
    }

    // Token
    const tokenPlain = crypto.randomBytes(32).toString('hex');
    const { salt, hash } = hashToken(tokenPlain);
    const ttlMinutes = Number(process.env.MAGIC_TTL_MIN || 60);
    const tokenRecord = {
      id: uuid(),
      salt,
      hash,
      scope: 'manage',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
      usedAt: null,
      singleUse: false
    };

    r.magicTokens = Array.isArray(r.magicTokens) ? r.magicTokens : [];
    r.magicTokens.push(tokenRecord);
    reservations[idx] = r;
    saveReservations(reservations);

    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const manageUrl = `${baseUrl}/manage.html?id=${encodeURIComponent(r.id)}&token=${encodeURIComponent(tokenPlain)}`;

    const transporter = await getTransporter();
    const mail = {
      from: process.env.MAIL_FROM || 'no-reply@example.com',
      to: r.email,
      subject: 'Link do zarządzania rezerwacją ładowarki',
      text: `Dzień dobry,\n\nOto link do zarządzania Twoją rezerwacją ładowarki (ważny ${ttlMinutes} min):\n${manageUrl}\n\nJeśli nie prosiłeś o ten link, zignoruj tę wiadomość.`,
      html: `
        <p>Dzień dobry,</p>
        <p>Oto link do zarządzania Twoją rezerwacją ładowarki (ważny ${ttlMinutes} min):</p>
        <p><a href="${manageUrl}" target="_blank" rel="noopener">Zarządzaj rezerwacją</a></p>
        <p>Jeśli nie prosiłeś o ten link, zignoruj tę wiadomość.</p>
      `
    };
const info = await transporter.sendMail(mail);

// Podgląd/LOG w trybie jsonTransport
if (info.message) {
  console.log('E-mail (jsonTransport):', info.message.toString());
}
// Ethereal – opcjonalny podgląd
let previewUrl = undefined;
if (nodemailer.getTestMessageUrl) {
  previewUrl = nodemailer.getTestMessageUrl(info);
}
res.json({ ok: true, sentTo: r.email, previewUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Nie udało się wysłać linku' });
  }
});

// API: weryfikacja linku z e‑maila (dla manage.html)
app.get('/api/magic/resolve', (req, res) => {
  const { id, token } = req.query || {};
  if (!id || !token) return res.status(400).json({ error: 'Brak id lub token' });

  const reservations = loadReservations();
  const idx = reservations.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Nie znaleziono rezerwacji' });

  const r = reservations[idx];
  const check = checkMagicToken(r, String(token));
  if (!check.ok) return res.status(401).json({ error: 'Token nieprawidłowy lub wygasł' });

  res.json({
    ok: true,
    reservation: {
      id: r.id,
      name: r.name || '',
      plate: r.plate || '',
      start: r.start,
      end: r.end,
      chargerNumber: r.chargerNumber
    }
  });
});

// API: ustaw nowy PIN przez link e‑mail
app.post('/api/reservations/:id/set-pin', (req, res) => {
  const { id } = req.params;
  const { token, newPin } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Brak tokenu' });
  if (!/^\d{4,6}$/.test(String(newPin || ''))) return res.status(400).json({ error: 'PIN musi mieć 4–6 cyfr' });

  const reservations = loadReservations();
  const idx = reservations.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Nie znaleziono rezerwacji' });

  const r = reservations[idx];
  const check = checkMagicToken(r, String(token));
  if (!check.ok) return res.status(401).json({ error: 'Token nieprawidłowy lub wygasł' });

  const { salt, hash } = hashPin(String(newPin));
  r.pinSalt = salt;
  r.pinHash = hash;
  reservations[idx] = r;
  saveReservations(reservations);
  res.json({ ok: true });
});

// Start
app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
  if (process.env.ADMIN_PIN) {
    console.log('ADMIN_PIN skonfigurowany — usuwanie z nim zawsze dozwolone.');
  }
});