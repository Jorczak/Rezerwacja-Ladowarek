document.addEventListener('DOMContentLoaded', () => {
  const calendarEls = [
    { spot: 1, el: document.getElementById('cal-1'), cal: null },
    { spot: 2, el: document.getElementById('cal-2'), cal: null },
    { spot: 3, el: document.getElementById('cal-3'), cal: null },
    { spot: 4, el: document.getElementById('cal-4'), cal: null }
  ];

  // Modale i formularz
  const reservationModal = document.getElementById('reservationModal');
  const detailsModal = document.getElementById('detailsModal');

  const resForm = document.getElementById('reservationForm');
  const cancelModalBtn = document.getElementById('cancelModalBtn');
  const formError = document.getElementById('formError');

  const preferredSpotInfo = document.getElementById('preferredSpotInfo');
  const preferredSpotText = document.getElementById('preferredSpotText');
  const clearPreferredSpotBtn = document.getElementById('clearPreferredSpot');

  const detailsContent = document.getElementById('detailsContent');
  const deletePinInput = document.getElementById('deletePin');
  const deleteError = document.getElementById('deleteError');
  const deleteReservationBtn = document.getElementById('deleteReservationBtn');
  const closeDetailsBtn = document.getElementById('closeDetailsBtn');
  const sendManageLinkBtn = document.getElementById('sendManageLinkBtn');

  const resPinInput = document.getElementById('resPin');
  const resEmailInput = document.getElementById('resEmail');

  // Toolbar wspólny
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const todayBtn = document.getElementById('todayBtn');
  const dayBtn = document.getElementById('dayBtn');
  const weekBtn = document.getElementById('weekBtn');
  const titleEl = document.getElementById('titleEl');

  let pendingSelection = { start: null, end: null, spot: null };
  let selectedEvent = null;
  let currentView = 'timeGridWeek';

  const colors = {
    1: '#4caf50',
    2: '#2196f3',
    3: '#ff9800',
    4: '#9c27b0'
  };

  function openModal(modal) {
    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';
  }
  function closeModal(modal) {
    modal.setAttribute('aria-hidden', 'true');
    modal.style.display = 'none';
  }

  function toLocalInputValue(date) {
    const pad = n => String(n).padStart(2, '0');
    const d = new Date(date);
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const h = pad(d.getHours());
    const min = pad(d.getMinutes());
    return `${y}-${m}-${day}T${h}:${min}`;
  }

  async function fetchEvents(rangeStartStr, rangeEndStr) {
    const url = `/api/reservations?start=${encodeURIComponent(rangeStartStr)}&end=${encodeURIComponent(rangeEndStr)}`;
    const resp = await fetch(url);
    return await resp.json();
  }

  function updateTitleFrom(cal) {
    if (!cal) return;
    titleEl.textContent = cal.view?.title || '';
  }

  function refetchAll() {
    calendarEls.forEach(c => c.cal && c.cal.refetchEvents());
  }

  function createCalendar(spot, el) {
    return new FullCalendar.Calendar(el, {
      headerToolbar: false,
      initialView: currentView,
      locale: 'pl',
      firstDay: 1,
      slotMinTime: '06:00:00',
      slotMaxTime: '22:00:00',
      allDaySlot: false,                 // wyłącz wiersz „Całodniowe”
      navLinks: false,
      selectable: true,
      selectMirror: true,
      nowIndicator: true,
      height: 'auto',
      selectAllow: (selectionInfo) => !selectionInfo.allDay, // zablokuj zaznaczenia all-day
      events: async (info, successCallback, failureCallback) => {
        try {
          const data = await fetchEvents(info.startStr, info.endStr);
          const events = data
            .filter(ev => Number(ev.extendedProps?.chargerNumber) === spot)
            .map(ev => ({
              ...ev,
              color: colors[spot] || '#1976d2'
            }));
          successCallback(events);
        } catch (e) {
          console.error(e);
          failureCallback(e);
        }
      },
      select: (selectionInfo) => {
        pendingSelection.start = selectionInfo.start;
        pendingSelection.end = selectionInfo.end;
        pendingSelection.spot = spot;

        document.getElementById('resStart').value = toLocalInputValue(selectionInfo.start);
        document.getElementById('resEnd').value = toLocalInputValue(selectionInfo.end);
        document.getElementById('resName').value = '';
        document.getElementById('resPlate').value = '';
        if (resEmailInput) resEmailInput.value = '';
        if (resPinInput) resPinInput.value = '';
        formError.textContent = '';

        preferredSpotText.textContent = `Ładowarka ${spot}`;
        preferredSpotInfo.style.display = '';

        openModal(reservationModal);
      },
      eventClick: (clickInfo) => {
        selectedEvent = clickInfo.event;
        const props = selectedEvent.extendedProps || {};
        const start = new Date(selectedEvent.start);
        const end = new Date(selectedEvent.end);
        const charger = props.chargerNumber;

        detailsContent.innerHTML = `
          <p><strong>Ładowarka:</strong> ${charger}</p>
          <p><strong>Nazwa:</strong> ${props.name || '-'}</p>
          <p><strong>Rejestracja:</strong> ${props.plate || '-'}</p>
          <p><strong>Od:</strong> ${start.toLocaleString()}</p>
          <p><strong>Do:</strong> ${end.toLocaleString()}</p>
        `;

        deletePinInput.value = '';
        deleteError.textContent = '';

        openModal(detailsModal);
      }
    });
  }

  // Utwórz 4 kalendarze
  calendarEls.forEach(entry => {
    entry.cal = createCalendar(entry.spot, entry.el);
    entry.cal.render();
  });

  // Ustaw tytuł
  updateTitleFrom(calendarEls[0].cal);

  // Toolbar — obsługa
  prevBtn.addEventListener('click', () => {
    calendarEls.forEach(c => c.cal.prev());
    updateTitleFrom(calendarEls[0].cal);
  });

  nextBtn.addEventListener('click', () => {
    calendarEls.forEach(c => c.cal.next());
    updateTitleFrom(calendarEls[0].cal);
  });

  todayBtn.addEventListener('click', () => {
    calendarEls.forEach(c => c.cal.today());
    updateTitleFrom(calendarEls[0].cal);
  });

  function setView(viewName) {
    currentView = viewName;
    calendarEls.forEach(c => c.cal.changeView(viewName));
    if (viewName === 'timeGridDay') {
      dayBtn.classList.add('active'); weekBtn.classList.remove('active');
    } else {
      weekBtn.classList.add('active'); dayBtn.classList.remove('active');
    }
    updateTitleFrom(calendarEls[0].cal);
  }

  dayBtn.addEventListener('click', () => setView('timeGridDay'));
  weekBtn.addEventListener('click', () => setView('timeGridWeek'));

  // Formularz rezerwacji
  resForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.textContent = '';

    const name = document.getElementById('resName').value.trim();
    const plate = document.getElementById('resPlate').value.trim();
    const email = (resEmailInput?.value || '').trim();
    const startLocal = document.getElementById('resStart').value;
    const endLocal = document.getElementById('resEnd').value;

    if (!startLocal || !endLocal) {
      formError.textContent = 'Podaj poprawny zakres czasu.';
      return;
    }

    const start = new Date(startLocal);
    const end = new Date(endLocal);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      formError.textContent = 'Nieprawidłowy format daty.';
      return;
    }
    if (end <= start) {
      formError.textContent = 'Czas zakończenia musi być po czasie rozpoczęcia.';
      return;
    }

    const body = {
      name,
      plate,
      start: start.toISOString(),
      end: end.toISOString()
    };
    if (email) body.email = email;
    if (pendingSelection.spot) {
      body.preferredCharger = Number(pendingSelection.spot);
    }

    const pinVal = (resPinInput?.value || '').trim();
    if (pinVal) {
      if (!/^\d{4,6}$/.test(pinVal)) {
        formError.textContent = 'PIN musi mieć 4–6 cyfr.';
        return;
      }
      body.pin = pinVal;
    }

    try {
      const resp = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        formError.textContent = result.error || 'Nie udało się utworzyć rezerwacji.';
        return;
      }

      if (result.pinOnce) {
        alert(`Zapisz swój kod PIN do zarządzania rezerwacją: ${result.pinOnce}`);
      }

      closeModal(reservationModal);
      if (resPinInput) resPinInput.value = '';
      refetchAll();
    } catch (e2) {
      console.error(e2);
      formError.textContent = 'Błąd połączenia z serwerem.';
    }
  });

  cancelModalBtn.addEventListener('click', () => {
    closeModal(reservationModal);
  });

  // Wyczyść preferencję ładowarki
  clearPreferredSpotBtn.addEventListener('click', () => {
    pendingSelection.spot = null;
    preferredSpotInfo.style.display = 'none';
  });

  // Usuwanie rezerwacji (PIN lub ADMIN_PIN lub token)
  deleteReservationBtn.addEventListener('click', async () => {
    if (!selectedEvent) return;

    deleteError.textContent = '';
    const pin = (deletePinInput?.value || '').trim();

    if (!confirm('Czy na pewno chcesz usunąć tę rezerwację?')) {
      return;
    }

    try {
      const resp = await fetch(`/api/reservations/${encodeURIComponent(selectedEvent.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        deleteError.textContent = result.error || 'Nie udało się usunąć rezerwacji.';
        return;
      }
      closeModal(detailsModal);
      refetchAll();
    } catch (e) {
      console.error(e);
      deleteError.textContent = 'Błąd połączenia z serwerem.';
    }
  });

  // Wyślij link zarządzania na e‑mail
  sendManageLinkBtn.addEventListener('click', async () => {
    if (!selectedEvent) return;
    try {
      const resp = await fetch(`/api/reservations/${encodeURIComponent(selectedEvent.id)}/send-link`, {
        method: 'POST'
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        alert(data.error || 'Nie udało się wysłać linku.');
        return;
      }
      if (data.previewUrl) {
        console.log('Podgląd wiadomości e‑mail (Ethereal):', data.previewUrl);
      }
      alert('Wysłaliśmy link do zarządzania na adres e‑mail właściciela rezerwacji.');
    } catch (e) {
      console.error(e);
      alert('Błąd połączenia z serwerem.');
    }
  });

  closeDetailsBtn.addEventListener('click', () => {
    closeModal(detailsModal);
  });

  // Zamknięcie modali po kliknięciu tła
  [reservationModal, detailsModal].forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });
});