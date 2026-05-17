
    const WEATHER_CONFIG = { name: 'Trondheim', lat: 63.4305, lon: 10.3951, timezone: 'Europe/Oslo' };
    // Blob-efficient sync: no polling loop. Load fresh events on page boot,
    // once per hour during daytime, on deliberate interaction, or when needed for a write/retry.
    const INTERACTION_FETCH_DEBOUNCE_MS = 800;
    const AUTOMATIC_EVENT_REFRESH_START_HOUR = 6;
    const AUTOMATIC_EVENT_REFRESH_END_HOUR = 21;
    const MIN_DISPLAY_FETCH_GAP_MS = 60 * 1000;
    const MIN_ADMIN_FETCH_GAP_MS = 20 * 1000;
    const LOCAL_EVENTS_CACHE_KEY = 'homeOrganizerEventsCacheV2';
    const LOCAL_EVENTS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const DEFAULT_UPCOMING_LIMIT = 4;
    const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
    const IMAGE_UPLOAD_PASSTHROUGH_BYTES = 450 * 1024;
    const COMPRESSED_UPLOAD_TARGET_BYTES = 650 * 1024;
    const IMAGE_MAX_DIMENSION = 1280;
    const JPEG_QUALITY_STEPS = [0.78, 0.7, 0.62, 0.54, 0.46, 0.38, 0.32];
    const PENDING_WRITES_KEY = 'homeOrganizerPendingWrites';
    const LOCAL_COMPLETION_OVERRIDES_KEY = 'homeOrganizerCompletionOverrides';
    const LOCAL_EVENT_MIRROR_KEY = 'homeOrganizerLocalEventMirror';
    const LOCAL_EVENT_MIRROR_TTL_MS = 24 * 60 * 60 * 1000;
    const LOCAL_EVENT_MIRROR_MIN_HOLD_MS = 2 * 60 * 1000;
    const LOCAL_EVENT_ID_PREFIX = 'local-';
    const LAST_WRITE_SIGNAL_KEY = 'homeOrganizerLastWrite';
    const DAUGHTER_PERIOD_OVERRIDES_KEY = 'homeOrganizerDaughterPeriodOverridesV1';
    const DAUGHTER_ANCHOR_START_KEY = '2026-05-13';
    const DAUGHTER_ANCHOR_END_KEY = '2026-05-20';
    const DAUGHTER_PERIOD_INTERVAL_DAYS = 14;
    const HARD_CODED_REMINDER_CONTACTS = [
      { key: 'therese', name: 'Therese', email: 'theresesaksgard@hotmail.com' },
      { key: 'thomas', name: 'Thomas', email: 'diemetrix@gmail.com' }
    ];

    const state = {
      events: [],
      serverEvents: [],
      pendingWriteActive: false,
      eventFetchActive: false,
      lastEventFetchAt: 0,
      weather: null,
      editingId: null,
      selectedDayKey: null,
      selectedDayTimer: null,
      selectedDayCycleTimer: null,
      selectedDayCycleIndex: 0,
      todayCycleTimer: null,
      todayCycleDateKey: null,
      dailyCalendarMode: false,
      dailyHomeTimer: null,
      upcomingPage: 0,
      hiddenRepeatingTasksVisibleUntil: 0,
      hiddenRepeatingTasksTimer: null,
      selectedEventFlipped: false,
      heroEventFlipped: false,
      flipBackTimer: null,
      selectedInstanceId: null,
      flippedAdminEventId: null,
      activeAdminInstanceId: null,
      config: {
        localOnly: true
      },
      longPressTimer: null,
      longPressOpened: false,
      monthViewDate: new Date(),
      selectedDaughterPeriodKey: null,
      daughterEditorMode: 'edit',
      daughterPeriodOverrides: {},
      weatherFocusDate: null,
      dangerHoldTimer: null,
      dangerHoldOpened: false,
      showFrequentRepeatingTasks: localStorage.getItem('homeOrganizerShowFrequentRepeatingTasks') === '1',
      pendingImageFocus: null,
      imageFocusToken: 0,
      imagePreviewObjectUrl: null,
      lastReminderSync: null,
      reminderMenuExpanded: localStorage.getItem('homeOrganizerReminderMenuExpanded') === '1'
    };

    const els = {
      displayView: document.getElementById('displayView'),
      adminView: document.getElementById('adminView'),
      clockCard: document.getElementById('clockCard'),
      timeDisplay: document.getElementById('timeDisplay'),
      ampmDisplay: document.getElementById('ampmDisplay'),
      dateDisplay: document.getElementById('dateDisplay'),
      weatherCard: document.getElementById('weatherCard'),
      weatherEffect: document.getElementById('weatherEffect'),
      weatherContent: document.getElementById('weatherContent'),
      selectedEventPanel: document.getElementById('selectedEventPanel'),
      dailyCalendarPanel: document.getElementById('dailyCalendarPanel'),
      weatherIcon: document.getElementById('weatherIcon'),
      weatherTemp: document.getElementById('weatherTemp'),
      weatherDesc: document.getElementById('weatherDesc'),
      forecastRow: document.getElementById('forecastRow'),
      hourlyWeather: document.getElementById('hourlyWeather'),
      weekView: document.getElementById('weekView'),
      heroEvent: document.getElementById('heroEvent'),
      heroBack: document.getElementById('heroBack'),
      heroImage: document.getElementById('heroImage'),
      heroKicker: document.getElementById('heroKicker'),
      heroTitle: document.getElementById('heroTitle'),
      heroLocation: document.getElementById('heroLocation'),
      upcomingGrid: document.getElementById('upcomingGrid'),
      upcomingPager: document.getElementById('upcomingPager'),
      adminClock: document.getElementById('adminClock'),
      returnToDisplayBtn: document.getElementById('returnToDisplayBtn'),
      pinCard: document.getElementById('pinCard'),
      adminCalendarCard: document.getElementById('adminCalendarCard'),
      adminListSubtitle: document.getElementById('adminListSubtitle'),
      newTaskBtn: document.getElementById('newTaskBtn'),
      repeatVisibilityToggle: document.getElementById('repeatVisibilityToggle'),
      showFrequentRepeatingInput: document.getElementById('showFrequentRepeatingInput'),
      phoneReminderMenu: document.getElementById('phoneReminderMenu'),
      reminderMenuToggle: document.getElementById('reminderMenuToggle'),
      phoneReminderMenuBody: document.getElementById('phoneReminderMenuBody'),
      reminderMenuChevron: document.getElementById('reminderMenuChevron'),
      weeklyUpdatesInput: document.getElementById('weeklyUpdatesInput'),
      dailyNewTasksInput: document.getElementById('dailyNewTasksInput'),
      saveReminderSettingsBtn: document.getElementById('saveReminderSettingsBtn'),
      reminderMenuStatus: document.getElementById('reminderMenuStatus'),
      repeatVisibilityText: document.getElementById('repeatVisibilityText'),
      repeatVisibilityHelp: document.getElementById('repeatVisibilityHelp'),
      eventEditorCard: document.getElementById('eventEditorCard'),
      eventEditorTitle: document.getElementById('eventEditorTitle'),
      closeEditorBtn: document.getElementById('closeEditorBtn'),
      pinInput: document.getElementById('pinInput'),
      savePinBtn: document.getElementById('savePinBtn'),
      eventForm: document.getElementById('eventForm'),
      eventId: document.getElementById('eventId'),
      titleInput: document.getElementById('titleInput'),
      startInput: document.getElementById('startInput'),
      endInput: document.getElementById('endInput'),
      repeatInput: document.getElementById('repeatInput'),
      locationInput: document.getElementById('locationInput'),
      noteInput: document.getElementById('noteInput'),
      imageInput: document.getElementById('imageInput'),
      imageUrlInput: document.getElementById('imageUrlInput'),
      imageStatus: document.getElementById('imageStatus'),
      manualImageEditor: document.getElementById('manualImageEditor'),
      imagePreview: document.getElementById('imagePreview'),
      imagePreviewTitle: document.getElementById('imagePreviewTitle'),
      imageFocusXInput: document.getElementById('imageFocusXInput'),
      imageFocusYInput: document.getElementById('imageFocusYInput'),
      imageZoomInput: document.getElementById('imageZoomInput'),
      imageCenterBtn: document.getElementById('imageCenterBtn'),
      imageTextSafeBtn: document.getElementById('imageTextSafeBtn'),
      featuredInput: document.getElementById('featuredInput'),
      emailReminderInput: document.getElementById('emailReminderInput'),
      emailReminderOptions: document.getElementById('emailReminderOptions'),
      emailContactList: document.getElementById('emailContactList'),
      reminderHelp: document.getElementById('reminderHelp'),
      saveEventBtn: document.getElementById('saveEventBtn'),
      resetBtn: document.getElementById('resetBtn'),
      statusLine: document.getElementById('statusLine'),
      adminEvents: document.getElementById('adminEvents'),
      taskActionOverlay: document.getElementById('taskActionOverlay'),
      taskActionContent: document.getElementById('taskActionContent'),
      monthOverlay: document.getElementById('monthOverlay'),
      monthCloseBtn: document.getElementById('monthCloseBtn'),
      monthTitle: document.getElementById('monthTitle'),
      monthSubtitle: document.getElementById('monthSubtitle'),
      monthPrevBtn: document.getElementById('monthPrevBtn'),
      monthNextBtn: document.getElementById('monthNextBtn'),
      monthTodayBtn: document.getElementById('monthTodayBtn'),
      monthSettingsBtn: document.getElementById('monthSettingsBtn'),
      monthGrid: document.getElementById('monthGrid'),
      daughterPeriodEditor: document.getElementById('daughterPeriodEditor'),
      daughterPeriodTitle: document.getElementById('daughterPeriodTitle'),
      daughterPeriodHelp: document.getElementById('daughterPeriodHelp'),
      daughterStartInput: document.getElementById('daughterStartInput'),
      daughterEndInput: document.getElementById('daughterEndInput'),
      daughterSaveBtn: document.getElementById('daughterSaveBtn'),
      daughterDeleteBtn: document.getElementById('daughterDeleteBtn'),
      daughterResetBtn: document.getElementById('daughterResetBtn'),
      daughterAddBtn: document.getElementById('daughterAddBtn'),
      daughterPeriodStatus: document.getElementById('daughterPeriodStatus'),
      configOverlay: document.getElementById('configOverlay'),
      configCloseBtn: document.getElementById('configCloseBtn'),
      configPinInput: document.getElementById('configPinInput'),
      localQueueStatus: document.getElementById('localQueueStatus'),
      saveConfigBtn: document.getElementById('saveConfigBtn'),
      reloadConfigBtn: document.getElementById('reloadConfigBtn'),
      configStatus: document.getElementById('configStatus'),
      weatherOverlay: document.getElementById('weatherOverlay'),
      weatherOverlayCloseBtn: document.getElementById('weatherOverlayCloseBtn'),
      weatherWeeklyList: document.getElementById('weatherWeeklyList'),
      adminTitle: document.getElementById('adminTitle'),
      dangerOverlay: document.getElementById('dangerOverlay'),
      dangerCloseBtn: document.getElementById('dangerCloseBtn'),
      dangerPinInput: document.getElementById('dangerPinInput'),
      dangerConfirmInput: document.getElementById('dangerConfirmInput'),
      deleteAllEventsBtn: document.getElementById('deleteAllEventsBtn'),
      cancelDeleteAllBtn: document.getElementById('cancelDeleteAllBtn'),
      dangerStatus: document.getElementById('dangerStatus')
    };

    const params = new URLSearchParams(location.search);
    const forceAdmin = params.has('admin');
    const forceDisplay = params.has('display');
    const isPhoneLike = matchMedia('(max-width: 780px), ((pointer: coarse) and (max-height: 520px))').matches;
    const adminMode = forceAdmin || (!forceDisplay && isPhoneLike);
    if (adminMode && !isPhoneLike) document.body.classList.add('desktop-admin');
    if (adminMode && isPhoneLike) document.body.classList.add('phone-admin');

    function fitKioskToScreen() {
      if (adminMode || !els.displayView || window.innerWidth <= 980) return;

      const margin = Math.max(8, Math.min(20, Math.min(window.innerWidth, window.innerHeight) * 0.014));
      const availableW = Math.max(320, window.innerWidth - margin * 2);
      const availableH = Math.max(320, window.innerHeight - margin * 2);
      const targetRatio = 3 / 2; // Surface Pro friendly.

      let width = availableW;
      let height = width / targetRatio;
      if (height > availableH) {
        height = availableH;
        width = height * targetRatio;
      }

      els.displayView.style.width = `${Math.floor(width)}px`;
      els.displayView.style.height = `${Math.floor(height)}px`;
    }

    function pad(number) {
      return String(number).padStart(2, '0');
    }

    function formatTime(date, showAmPm = false) {
      const formatter = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: showAmPm
      });
      return formatter.format(date);
    }

    function formatUpcomingDate(date) {
      const now = new Date();
      const options = { weekday: 'short', day: 'numeric', month: 'short' };
      if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
      return new Intl.DateTimeFormat(undefined, options)
        .format(date)
        .replace(',', '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function splitTime(date) {
      return { time: `${pad(date.getHours())}:${pad(date.getMinutes())}`, ampm: '' };
    }

    function sameDay(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }

    function dateKey(date) {
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function dateFromKey(key) {
      const [year, month, day] = String(key || '').split('-').map(Number);
      if (!year || !month || !day) return null;
      return new Date(year, month - 1, day);
    }

    function todayStart() {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }


    function startOfLocalDay(date) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    function addLocalDays(date, days) {
      const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      next.setDate(next.getDate() + days);
      return next;
    }

    function localDaysBetween(start, end) {
      const a = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
      const b = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
      return Math.round((b - a) / 86400000);
    }

    function monthStart(date) {
      return new Date(date.getFullYear(), date.getMonth(), 1);
    }

    function monthEnd(date) {
      return new Date(date.getFullYear(), date.getMonth() + 1, 0);
    }

    function ensureDaughterStorageShape() {
      if (!state.daughterPeriodOverrides || typeof state.daughterPeriodOverrides !== 'object') {
        state.daughterPeriodOverrides = {};
      }
      if (!state.daughterPeriodOverrides.__extra || typeof state.daughterPeriodOverrides.__extra !== 'object') {
        state.daughterPeriodOverrides.__extra = {};
      }
    }

    function loadDaughterPeriodOverrides() {
      try {
        const parsed = JSON.parse(localStorage.getItem(DAUGHTER_PERIOD_OVERRIDES_KEY) || '{}');
        state.daughterPeriodOverrides = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        state.daughterPeriodOverrides = {};
      }
      ensureDaughterStorageShape();
    }

    function saveDaughterPeriodOverrides() {
      ensureDaughterStorageShape();
      localStorage.setItem(DAUGHTER_PERIOD_OVERRIDES_KEY, JSON.stringify(state.daughterPeriodOverrides || {}));
    }

    function isValidDateKey(key) {
      const date = dateFromKey(key);
      return Boolean(date && dateKey(date) === key);
    }

    function makeExtraDaughterPeriod(id, data) {
      if (!data || !isValidDateKey(data.start) || !isValidDateKey(data.end)) return null;
      let start = dateFromKey(data.start);
      let end = dateFromKey(data.end);
      if (end < start) {
        const tmp = start;
        start = end;
        end = tmp;
      }
      return {
        index: null,
        periodKey: `extra:${id}`,
        defaultStart: startOfLocalDay(start),
        defaultEnd: startOfLocalDay(end),
        start: startOfLocalDay(start),
        end: startOfLocalDay(end),
        customized: true,
        extra: true,
        deleted: false
      };
    }

    function buildDaughterPeriod(index) {
      const anchorStart = dateFromKey(DAUGHTER_ANCHOR_START_KEY);
      const anchorEnd = dateFromKey(DAUGHTER_ANCHOR_END_KEY);
      const defaultStart = addLocalDays(anchorStart, index * DAUGHTER_PERIOD_INTERVAL_DAYS);
      const defaultEnd = addLocalDays(anchorEnd, index * DAUGHTER_PERIOD_INTERVAL_DAYS);
      const periodKey = dateKey(defaultStart);
      const override = state.daughterPeriodOverrides?.[periodKey] || null;
      if (override?.deleted) {
        return {
          index,
          periodKey,
          defaultStart,
          defaultEnd,
          start: startOfLocalDay(defaultStart),
          end: startOfLocalDay(defaultEnd),
          customized: true,
          extra: false,
          deleted: true
        };
      }
      let start = override?.start && isValidDateKey(override.start) ? dateFromKey(override.start) : defaultStart;
      let end = override?.end && isValidDateKey(override.end) ? dateFromKey(override.end) : defaultEnd;
      if (end < start) {
        const tmp = start;
        start = end;
        end = tmp;
      }
      return {
        index,
        periodKey,
        defaultStart,
        defaultEnd,
        start: startOfLocalDay(start),
        end: startOfLocalDay(end),
        customized: Boolean(override),
        extra: false,
        deleted: false
      };
    }

    function daughterExtraPeriodsForRange(rangeStart, rangeEnd) {
      ensureDaughterStorageShape();
      return Object.entries(state.daughterPeriodOverrides.__extra || {})
        .map(([id, data]) => makeExtraDaughterPeriod(id, data))
        .filter(period => period && period.end >= rangeStart && period.start <= rangeEnd);
    }

    function daughterPeriodsForRange(rangeStart, rangeEnd) {
      const anchorStart = dateFromKey(DAUGHTER_ANCHOR_START_KEY);
      const anchorEnd = dateFromKey(DAUGHTER_ANCHOR_END_KEY);
      const startIndex = Math.floor(localDaysBetween(anchorEnd, rangeStart) / DAUGHTER_PERIOD_INTERVAL_DAYS) - 3;
      const endIndex = Math.ceil(localDaysBetween(anchorStart, rangeEnd) / DAUGHTER_PERIOD_INTERVAL_DAYS) + 3;
      const periods = [];
      for (let index = startIndex; index <= endIndex; index += 1) {
        const period = buildDaughterPeriod(index);
        if (!period.deleted && period.end >= rangeStart && period.start <= rangeEnd) periods.push(period);
      }
      periods.push(...daughterExtraPeriodsForRange(rangeStart, rangeEnd));
      return periods.sort((a, b) => a.start - b.start || a.end - b.end);
    }

    function daughterPeriodForDate(date) {
      const day = startOfLocalDay(date);
      const periods = daughterPeriodsForRange(addLocalDays(day, -20), addLocalDays(day, 20));
      return periods.find(period => day >= period.start && day <= period.end) || null;
    }

    function daughterPeriodByKey(periodKey) {
      if (periodKey === '__new') return makeNewDaughterPeriodDraft();
      if (String(periodKey || '').startsWith('extra:')) {
        ensureDaughterStorageShape();
        const id = String(periodKey).slice('extra:'.length);
        return makeExtraDaughterPeriod(id, state.daughterPeriodOverrides.__extra?.[id]);
      }
      const anchorStart = dateFromKey(DAUGHTER_ANCHOR_START_KEY);
      const periodStart = dateFromKey(periodKey);
      if (!anchorStart || !periodStart) return null;
      const index = Math.round(localDaysBetween(anchorStart, periodStart) / DAUGHTER_PERIOD_INTERVAL_DAYS);
      const period = buildDaughterPeriod(index);
      return period.deleted ? null : period;
    }

    function makeNewDaughterPeriodDraft() {
      const viewDate = state.monthViewDate || new Date();
      const today = startOfLocalDay(new Date());
      const firstOfMonth = monthStart(viewDate);
      const sameVisibleMonth = today.getFullYear() === firstOfMonth.getFullYear() && today.getMonth() === firstOfMonth.getMonth();
      const start = sameVisibleMonth ? today : firstOfMonth;
      return {
        index: null,
        periodKey: '__new',
        defaultStart: start,
        defaultEnd: addLocalDays(start, 7),
        start,
        end: addLocalDays(start, 7),
        customized: true,
        extra: true,
        isNew: true,
        deleted: false
      };
    }

    function formatPeriodDate(date) {
      return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
    }

    function renderDaughterPeriodEditor(period) {
      if (!els.daughterPeriodEditor) return;
      if (!period) {
        els.daughterPeriodEditor.classList.add('hidden');
        state.daughterEditorMode = 'edit';
        return;
      }
      state.selectedDaughterPeriodKey = period.periodKey;
      state.daughterEditorMode = period.isNew ? 'add' : 'edit';
      els.daughterPeriodEditor.classList.remove('hidden');
      if (els.daughterPeriodTitle) {
        if (period.isNew) {
          els.daughterPeriodTitle.textContent = 'Add daughter period';
        } else if (period.extra) {
          els.daughterPeriodTitle.textContent = `Custom daughter period · ${formatPeriodDate(period.start)} – ${formatPeriodDate(period.end)}`;
        } else {
          els.daughterPeriodTitle.textContent = `Daughter period · ${formatPeriodDate(period.start)} – ${formatPeriodDate(period.end)}`;
        }
      }
      if (els.daughterPeriodHelp) {
        if (period.isNew) {
          els.daughterPeriodHelp.textContent = 'Add a manual period. It will be saved on this device and shown with the same blue tint.';
        } else if (period.extra) {
          els.daughterPeriodHelp.textContent = 'This is a manually added period. Save to change it, or delete it if it should not be shown.';
        } else if (period.customized) {
          els.daughterPeriodHelp.textContent = 'This period has custom dates. Save again to change it, delete it, or reset to the every-other-week pattern.';
        } else {
          els.daughterPeriodHelp.textContent = 'This is generated from the every-other-week Wednesday-to-Wednesday pattern. Change only this period if needed.';
        }
      }
      if (els.daughterStartInput) els.daughterStartInput.value = dateKey(period.start);
      if (els.daughterEndInput) els.daughterEndInput.value = dateKey(period.end);
      if (els.daughterSaveBtn) els.daughterSaveBtn.textContent = period.isNew ? 'Add period' : 'Save this period';
      if (els.daughterDeleteBtn) els.daughterDeleteBtn.hidden = Boolean(period.isNew);
      if (els.daughterResetBtn) els.daughterResetBtn.hidden = Boolean(period.isNew || period.extra);
      if (els.daughterPeriodStatus) {
        els.daughterPeriodStatus.textContent = period.isNew
          ? 'Choose start and end dates, then add the period.'
          : period.extra
            ? 'Manual period saved on this device.'
            : period.customized
              ? 'Custom period saved on this device.'
              : 'Default alternating period.';
      }
    }

    function renderMonthView() {
      if (!els.monthOverlay || !els.monthGrid) return;
      const viewDate = state.monthViewDate || new Date();
      const firstOfMonth = monthStart(viewDate);
      const lastOfMonth = monthEnd(viewDate);
      const firstGridDay = addLocalDays(firstOfMonth, -((firstOfMonth.getDay() + 6) % 7));
      const lastGridDay = addLocalDays(firstGridDay, 41);
      const periods = daughterPeriodsForRange(firstGridDay, lastGridDay);
      const todayKey = dateKey(new Date());
      const selectedKey = state.selectedDaughterPeriodKey;
      const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(firstOfMonth);
      if (els.monthTitle) els.monthTitle.textContent = monthTitle;
      if (els.monthSubtitle) {
        els.monthSubtitle.textContent = `Blue tint = daughter days. Current base pattern starts ${formatPeriodDate(dateFromKey(DAUGHTER_ANCHOR_START_KEY))} and ends ${formatPeriodDate(dateFromKey(DAUGHTER_ANCHOR_END_KEY))}, then repeats every other week.`;
      }

      const html = [];
      for (let i = 0; i < 42; i += 1) {
        const day = addLocalDays(firstGridDay, i);
        const key = dateKey(day);
        const period = periods.find(candidate => day >= candidate.start && day <= candidate.end);
        const dayEvents = eventsForDayKey(key).slice(0, 4);
        const classes = ['month-day'];
        if (day.getMonth() !== firstOfMonth.getMonth()) classes.push('outside-month');
        if (key === todayKey) classes.push('today');
        if (period) classes.push('with-daughter');
        if (period?.customized || period?.extra) classes.push('custom-daughter');
        if (period && period.periodKey === selectedKey) classes.push('selected-period');
        const dots = dayEvents.length
          ? `<div class="month-day-events">${dayEvents.map(() => '<span class="month-event-dot"></span>').join('')}</div>`
          : '';
        html.push(`
          <button class="${classes.join(' ')}" type="button" data-month-day="${key}" ${period ? `data-daughter-period="${period.periodKey}"` : ''} aria-label="${htmlEscape(formatPeriodDate(day))}${period ? ', daughter day' : ''}${dayEvents.length ? `, ${dayEvents.length} task${dayEvents.length === 1 ? '' : 's'}` : ''}">
            <span class="month-day-number">${day.getDate()}</span>
            ${dots}
          </button>
        `);
      }
      els.monthGrid.innerHTML = html.join('');
      if (selectedKey) {
        const selectedPeriod = state.daughterEditorMode === 'add'
          ? makeNewDaughterPeriodDraft()
          : daughterPeriodByKey(selectedKey);
        renderDaughterPeriodEditor(selectedPeriod);
      }
    }

    function openMonthView(resetToCurrent = true) {
      if (!els.monthOverlay) return;
      if (resetToCurrent) state.monthViewDate = new Date();
      loadDaughterPeriodOverrides();
      renderMonthView();
      els.monthOverlay.classList.remove('hidden');
      document.body.classList.add('month-open');
    }

    function closeMonthView() {
      if (!els.monthOverlay) return;
      els.monthOverlay.classList.add('hidden');
      document.body.classList.remove('month-open');
      state.selectedDaughterPeriodKey = null;
      state.daughterEditorMode = 'edit';
    }

    function saveSelectedDaughterPeriod() {
      const periodKey = state.selectedDaughterPeriodKey;
      if (!periodKey) return;
      const start = els.daughterStartInput?.value || '';
      const end = els.daughterEndInput?.value || '';
      if (!isValidDateKey(start) || !isValidDateKey(end)) {
        if (els.daughterPeriodStatus) els.daughterPeriodStatus.textContent = 'Choose both a valid start date and end date.';
        return;
      }
      if (dateFromKey(end) < dateFromKey(start)) {
        if (els.daughterPeriodStatus) els.daughterPeriodStatus.textContent = 'End date must be the same day or after the start date.';
        return;
      }
      ensureDaughterStorageShape();
      if (state.daughterEditorMode === 'add' || periodKey === '__new') {
        const id = `manual-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        state.daughterPeriodOverrides.__extra[id] = { start, end };
        state.selectedDaughterPeriodKey = `extra:${id}`;
        state.daughterEditorMode = 'edit';
      } else if (String(periodKey).startsWith('extra:')) {
        const id = String(periodKey).slice('extra:'.length);
        state.daughterPeriodOverrides.__extra[id] = { start, end };
      } else {
        state.daughterPeriodOverrides[periodKey] = { start, end };
      }
      saveDaughterPeriodOverrides();
      renderMonthView();
      if (els.daughterPeriodStatus) els.daughterPeriodStatus.textContent = 'Saved this period on this device.';
    }

    function resetSelectedDaughterPeriod() {
      const periodKey = state.selectedDaughterPeriodKey;
      if (!periodKey || String(periodKey).startsWith('extra:') || periodKey === '__new') return;
      delete state.daughterPeriodOverrides[periodKey];
      state.daughterEditorMode = 'edit';
      saveDaughterPeriodOverrides();
      renderMonthView();
      if (els.daughterPeriodStatus) els.daughterPeriodStatus.textContent = 'Reset to the normal every-other-week pattern.';
    }

    function deleteSelectedDaughterPeriod() {
      const periodKey = state.selectedDaughterPeriodKey;
      if (!periodKey || periodKey === '__new') return;
      ensureDaughterStorageShape();
      if (String(periodKey).startsWith('extra:')) {
        const id = String(periodKey).slice('extra:'.length);
        delete state.daughterPeriodOverrides.__extra[id];
      } else {
        state.daughterPeriodOverrides[periodKey] = { deleted: true };
      }
      state.selectedDaughterPeriodKey = null;
      state.daughterEditorMode = 'edit';
      saveDaughterPeriodOverrides();
      renderDaughterPeriodEditor(null);
      renderMonthView();
      if (els.monthSubtitle) els.monthSubtitle.textContent = 'Period deleted on this device. Use Add daughter period if you need to add a replacement.';
    }

    function showAddDaughterPeriodEditor() {
      state.selectedDaughterPeriodKey = '__new';
      state.daughterEditorMode = 'add';
      renderMonthView();
      renderDaughterPeriodEditor(makeNewDaughterPeriodDraft());
      els.daughterPeriodEditor?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }

    function bindMonthView() {
      if (!els.monthOverlay) return;
      loadDaughterPeriodOverrides();
      els.monthCloseBtn?.addEventListener('click', closeMonthView);
      els.monthOverlay.addEventListener('click', event => {
        if (event.target === els.monthOverlay) closeMonthView();
      });
      els.monthPrevBtn?.addEventListener('click', () => {
        state.monthViewDate = new Date(state.monthViewDate.getFullYear(), state.monthViewDate.getMonth() - 1, 1);
        state.selectedDaughterPeriodKey = null;
        state.daughterEditorMode = 'edit';
        renderMonthView();
      });
      els.monthNextBtn?.addEventListener('click', () => {
        state.monthViewDate = new Date(state.monthViewDate.getFullYear(), state.monthViewDate.getMonth() + 1, 1);
        state.selectedDaughterPeriodKey = null;
        state.daughterEditorMode = 'edit';
        renderMonthView();
      });
      els.monthTodayBtn?.addEventListener('click', () => {
        state.monthViewDate = new Date();
        state.selectedDaughterPeriodKey = null;
        state.daughterEditorMode = 'edit';
        renderMonthView();
      });
      els.monthSettingsBtn?.addEventListener('click', () => {
        openConfigMenu();
      });

      const handleMonthDaySinglePress = button => {
        const day = dateFromKey(button.dataset.monthDay);
        const period = day ? daughterPeriodForDate(day) : null;
        state.daughterEditorMode = 'edit';
        if (period) {
          renderDaughterPeriodEditor(period);
          renderMonthView();
        } else {
          state.selectedDaughterPeriodKey = null;
          renderDaughterPeriodEditor(null);
          renderMonthView();
          if (els.monthSubtitle) els.monthSubtitle.textContent = 'That day is not inside a daughter period. Tap a blue day to adjust one period.';
        }
      };

      const openMonthDayInDisplay = dayKey => {
        if (!eventsForDayKey(dayKey).length) return false;
        if (monthDayTapTimer) clearTimeout(monthDayTapTimer);
        monthDayTapTimer = null;
        monthDayLastKey = '';
        monthDayLastAt = 0;
        closeMonthView();
        requestAnimationFrame(() => selectDayPreview(dayKey));
        return true;
      };

      let monthDayTapTimer = null;
      let monthDayLastKey = '';
      let monthDayLastAt = 0;

      const handleMonthDayPress = event => {
        const button = event.target.closest('[data-month-day]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();

        const dayKey = button.dataset.monthDay;
        const now = Date.now();
        const isBrowserDoubleClick = Number(event.detail || 0) >= 2;
        const isTimedDoublePress = dayKey === monthDayLastKey && now - monthDayLastAt < 650;
        const isDoublePress = isBrowserDoubleClick || isTimedDoublePress;

        if (isDoublePress) {
          if (openMonthDayInDisplay(dayKey)) return;
          handleMonthDaySinglePress(button);
          return;
        }

        if (monthDayTapTimer) clearTimeout(monthDayTapTimer);
        monthDayLastKey = dayKey;
        monthDayLastAt = now;
        monthDayTapTimer = setTimeout(() => {
          monthDayTapTimer = null;
          handleMonthDaySinglePress(button);
        }, 360);
      };

      els.monthGrid?.addEventListener('click', handleMonthDayPress);
      els.monthGrid?.addEventListener('dblclick', event => {
        const button = event.target.closest('[data-month-day]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        openMonthDayInDisplay(button.dataset.monthDay);
      });
      els.daughterAddBtn?.addEventListener('click', showAddDaughterPeriodEditor);
      els.daughterSaveBtn?.addEventListener('click', saveSelectedDaughterPeriod);
      els.daughterDeleteBtn?.addEventListener('click', deleteSelectedDaughterPeriod);
      els.daughterResetBtn?.addEventListener('click', resetSelectedDaughterPeriod);
      window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !els.monthOverlay.classList.contains('hidden')) closeMonthView();
      });
    }

    function parseEventDate(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    function repeatLabel(event) {
      const repeat = event?.repeat || 'none';
      return {
        none: '',
        yearly: 'Yearly',
        weekly: 'Weekly',
        biweekly: 'Every other week'
      }[repeat] || '';
    }

    function eventDurationMs(event) {
      const start = parseEventDate(event.start);
      const end = parseEventDate(event.end);
      if (!start || !end || end <= start) return 60 * 60 * 1000;
      return end - start;
    }

    function isOccurrenceCompleted(event, occurrenceDate = null) {
      const repeat = event.repeat || 'none';
      if (repeat === 'none') return Boolean(event.completed);
      if (!occurrenceDate) return false;
      const completedDates = Array.isArray(event.completedDates) ? event.completedDates : [];
      return completedDates.includes(dateKey(occurrenceDate));
    }

    function isOccurrenceExcluded(event, occurrenceDate = null) {
      if ((event.repeat || 'none') === 'none' || !occurrenceDate) return false;
      const excludedDates = Array.isArray(event.excludedDates) ? event.excludedDates : [];
      return excludedDates.includes(dateKey(occurrenceDate));
    }

    function makeOccurrence(event, occurrenceStart, index = 0) {
      const duration = eventDurationMs(event);
      const occurrenceEnd = new Date(occurrenceStart.getTime() + duration);
      const occurrenceKey = dateKey(occurrenceStart);
      return {
        ...event,
        _sourceId: event.id,
        _occurrenceKey: occurrenceKey,
        _instanceId: `${event.id || 'event'}::${occurrenceKey}::${index}`,
        _isRecurring: (event.repeat || 'none') !== 'none',
        _completed: isOccurrenceCompleted(event, occurrenceStart),
        start: occurrenceStart.toISOString(),
        end: event.end ? occurrenceEnd.toISOString() : '',
        date: occurrenceStart
      };
    }

    function expandEventsInRange(rangeStart, rangeEnd, options = {}) {
      const includeCompleted = options.includeCompleted === true;
      const occurrences = [];
      const startRange = new Date(rangeStart);
      const endRange = new Date(rangeEnd);

      state.events.forEach(event => {
        const repeat = event.repeat || 'none';
        const start = parseEventDate(event.start);
        if (!start) return;

        if (repeat === 'none') {
          if (start >= startRange && start <= endRange) {
            const occurrence = makeOccurrence(event, start, 0);
            if (includeCompleted || !occurrence._completed) occurrences.push(occurrence);
          }
          return;
        }

        if (repeat === 'yearly') {
          let index = 0;
          for (let year = startRange.getFullYear() - 1; year <= endRange.getFullYear() + 1; year++) {
            const occurrenceStart = new Date(year, start.getMonth(), start.getDate(), start.getHours(), start.getMinutes(), 0, 0);
            if (occurrenceStart.getMonth() !== start.getMonth()) continue;
            if (occurrenceStart < start) continue;
            if (occurrenceStart >= startRange && occurrenceStart <= endRange && !isOccurrenceExcluded(event, occurrenceStart)) {
              const occurrence = makeOccurrence(event, occurrenceStart, index);
              if (includeCompleted || !occurrence._completed) occurrences.push(occurrence);
            }
            index += 1;
          }
          return;
        }

        if (repeat === 'weekly' || repeat === 'biweekly') {
          const intervalDays = repeat === 'biweekly' ? 14 : 7;
          const intervalMs = intervalDays * 86400000;
          let index = Math.max(0, Math.floor((startRange - start) / intervalMs) - 1);
          for (let i = 0; i < 80; i++) {
            const occurrenceStart = new Date(start.getTime() + index * intervalMs);
            if (occurrenceStart > endRange) break;
            if (occurrenceStart >= startRange && occurrenceStart <= endRange && !isOccurrenceExcluded(event, occurrenceStart)) {
              const occurrence = makeOccurrence(event, occurrenceStart, index);
              if (includeCompleted || !occurrence._completed) occurrences.push(occurrence);
            }
            index += 1;
          }
        }
      });

      return occurrences.sort((a, b) => a.date - b.date);
    }

    function getSourceEvent(id) {
      return state.events.find(event => event.id === id || event.id === String(id || '').split('::')[0]);
    }

    function htmlEscape(value) {
      return String(value || '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
      }[char]));
    }



    function normalizeReminderEmail(value) {
      return String(value || '').trim().toLowerCase();
    }

    function isValidReminderEmail(value) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
    }

    function getStoredReminderEmails() {
      return HARD_CODED_REMINDER_CONTACTS.map(contact => contact.email);
    }

    function saveStoredReminderEmails() {
      return getStoredReminderEmails();
    }

    function reminderContactLabel(email) {
      const normalized = normalizeReminderEmail(email);
      const contact = HARD_CODED_REMINDER_CONTACTS.find(item => normalizeReminderEmail(item.email) === normalized);
      return contact ? `${contact.name} (${contact.email})` : email;
    }

    function reminderRecipientNames(emails = []) {
      return [...new Set((emails || []).map(normalizeReminderEmail).filter(isValidReminderEmail))]
        .map(email => {
          const contact = HARD_CODED_REMINDER_CONTACTS.find(item => normalizeReminderEmail(item.email) === email);
          return contact ? contact.name : email;
        });
    }

    function getSelectedReminderRecipients() {
      if (!els.emailContactList) return [];
      return [...els.emailContactList.querySelectorAll('[data-reminder-recipient]:checked')]
        .map(input => normalizeReminderEmail(input.value))
        .filter(isValidReminderEmail)
        .filter(email => getStoredReminderEmails().includes(email));
    }

    function setEmailReminderOptionsVisible() {
      if (!els.emailReminderOptions || !els.emailReminderInput) return;
      els.emailReminderOptions.classList.toggle('hidden', !els.emailReminderInput.checked);
    }

    function renderEmailContacts(selected = []) {
      if (!els.emailContactList) return;
      const selectedSet = new Set((selected || []).map(normalizeReminderEmail).filter(isValidReminderEmail));
      els.emailContactList.innerHTML = HARD_CODED_REMINDER_CONTACTS.map(contact => {
        const email = normalizeReminderEmail(contact.email);
        return `
          <label class="email-contact-row">
            <input type="checkbox" data-reminder-recipient value="${htmlEscape(email)}" ${selectedSet.has(email) ? 'checked' : ''}>
            <span>${htmlEscape(contact.name)} <small>${htmlEscape(contact.email)}</small></span>
          </label>
        `;
      }).join('');
    }

    function collectEmailReminderPayload() {
      if (!els.emailReminderInput?.checked) {
        return { enabled: false, recipients: [] };
      }

      const recipients = getSelectedReminderRecipients();
      if (!recipients.length) return { enabled: false, recipients: [] };

      return {
        enabled: true,
        recipients
      };
    }

    function reminderSummary(event) {
      const reminder = event?.emailReminder || {};
      const recipients = Array.isArray(reminder.recipients) ? reminder.recipients.filter(isValidReminderEmail) : [];
      if (!reminder.enabled || !recipients.length) return '';
      return `Email on creation + task-day reminder · ${reminderRecipientNames(recipients).join(', ')}`;
    }

    function taskDayReminderDate(event) {
      const start = parseEventDate(event?.start);
      if (!start) return null;
      const remindAt = new Date(start);
      if (start.getHours() < 8) {
        remindAt.setDate(remindAt.getDate() - 1);
        remindAt.setHours(12, 0, 0, 0);
      } else {
        remindAt.setHours(8, 0, 0, 0);
      }
      return remindAt;
    }

    function formatReminderDateTime(date) {
      if (!date || Number.isNaN(date.getTime())) return '';
      return new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(date);
    }

    function clearTaskCardFlipBackTimer() {
      clearTimeout(state.flipBackTimer);
      state.flipBackTimer = null;
    }

    function scheduleTaskCardFlipBack() {
      clearTaskCardFlipBackTimer();
      if (!state.heroEventFlipped && !state.selectedEventFlipped) return;
      state.flipBackTimer = setTimeout(() => {
        state.heroEventFlipped = false;
        state.selectedEventFlipped = false;
        state.flipBackTimer = null;
        renderDisplay();
      }, 30 * 1000);
    }

    function setTaskCardFlipped(target, value) {
      if (target === 'hero') state.heroEventFlipped = Boolean(value);
      if (target === 'selected') state.selectedEventFlipped = Boolean(value);
      if (state.heroEventFlipped || state.selectedEventFlipped) scheduleTaskCardFlipBack();
      else clearTaskCardFlipBackTimer();
    }

    function emailReminderStatusHtml(event, context = 'hero') {
      const sourceId = event?._sourceId || event?.id || '';
      const reminder = event?.emailReminder || {};
      const allowedEmails = getStoredReminderEmails();
      const recipients = Array.isArray(reminder.recipients)
        ? reminder.recipients.map(normalizeReminderEmail).filter(email => isValidReminderEmail(email) && allowedEmails.includes(email))
        : [];
      const enabled = Boolean(reminder.enabled) && recipients.length > 0;
      const creationSent = Boolean(reminder.creationEmailSentAt);
      const taskReminderAt = taskDayReminderDate(event);
      const taskReminderText = taskReminderAt
        ? (taskReminderAt.getTime() < Date.now()
          ? `Task-day reminder time has passed (${formatReminderDateTime(taskReminderAt)}).`
          : `Task-day reminder planned for ${formatReminderDateTime(taskReminderAt)}.`)
        : 'Task-day reminder time could not be calculated.';

      const existingSet = new Set(recipients);
      const extraContacts = HARD_CODED_REMINDER_CONTACTS.filter(contact => !existingSet.has(normalizeReminderEmail(contact.email)));
      const recipientSummary = recipients.length
        ? `<div class="email-recipient-summary"><span>Recipients:</span>${reminderRecipientNames(recipients).map(name => `<span class="email-recipient-chip">${htmlEscape(name)}</span>`).join('')}</div>`
        : '<div class="email-recipient-summary"><span>Recipients:</span><span class="email-recipient-chip"><small>None yet</small></span></div>';
      const contactRows = extraContacts.length
        ? `<div class="email-add-list">${extraContacts.map(contact => `
            <label class="email-add-row">
              <input type="checkbox" data-display-email-recipient value="${htmlEscape(normalizeReminderEmail(contact.email))}">
              <span class="email-add-person">
                <strong>${htmlEscape(contact.name)}</strong>
                <small>${htmlEscape(contact.email)}</small>
              </span>
            </label>
          `).join('')}</div>`
        : '<div class="email-add-empty">Both Therese and Thomas are already on this task.</div>';
      const addTitle = enabled ? 'Add selected' : 'Add reminders';
      const addHelp = enabled
        ? 'Choose who else should get this task. Only newly added people get the task-created email now.'
        : 'Choose who should get a task-created email now and the task-day reminder later.';
      const pill = enabled ? '<span class="email-pill">On</span>' : '<span class="email-pill off">Off</span>';

      return `
        <div class="email-status-card" data-email-reminder-panel="${htmlEscape(context)}" data-email-source-id="${htmlEscape(sourceId)}">
          <div class="email-status-title">
            <span>Email reminders</span>
            ${pill}
          </div>
          ${recipientSummary}
          <div class="email-status-lines">
            <div>${enabled ? (creationSent ? `Task-created email sent ${htmlEscape(formatReminderDateTime(new Date(reminder.creationEmailSentAt)))}` : 'Task-created email will show as sent after the server confirms it.') : 'Email reminders are off for this task.'}</div>
            <div>${htmlEscape(taskReminderText)}</div>
          </div>
          <div class="email-add-box">
            <div class="email-add-heading">${enabled ? 'Add recipient' : 'Turn on reminders'}</div>
            <div class="email-status-lines"><div>${htmlEscape(addHelp)}</div></div>
            ${contactRows}
            <div class="email-add-new">
              <button class="tiny-btn" type="button" data-display-add-email-reminders="${htmlEscape(sourceId)}">${addTitle}</button>
            </div>
          </div>
        </div>
      `;
    }

    function recipientsFromDisplayEmailPanel(panel) {
      if (!panel) return [];
      const allowedEmails = getStoredReminderEmails();
      const selected = [...panel.querySelectorAll('[data-display-email-recipient]:checked')]
        .map(input => normalizeReminderEmail(input.value))
        .filter(email => isValidReminderEmail(email) && allowedEmails.includes(email));
      return [...new Set(selected)];
    }

    async function addEmailRemindersFromDisplay(sourceId, trigger) {
      if (!ensureDisplayActionPin()) return;
      const source = getSourceEvent(sourceId);
      if (!source) throw new Error('Task not found.');
      const panel = trigger?.closest?.('[data-email-reminder-panel]') || document.querySelector(`[data-email-source-id="${CSS.escape(String(sourceId))}"]`);
      const recipients = recipientsFromDisplayEmailPanel(panel);
      if (!recipients.length) throw new Error('Choose Therese, Thomas, or both.');
      const existingRecipients = Array.isArray(source.emailReminder?.recipients)
        ? source.emailReminder.recipients.map(normalizeReminderEmail).filter(isValidReminderEmail)
        : [];
      const mergedRecipients = [...new Set([...existingRecipients, ...recipients])];
      const addedRecipients = recipients.filter(email => !existingRecipients.includes(email));
      if (!addedRecipients.length) throw new Error('Choose a recipient that is not already on this task.');
      const payload = {
        ...source,
        emailReminder: {
          ...(source.emailReminder || {}),
          enabled: true,
          recipients: mergedRecipients,
        }
      };
      await saveEvent(payload);
      state.heroEventFlipped = true;
      state.selectedEventFlipped = true;
      scheduleTaskCardFlipBack();
      setStatus?.(source.emailReminder?.enabled ? 'New email recipient added. The server will email only the new recipient now and update the task-day reminder.' : 'Email reminders added. The server will send the task-created email and schedule the task-day reminder.');
      renderAdminEvents();
      renderDisplay();
    }


    function svgData(svg) {
      return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
    }

    function placeholderFor(seed = '', label = 'Calm') {
      const options = [
        { a: '#dad2c4', b: '#a89c8b', c: '#655b50', motif: 'plant' },
        { a: '#e7dfd2', b: '#b9c4bf', c: '#6e7c73', motif: 'horizon' },
        { a: '#eee6dc', b: '#d1b99f', c: '#806a55', motif: 'coffee' },
        { a: '#e2e8e4', b: '#a9bdb8', c: '#667a74', motif: 'waves' },
        { a: '#eadfd5', b: '#cab5a2', c: '#795f4e', motif: 'table' }
      ];
      const index = Math.abs([...String(seed || label)].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % options.length;
      const p = options[index];
      const safeLabel = htmlEscape(label).slice(0, 32);
      const motif = {
        plant: `<path d="M310 310 C310 240 278 192 230 153" stroke="${p.c}" stroke-width="5" fill="none" stroke-linecap="round" opacity=".58"/><path d="M231 154 C211 132 174 128 162 151 C190 161 216 165 231 154Z" fill="${p.c}" opacity=".45"/><path d="M270 205 C250 178 213 176 197 198 C225 212 251 217 270 205Z" fill="${p.c}" opacity=".35"/><path d="M306 252 C334 224 376 224 390 249 C358 264 327 268 306 252Z" fill="${p.c}" opacity=".34"/>`,
        horizon: `<path d="M0 265 C115 210 228 330 350 260 C450 202 526 235 640 190 L640 420 L0 420Z" fill="${p.b}" opacity=".55"/><circle cx="475" cy="130" r="46" fill="#fff8ed" opacity=".7"/>`,
        coffee: `<ellipse cx="315" cy="300" rx="175" ry="34" fill="${p.c}" opacity=".16"/><rect x="235" y="175" width="120" height="95" rx="20" fill="#fff8ed" opacity=".68"/><path d="M354 198 h23 c35 0 35 48 0 48 h-23" stroke="#fff8ed" stroke-width="18" fill="none" opacity=".68"/><path d="M265 150 C255 128 286 124 274 101 M311 151 C301 126 335 126 322 99" stroke="${p.c}" stroke-width="5" fill="none" opacity=".32"/>`,
        waves: `<path d="M0 235 C70 205 120 265 190 235 S310 205 380 235 S505 265 640 220 V420 H0Z" fill="${p.b}" opacity=".5"/><path d="M0 295 C80 260 135 330 215 295 S355 260 435 295 S550 330 640 285" stroke="#fff8ed" stroke-width="10" fill="none" opacity=".55"/>`,
        table: `<rect x="135" y="245" width="370" height="16" rx="8" fill="${p.c}" opacity=".35"/><rect x="170" y="260" width="22" height="78" rx="10" fill="${p.c}" opacity=".22"/><rect x="450" y="260" width="22" height="78" rx="10" fill="${p.c}" opacity=".22"/><circle cx="300" cy="203" r="48" fill="#fff8ed" opacity=".45"/><path d="M362 183 C405 172 439 189 463 222" stroke="${p.c}" stroke-width="9" fill="none" opacity=".24"/>`
      }[p.motif];

      return svgData(`
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420">
          <defs>
            <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
              <stop stop-color="${p.a}"/>
              <stop offset="1" stop-color="${p.b}"/>
            </linearGradient>
            <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 .06"/></feComponentTransfer></filter>
          </defs>
          <rect width="640" height="420" fill="url(#g)"/>
          <rect width="640" height="420" filter="url(#grain)"/>
          <circle cx="105" cy="80" r="130" fill="#fff8ed" opacity=".26"/>
          ${motif}
          <text x="34" y="374" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="${p.c}" opacity=".46">${safeLabel}</text>
        </svg>
      `);
    }

    function weatherCodeToIcon(code) {
      if ([0].includes(code)) return '☀️';
      if ([1, 2].includes(code)) return '🌤️';
      if ([3].includes(code)) return '☁️';
      if ([45, 48].includes(code)) return '🌫️';
      if ([51, 53, 55, 56, 57].includes(code)) return '🌦️';
      if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '🌧️';
      if ([71, 73, 75, 77, 85, 86].includes(code)) return '❄️';
      if ([95, 96, 99].includes(code)) return '⛈️';
      return '🌤️';
    }

    function weatherCodeToText(code) {
      if ([0].includes(code)) return 'Clear';
      if ([1, 2].includes(code)) return 'Partly cloudy';
      if ([3].includes(code)) return 'Cloudy';
      if ([45, 48].includes(code)) return 'Fog';
      if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
      if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
      if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
      if ([95, 96, 99].includes(code)) return 'Thunderstorm';
      return 'Mixed weather';
    }


    function weatherCodeToEffect(code) {
      if ([0].includes(code)) return 'clear';
      if ([1, 2].includes(code)) return 'partly';
      if ([3].includes(code)) return 'clouds';
      if ([45, 48].includes(code)) return 'fog';
      if ([51, 53, 55, 56, 57].includes(code)) return 'drizzle';
      if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
      if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
      if ([95, 96, 99].includes(code)) return 'thunder';
      return 'partly';
    }

    function getISOWeek(date) {
      const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      const dayNumber = copy.getUTCDay() || 7;
      copy.setUTCDate(copy.getUTCDate() + 4 - dayNumber);
      const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
      return Math.ceil((((copy - yearStart) / 86400000) + 1) / 7);
    }

    function mondayOfWeek(date) {
      const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const day = copy.getDay() || 7;
      copy.setDate(copy.getDate() - day + 1);
      copy.setHours(0, 0, 0, 0);
      return copy;
    }

    function eventsForDayKey(dayKey) {
      const day = dateFromKey(dayKey);
      if (!day) return [];
      const start = new Date(day);
      const end = new Date(day);
      end.setHours(23, 59, 59, 999);
      return expandEventsInRange(start, end, { includeCompleted: false });
    }

    function renderWeekView() {
      if (!els.weekView) return;
      const now = new Date();
      const monday = mondayOfWeek(now);
      const days = Array.from({ length: 14 }, (_, index) => {
        const date = new Date(monday);
        date.setDate(monday.getDate() + index);
        return date;
      });

      const firstWeek = getISOWeek(days[0]);
      const secondWeek = getISOWeek(days[7]);
      const title = firstWeek === secondWeek ? `Week ${firstWeek}` : `Week ${firstWeek} / ${secondWeek}`;

      els.weekView.innerHTML = `
        <div class="week-view-title">${title}</div>
        <div class="week-strip">
          ${days.map(day => {
            const key = dateKey(day);
            const dayEvents = eventsForDayKey(key);
            const isToday = sameDay(day, now);
            const hasEvent = dayEvents.length > 0;
            const isSelected = state.selectedDayKey === key;
            const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day);
            const label = hasEvent
              ? `${dayName} ${day.getDate()}, ${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}`
              : `${dayName} ${day.getDate()}, no event`;
            return `
              <button class="week-day${isToday ? ' today' : ''}${hasEvent ? ' has-event' : ''}${isSelected ? ' selected' : ''}" type="button" data-day="${key}" ${hasEvent ? '' : 'disabled'} aria-label="${htmlEscape(label)}">
                <div class="week-day-name">${htmlEscape(dayName)}</div>
                <div class="week-day-number">${day.getDate()}</div>
                <div class="week-event-dot"></div>
              </button>
            `;
          }).join('')}
        </div>
      `;
    }

    function renderDailyCalendarPanel() {
      if (!els.dailyCalendarPanel) return;
      const now = new Date();
      const monday = mondayOfWeek(now);
      const days = Array.from({ length: 14 }, (_, index) => {
        const date = new Date(monday);
        date.setDate(monday.getDate() + index);
        return date;
      });
      const title = `Calendar · Week ${getISOWeek(days[0])}${getISOWeek(days[0]) === getISOWeek(days[7]) ? '' : ` / ${getISOWeek(days[7])}`}`;
      els.dailyCalendarPanel.innerHTML = `
        <div class="daily-calendar-inner">
          <div class="daily-calendar-title">${htmlEscape(title)}</div>
          <div class="daily-calendar-grid">
            ${days.map(day => {
              const key = dateKey(day);
              const dayEvents = eventsForDayKey(key);
              const isToday = sameDay(day, now);
              const hasEvent = dayEvents.length > 0;
              const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day);
              return `
                <button class="daily-calendar-day${isToday ? ' today' : ''}${hasEvent ? ' has-event' : ''}" type="button" data-daily-calendar-day="${key}" ${hasEvent ? '' : 'disabled'} aria-label="${htmlEscape(`${dayName} ${day.getDate()}, ${dayEvents.length} task${dayEvents.length === 1 ? '' : 's'}`)}">
                  <div class="daily-calendar-name">${htmlEscape(dayName)}</div>
                  <div class="daily-calendar-number">${day.getDate()}</div>
                  <div class="daily-calendar-count">${hasEvent ? `${dayEvents.length} task${dayEvents.length === 1 ? '' : 's'}` : ''}</div>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    function handleDailyCalendarDayPick(event) {
      const dayButton = event.target.closest?.('[data-daily-calendar-day]');
      if (!dayButton || dayButton.disabled) return false;
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      selectDayPreview(dayButton.dataset.dailyCalendarDay);
      return true;
    }

    function hideSelectedEventPanel() {
      els.weatherCard.classList.remove('show-selected-event');
      if (els.selectedEventPanel) els.selectedEventPanel.innerHTML = '';
    }


    function occurrenceByInstanceId(instanceId, options = {}) {
      if (!instanceId) return null;
      const now = new Date();
      const rangeStart = new Date(now.getTime() - 7 * 86400000);
      const rangeEnd = new Date(now.getTime() + 365 * 86400000);
      return expandEventsInRange(rangeStart, rangeEnd, { includeCompleted: options.includeCompleted === true })
        .find(event => event._instanceId === instanceId) || null;
    }

    function eventDetailsText(event) {
      const repeat = repeatLabel(event);
      return [
        event.note || 'No note added for this task.',
        event.location ? `Location: ${event.location}` : '',
        repeat ? `Repeats: ${repeat}` : '',
        event._isRecurring ? 'This is one occurrence of a repeating task.' : ''
      ].filter(Boolean).join('\n\n');
    }


    function clampPercent(value, fallback) {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
    }

    function clampZoom(value, fallback = 1.01) {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.max(1, Math.min(1.8, Math.round(number * 100) / 100));
    }

    function imageFocusStyle(event, fallbackY = 38) {
      const hasImage = Boolean(event?.imageUrl);
      const x = clampPercent(event?.imageFocusX, 50);
      const y = clampPercent(event?.imageFocusY, hasImage ? fallbackY : 50);
      const zoom = clampZoom(event?.imageZoom, 1.01);
      return `--image-focus-x:${x}%;--image-focus-y:${y}%;--image-scale:${zoom};`;
    }

    function applyImageFocus(imageElement, event, fallbackY = 38) {
      if (!imageElement) return;
      const hasImage = Boolean(event?.imageUrl);
      const x = clampPercent(event?.imageFocusX, 50);
      const y = clampPercent(event?.imageFocusY, hasImage ? fallbackY : 50);
      const zoom = clampZoom(event?.imageZoom, 1.01);
      imageElement.style.setProperty('--image-focus-x', `${x}%`);
      imageElement.style.setProperty('--image-focus-y', `${y}%`);
      imageElement.style.setProperty('--image-scale', zoom);
    }

    function normalizeFocusBox(box) {
      if (!box || typeof box !== 'object') return null;
      const left = clampPercent(box.left, 0);
      const top = clampPercent(box.top, 0);
      const right = clampPercent(box.right, 100);
      const bottom = clampPercent(box.bottom, 100);
      if (!Number.isFinite(left + top + right + bottom) || right <= left || bottom <= top) return null;
      return { left, top, right, bottom };
    }

    function focusPayloadExtras(source) {
      if (!source || typeof source !== 'object') return {};
      const extras = {};
      const focusBox = normalizeFocusBox(source.imageFocusBox);
      if (focusBox) extras.imageFocusBox = focusBox;

      const naturalWidth = Number(source.imageNaturalWidth);
      const naturalHeight = Number(source.imageNaturalHeight);
      if (Number.isFinite(naturalWidth) && naturalWidth > 0) extras.imageNaturalWidth = Math.round(naturalWidth);
      if (Number.isFinite(naturalHeight) && naturalHeight > 0) extras.imageNaturalHeight = Math.round(naturalHeight);

      return extras;
    }

    function currentImageFocusPayload() {
      if (!state.pendingImageFocus) return {};
      return {
        imageFocusX: clampPercent(state.pendingImageFocus.imageFocusX, 50),
        imageFocusY: clampPercent(state.pendingImageFocus.imageFocusY, 38),
        imageFocusSource: 'manual',
        imageZoom: clampZoom(state.pendingImageFocus.imageZoom, 1.01),
        ...focusPayloadExtras(state.pendingImageFocus)
      };
    }

    function focusFromEvent(event) {
      if (!event || !Number.isFinite(Number(event.imageFocusX)) || !Number.isFinite(Number(event.imageFocusY))) return null;
      return {
        imageFocusX: clampPercent(event.imageFocusX, 50),
        imageFocusY: clampPercent(event.imageFocusY, 38),
        imageFocusSource: event.imageFocusSource || 'manual',
        imageZoom: clampZoom(event.imageZoom, 1.01),
        ...focusPayloadExtras(event)
      };
    }

    function syncPendingFocusFromControls() {
      if (!state.pendingImageFocus) state.pendingImageFocus = { imageFocusX: 50, imageFocusY: 38, imageZoom: 1.01, imageFocusSource: 'manual' };
      state.pendingImageFocus.imageFocusX = clampPercent(els.imageFocusXInput?.value, 50);
      state.pendingImageFocus.imageFocusY = clampPercent(els.imageFocusYInput?.value, 38);
      state.pendingImageFocus.imageZoom = clampZoom(els.imageZoomInput?.value, 1.01);
      state.pendingImageFocus.imageFocusSource = 'manual';
    }

    function setManualImageControls(focus = {}) {
      const x = clampPercent(focus.imageFocusX, 50);
      const y = clampPercent(focus.imageFocusY, 38);
      const zoom = clampZoom(focus.imageZoom, 1.01);
      if (els.imageFocusXInput) els.imageFocusXInput.value = String(x);
      if (els.imageFocusYInput) els.imageFocusYInput.value = String(y);
      if (els.imageZoomInput) els.imageZoomInput.value = String(zoom);
      state.pendingImageFocus = { imageFocusX: x, imageFocusY: y, imageZoom: zoom, imageFocusSource: 'manual' };
      renderManualImagePreview();
    }

    function setManualImagePreviewSource(src) {
      if (!els.manualImageEditor || !els.imagePreview) return;
      if (!src) {
        els.manualImageEditor.classList.remove('visible');
        els.imagePreview.removeAttribute('src');
        return;
      }
      els.imagePreview.src = src;
      els.manualImageEditor.classList.add('visible');
      renderManualImagePreview();
    }

    function renderManualImagePreview() {
      if (!els.manualImageEditor || !els.imagePreview) return;
      syncPendingFocusFromControls();
      const focus = state.pendingImageFocus || {};
      els.imagePreview.style.setProperty('--image-focus-x', `${clampPercent(focus.imageFocusX, 50)}%`);
      els.imagePreview.style.setProperty('--image-focus-y', `${clampPercent(focus.imageFocusY, 38)}%`);
      els.imagePreview.style.setProperty('--image-scale', clampZoom(focus.imageZoom, 1.01));
      if (els.imagePreviewTitle) els.imagePreviewTitle.textContent = els.titleInput?.value?.trim() || 'Task title';
    }

    function clearManualImagePreview() {
      if (state.imagePreviewObjectUrl) {
        URL.revokeObjectURL(state.imagePreviewObjectUrl);
        state.imagePreviewObjectUrl = null;
      }
      setManualImagePreviewSource('');
    }

    function updateImageFocusPreview(file) {
      state.pendingImageFocus = { imageFocusX: 50, imageFocusY: 38, imageZoom: 1.01, imageFocusSource: 'manual' };
      state.imageFocusToken += 1;
      if (state.imagePreviewObjectUrl) URL.revokeObjectURL(state.imagePreviewObjectUrl);
      state.imagePreviewObjectUrl = file ? URL.createObjectURL(file) : null;
      if (!file) {
        clearManualImagePreview();
        return;
      }
      setManualImageControls(state.pendingImageFocus);
      setManualImagePreviewSource(state.imagePreviewObjectUrl);
      const baseMessage = file.size > MAX_UPLOAD_BYTES
        ? `${file.name} selected (${formatBytes(file.size)}). It will be compressed before upload.`
        : `${file.name} selected (${formatBytes(file.size)}).`;
      els.imageStatus.textContent = `${baseMessage} Adjust pan and zoom below before saving.`;
    }

    function renderHeroEvent(event) {
      if (!event || event._completed) return;
      const date = new Date(event.start);
      const dayLabel = sameDay(date, new Date()) ? 'Today' : new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
      const repeat = repeatLabel(event);
      els.heroImage.src = event.imageUrl || placeholderFor(event.id, event.title);
      els.heroImage.alt = event.title;
      applyImageFocus(els.heroImage, event);
      if (!els.heroImage.dataset.focusBound) {
        els.heroImage.addEventListener('load', () => {
          const currentMain = getDisplayEvents().main;
          if (currentMain) applyImageFocus(els.heroImage, currentMain);
        });
        els.heroImage.dataset.focusBound = '1';
      }
      els.heroKicker.textContent = `${dayLabel} · ${formatTime(date, false)}${repeat ? ` · ${repeat}` : ''}`;
      els.heroTitle.textContent = event.title;
      els.heroLocation.textContent = event.location || event.note || 'Shared calendar task';
      els.heroEvent.classList.toggle('is-flipped', state.heroEventFlipped);
      if (els.heroBack) {
        els.heroBack.innerHTML = `
          <div class="selected-event-kicker">Task details</div>
          <h2 class="hero-back-title">${htmlEscape(event.title)}</h2>
          <div class="hero-back-detail">${htmlEscape(eventDetailsText(event))}</div>
          ${emailReminderStatusHtml(event, 'hero')}
          <div class="hero-back-actions">
            <button class="tiny-btn done" type="button" data-hero-complete="${htmlEscape(event._instanceId)}">${event._completed ? 'Undo complete' : 'Mark complete'}</button>
            <button class="tiny-btn" type="button" data-hero-edit="${htmlEscape(event._sourceId || event.id)}">Change date / edit</button>
            <button class="tiny-btn danger" type="button" data-hero-delete-instance="${htmlEscape(event._instanceId)}">Delete</button>
            <button class="tiny-btn" type="button" data-hero-close>Flip back</button>
          </div>
          <div class="hero-back-return">Upcoming tasks open here. It returns to today automatically after 5 minutes.</div>
        `;
      }
    }

    function renderSelectedEventPanel(events) {
      if (!events.length) {
        hideSelectedEventPanel();
        return;
      }

      const orderedEvents = state.selectedInstanceId
        ? [...events].sort((a, b) => a._instanceId === state.selectedInstanceId ? -1 : b._instanceId === state.selectedInstanceId ? 1 : a.date - b.date)
        : events;
      const first = orderedEvents[0];
      const date = new Date(first.start);
      const otherEvents = orderedEvents.slice(1, 4);
      const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
      const timeLabel = formatTime(date, false);
      const repeat = repeatLabel(first);
      const details = eventDetailsText(first);

      els.weatherCard.classList.add('show-selected-event');
      els.selectedEventPanel.innerHTML = `
        <div class="selected-event-flip${state.selectedEventFlipped ? ' is-flipped' : ''}" data-selected-flip>
          <div class="selected-event-inner">
            <div class="selected-event-face selected-event-front">
              <img class="selected-event-image" alt="" src="${htmlEscape(first.imageUrl || placeholderFor(first.id, first.title))}" style="${imageFocusStyle(first)}">
              <div class="selected-event-copy">
                <div class="selected-event-kicker">${htmlEscape(dayLabel)} · ${htmlEscape(timeLabel)}${repeat ? ` · ${htmlEscape(repeat)}` : ''}</div>
                <h2 class="selected-event-title">${htmlEscape(first.title)}</h2>
                <div class="selected-event-meta">${htmlEscape(first.location || first.note || 'Shared calendar event')}</div>
                ${otherEvents.length ? `
                  <div class="selected-event-list">
                    ${otherEvents.map(event => `<button class="tiny-btn" type="button" data-selected-pick="${htmlEscape(event._instanceId)}">${htmlEscape(formatTime(new Date(event.start), false))} · ${htmlEscape(event.title)}</button>`).join('')}
                  </div>
                ` : ''}
                <div class="flip-hint">Tap task to flip for note and actions</div>
              </div>
            </div>
            <div class="selected-event-face selected-event-back">
              <div class="selected-event-kicker">Task details</div>
              <h2 class="selected-event-title">${htmlEscape(first.title)}</h2>
              <div class="selected-event-detail">${htmlEscape(details)}</div>
              ${emailReminderStatusHtml(first, 'selected')}
              <div class="selected-event-actions">
                <button class="tiny-btn done" type="button" data-display-complete="${htmlEscape(first._instanceId)}">${first._completed ? 'Undo complete' : 'Mark complete'}</button>
                <button class="tiny-btn" type="button" data-display-edit="${htmlEscape(first._sourceId || first.id)}">Change date / edit</button>
                <button class="tiny-btn danger" type="button" data-display-delete-instance="${htmlEscape(first._instanceId)}">Delete</button>
                <button class="tiny-btn" type="button" data-selected-close>Flip back</button>
              </div>
              <div class="selected-event-return">Returns to today automatically after 5 minutes.</div>
            </div>
          </div>
        </div>
      `;
    }

    function stopSelectedDayCycle() {
      if (state.selectedDayCycleTimer) clearInterval(state.selectedDayCycleTimer);
      state.selectedDayCycleTimer = null;
      state.selectedDayCycleIndex = 0;
    }

    function stopDailyHomeTimer() {
      if (state.dailyHomeTimer) clearTimeout(state.dailyHomeTimer);
      state.dailyHomeTimer = null;
    }

    function startDailyHomeTimer() {
      stopDailyHomeTimer();
      state.dailyHomeTimer = setTimeout(() => {
        state.selectedDayKey = null;
        state.upcomingPage = 0;
        state.selectedEventFlipped = false;
        state.heroEventFlipped = false;
        state.selectedInstanceId = null;
        state.dailyCalendarMode = false;
        stopSelectedDayCycle();
        updateClock();
        renderDisplay();
      }, 5 * 60 * 1000);
    }

    function clearSelectedDayPreview() {
      state.selectedDayKey = null;
      state.upcomingPage = 0;
      state.selectedEventFlipped = false;
      state.heroEventFlipped = false;
      state.selectedInstanceId = null;
      state.dailyCalendarMode = false;
      if (state.selectedDayTimer) clearTimeout(state.selectedDayTimer);
      state.selectedDayTimer = null;
      stopDailyHomeTimer();
      stopSelectedDayCycle();
      updateClock();
      renderDisplay();
    }

    function startSelectionReturnTimer() {
      if (state.selectedDayTimer) clearTimeout(state.selectedDayTimer);
      state.selectedDayTimer = setTimeout(clearSelectedDayPreview, 5 * 60 * 1000);
    }

    function startSelectedDayCycle(dayKey) {
      stopSelectedDayCycle();
      const orderedEvents = eventsForDayKey(dayKey).sort((a, b) => new Date(a.start) - new Date(b.start));
      if (orderedEvents.length <= 1) return;
      state.selectedDayCycleTimer = setInterval(() => {
        if (state.heroEventFlipped || state.selectedEventFlipped) return;
        const currentEvents = eventsForDayKey(dayKey).sort((a, b) => new Date(a.start) - new Date(b.start));
        if (currentEvents.length <= 1) {
          stopSelectedDayCycle();
          return;
        }
        const currentIndex = Math.max(0, currentEvents.findIndex(event => event._instanceId === state.selectedInstanceId));
        const nextIndex = (currentIndex + 1) % currentEvents.length;
        state.selectedDayCycleIndex = nextIndex;
        state.selectedInstanceId = currentEvents[nextIndex]._instanceId;
        state.heroEventFlipped = false;
        state.selectedEventFlipped = false;
        renderDisplay();
      }, 10_000);
    }

    function stopTodayTaskCycle() {
      if (state.todayCycleTimer) clearInterval(state.todayCycleTimer);
      state.todayCycleTimer = null;
      state.todayCycleDateKey = null;
    }

    function getTodayEventsForCycle() {
      const todayKey = dateKey(new Date());
      return eventsForDayKey(todayKey)
        .filter(event => !event._completed)
        .sort((a, b) => new Date(a.start) - new Date(b.start));
    }

    function isShowingTodayHome() {
      if (state.selectedDayKey && state.selectedDayKey !== dateKey(new Date())) return false;
      if (!state.selectedInstanceId) return true;
      const picked = occurrenceByInstanceId(state.selectedInstanceId);
      return !picked || sameDay(picked.date || new Date(picked.start), new Date());
    }

    function ensureTodayTaskCycle() {
      if (adminMode) return;
      const todayKey = dateKey(new Date());
      const todayEvents = getTodayEventsForCycle();
      const shouldRun = isShowingTodayHome() && todayEvents.length > 1;

      if (!shouldRun) {
        stopTodayTaskCycle();
        return;
      }

      if (state.todayCycleTimer && state.todayCycleDateKey === todayKey) return;
      stopTodayTaskCycle();
      state.todayCycleDateKey = todayKey;
      state.todayCycleTimer = setInterval(() => {
        if (!isShowingTodayHome()) {
          stopTodayTaskCycle();
          return;
        }
        if (state.heroEventFlipped || state.selectedEventFlipped) return;
        const currentEvents = getTodayEventsForCycle();
        if (currentEvents.length <= 1) {
          stopTodayTaskCycle();
          return;
        }
        const currentIndex = currentEvents.findIndex(event => event._instanceId === state.selectedInstanceId);
        const nextIndex = currentIndex === -1 ? 1 : (currentIndex + 1) % currentEvents.length;
        state.selectedInstanceId = currentEvents[nextIndex]._instanceId;
        state.selectedDayKey = null;
        state.heroEventFlipped = false;
        state.selectedEventFlipped = false;
        renderDisplay();
      }, 10_000);
    }

    function selectDayPreview(dayKey) {
      const events = eventsForDayKey(dayKey);
      if (!events.length) return;
      const firstEvent = [...events].sort((a, b) => new Date(a.start) - new Date(b.start))[0];
      state.selectedDayKey = dayKey;
      state.dailyCalendarMode = false;
      stopDailyHomeTimer();
      state.upcomingPage = 0;
      state.selectedEventFlipped = false;
      state.heroEventFlipped = false;
      state.selectedInstanceId = firstEvent?._instanceId || null;
      state.selectedDayCycleIndex = 0;
      startSelectionReturnTimer();
      startSelectedDayCycle(dayKey);
      updateClock();
      renderDisplay();
    }

    function selectEventPreview(instanceId) {
      const event = occurrenceByInstanceId(instanceId);
      if (!event) return;
      const dayKey = dateKey(event.date || new Date(event.start));
      state.selectedInstanceId = instanceId;
      state.selectedDayKey = dayKey;
      state.dailyCalendarMode = false;
      stopDailyHomeTimer();
      state.upcomingPage = 0;
      state.selectedEventFlipped = false;
      state.heroEventFlipped = false;
      startSelectionReturnTimer();
      startSelectedDayCycle(dayKey);
      updateClock();
      renderDisplay();
    }

    function setMode() {
      els.adminView.classList.toggle('hidden', !adminMode);
      els.displayView.classList.toggle('hidden', adminMode);
      if (els.returnToDisplayBtn) els.returnToDisplayBtn.classList.toggle('hidden', isPhoneLike);
      if (adminMode) document.body.style.display = 'block';
      else fitKioskToScreen();
    }

    function updateClock() {
      const now = new Date();
      const split = splitTime(now);
      els.timeDisplay.textContent = split.time;
      els.ampmDisplay.textContent = split.ampm;
      els.ampmDisplay.hidden = true;
      const selectedDate = state.selectedDayKey ? dateFromKey(state.selectedDayKey) : null;
      if (selectedDate && !sameDay(selectedDate, now)) {
        const selectedLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(selectedDate);
        els.dateDisplay.innerHTML = `${htmlEscape(selectedLabel)}<span class="clock-return-hint">Click here to go home to the today view</span>`;
      } else {
        els.dateDisplay.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now);
      }
      els.adminClock.textContent = formatTime(now, false);
      if (!adminMode && els.displayView.classList.contains('no-daily')) renderWeekView();
    }

    function makeLocalEventId() {
      const random = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return `${LOCAL_EVENT_ID_PREFIX}${random}`;
    }

    function minEventFetchGapMs() {
      return adminMode ? MIN_ADMIN_FETCH_GAP_MS : MIN_DISPLAY_FETCH_GAP_MS;
    }

    function isAutomaticEventRefreshWindow(date = new Date()) {
      const hour = date.getHours();
      return hour >= AUTOMATIC_EVENT_REFRESH_START_HOUR && hour <= AUTOMATIC_EVENT_REFRESH_END_HOUR;
    }

    function msUntilNextHourlyEventRefresh() {
      const now = new Date();
      const next = new Date(now);

      if (isAutomaticEventRefreshWindow(now)) {
        // Next full hour inside the 06:00-21:00 window.
        next.setHours(now.getHours() + 1, 0, 5, 0);
        if (next.getHours() <= AUTOMATIC_EVENT_REFRESH_END_HOUR && next.getDate() === now.getDate()) {
          return Math.max(1000, next.getTime() - now.getTime());
        }
      }

      // Outside the daytime window, sleep until 06:00 next available day.
      if (now.getHours() < AUTOMATIC_EVENT_REFRESH_START_HOUR) {
        next.setHours(AUTOMATIC_EVENT_REFRESH_START_HOUR, 0, 5, 0);
      } else {
        next.setDate(now.getDate() + 1);
        next.setHours(AUTOMATIC_EVENT_REFRESH_START_HOUR, 0, 5, 0);
      }
      return Math.max(1000, next.getTime() - now.getTime());
    }

    function scheduleNextHourlyEventRefresh() {
      window.setTimeout(async () => {
        if (isAutomaticEventRefreshWindow()) {
          await fetchEvents({ force: true, reason: 'hourly-daytime' });
          await processPendingWrites({ silent: true });
        }
        scheduleNextHourlyEventRefresh();
      }, msUntilNextHourlyEventRefresh());
    }

    function requestInteractionRefresh() {
      const now = Date.now();
      if (state.interactionRefreshTimer) clearTimeout(state.interactionRefreshTimer);
      state.interactionRefreshTimer = window.setTimeout(async () => {
        if (state.eventFetchActive) return;
        if (state.lastEventFetchAt && now - state.lastEventFetchAt < minEventFetchGapMs()) return;
        await fetchEvents({ reason: 'interaction' });
        await processPendingWrites({ silent: true });
      }, INTERACTION_FETCH_DEBOUNCE_MS);
    }

    function bindInteractionRefresh() {
      const handler = event => {
        // Ignore synthetic events and the app's own timed re-renders. Real pointer/touch/keyboard
        // use is the signal that the dashboard should spend a Blob read.
        if (event.isTrusted === false) return;
        requestInteractionRefresh();
      };
      document.addEventListener('pointerdown', handler, { passive: true, capture: true });
      document.addEventListener('touchstart', handler, { passive: true, capture: true });
      document.addEventListener('keydown', handler, { passive: true, capture: true });
    }

    function getCachedEventPayload() {
      try {
        const parsed = JSON.parse(localStorage.getItem(LOCAL_EVENTS_CACHE_KEY) || 'null');
        if (!parsed || !Array.isArray(parsed.events)) return null;
        const savedAtMs = Number(parsed.savedAtMs || 0);
        if (!savedAtMs || Date.now() - savedAtMs > LOCAL_EVENTS_CACHE_MAX_AGE_MS) return null;
        return parsed;
      } catch {
        return null;
      }
    }

    function rememberCachedEvents(events) {
      try {
        localStorage.setItem(LOCAL_EVENTS_CACHE_KEY, JSON.stringify({
          savedAtMs: Date.now(),
          events: Array.isArray(events) ? events : []
        }));
      } catch {}
    }

    function hydrateEventsFromLocalCache() {
      const cached = getCachedEventPayload();
      if (!cached) return false;
      state.serverEvents = cached.events;
      refreshEventsFromServerEvents();
      renderDisplay();
      renderAdminEvents();
      return true;
    }

    function renderFromLocalState() {
      refreshEventsFromServerEvents();
      renderDisplay();
      renderAdminEvents();
    }

    function getPendingWrites() {
      try {
        const parsed = JSON.parse(localStorage.getItem(PENDING_WRITES_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function setPendingWrites(queue) {
      localStorage.setItem(PENDING_WRITES_KEY, JSON.stringify(queue.slice(0, 200)));
      updateLocalQueueStatus?.();
    }

    function getCompletionOverrides() {
      try {
        const parsed = JSON.parse(localStorage.getItem(LOCAL_COMPLETION_OVERRIDES_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    function setCompletionOverrides(overrides) {
      const now = Date.now();
      const cleaned = {};
      Object.entries(overrides || {}).forEach(([id, value]) => {
        const updatedAtMs = Number(value?.updatedAtMs || 0);
        // Keep local completion decisions for up to one day. In normal use they are cleared
        // as soon as the server returns the same completed state.
        if (updatedAtMs && now - updatedAtMs < 24 * 60 * 60 * 1000) cleaned[id] = value;
      });
      localStorage.setItem(LOCAL_COMPLETION_OVERRIDES_KEY, JSON.stringify(cleaned));
    }


    function getLocalEventMirror() {
      try {
        const parsed = JSON.parse(localStorage.getItem(LOCAL_EVENT_MIRROR_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    function setLocalEventMirror(mirror) {
      const now = Date.now();
      const cleanedEntries = Object.entries(mirror || {})
        .filter(([id, value]) => id && value?.event && Number(value.savedAtMs || 0) && now - Number(value.savedAtMs || 0) < LOCAL_EVENT_MIRROR_TTL_MS)
        .slice(-200);
      localStorage.setItem(LOCAL_EVENT_MIRROR_KEY, JSON.stringify(Object.fromEntries(cleanedEntries)));
    }

    function rememberLocalEvent(event, opId, method = 'POST') {
      if (!event?.id) return;
      const mirror = getLocalEventMirror();
      mirror[event.id] = {
        event: { ...event },
        opId: opId || '',
        method,
        savedAtMs: Date.now()
      };
      setLocalEventMirror(mirror);
    }

    function forgetLocalEvent(id) {
      if (!id) return;
      const mirror = getLocalEventMirror();
      if (!mirror[id]) return;
      delete mirror[id];
      setLocalEventMirror(mirror);
    }

    function comparableEventSnapshot(event = {}) {
      const reminder = event.emailReminder && typeof event.emailReminder === 'object' ? event.emailReminder : {};
      return {
        id: String(event.id || ''),
        title: String(event.title || ''),
        start: String(event.start || ''),
        end: String(event.end || ''),
        repeat: String(event.repeat || 'none'),
        completed: Boolean(event.completed),
        completedDates: Array.isArray(event.completedDates) ? [...new Set(event.completedDates.map(String))].sort() : [],
        excludedDates: Array.isArray(event.excludedDates) ? [...new Set(event.excludedDates.map(String))].sort() : [],
        location: String(event.location || ''),
        note: String(event.note || ''),
        imageUrl: String(event.imageUrl || ''),
        imageFocusX: clampPercent(event.imageFocusX, 50),
        imageFocusY: clampPercent(event.imageFocusY, 38),
        imageFocusSource: String(event.imageFocusSource || ''),
        imageZoom: clampZoom(event.imageZoom, 1.01),
        imageFocusBox: normalizeFocusBox(event.imageFocusBox),
        imageNaturalWidth: Number(event.imageNaturalWidth || 0) || 0,
        imageNaturalHeight: Number(event.imageNaturalHeight || 0) || 0,
        featured: Boolean(event.featured),
        emailReminder: {
          enabled: Boolean(reminder.enabled),
          recipients: Array.isArray(reminder.recipients) ? [...new Set(reminder.recipients.map(String))].sort() : []
        }
      };
    }

    function serverEventConfirmsLocalMirror(serverEvent, localEvent) {
      if (!serverEvent || !localEvent || String(serverEvent.id) !== String(localEvent.id)) return false;
      return JSON.stringify(comparableEventSnapshot(serverEvent)) === JSON.stringify(comparableEventSnapshot(localEvent));
    }

    function cleanupConfirmedLocalEventMirror(serverEvents = state.serverEvents) {
      const mirror = getLocalEventMirror();
      let changed = false;
      const now = Date.now();
      Object.entries(mirror).forEach(([id, value]) => {
        const savedAtMs = Number(value?.savedAtMs || 0);
        const heldLongEnough = savedAtMs && now - savedAtMs >= LOCAL_EVENT_MIRROR_MIN_HOLD_MS;
        const serverEvent = (serverEvents || []).find(event => String(event.id) === String(id));
        if (heldLongEnough && serverEventConfirmsLocalMirror(serverEvent, value.event)) {
          delete mirror[id];
          changed = true;
        }
      });
      if (changed) setLocalEventMirror(mirror);
    }

    function arraysEqualSet(a = [], b = []) {
      const aa = [...new Set(a)].sort();
      const bb = [...new Set(b)].sort();
      return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
    }

    function serverMatchesCompletionOverride(event, override) {
      if (!event || !override) return false;
      if ((event.repeat || 'none') === 'none') return Boolean(event.completed) === Boolean(override.completed);
      return arraysEqualSet(Array.isArray(event.completedDates) ? event.completedDates : [], Array.isArray(override.completedDates) ? override.completedDates : []);
    }

    function cleanupConfirmedCompletionOverrides(serverEvents = state.serverEvents) {
      const overrides = getCompletionOverrides();
      let changed = false;
      Object.entries(overrides).forEach(([id, override]) => {
        const serverEvent = (serverEvents || []).find(event => String(event.id) === String(id));
        if (serverMatchesCompletionOverride(serverEvent, override)) {
          delete overrides[id];
          changed = true;
        }
      });
      if (changed) setCompletionOverrides(overrides);
    }

    function saveCompletionOverride(event) {
      if (!event?.id) return;
      const overrides = getCompletionOverrides();
      if ((event.repeat || 'none') === 'none') {
        overrides[event.id] = {
          repeat: 'none',
          completed: Boolean(event.completed),
          updatedAtMs: Date.now()
        };
      } else {
        overrides[event.id] = {
          repeat: event.repeat || 'weekly',
          completedDates: Array.isArray(event.completedDates) ? [...event.completedDates] : [],
          updatedAtMs: Date.now()
        };
      }
      setCompletionOverrides(overrides);
    }

    function applyCompletionOverrides(events) {
      const overrides = getCompletionOverrides();
      if (!Object.keys(overrides).length) return events;
      return (events || []).map(event => {
        const override = overrides[event.id];
        if (!override) return event;
        if ((event.repeat || 'none') === 'none') {
          return { ...event, completed: Boolean(override.completed), _localCompletionPending: true };
        }
        return {
          ...event,
          completedDates: Array.isArray(override.completedDates) ? [...override.completedDates] : [],
          _localCompletionPending: true
        };
      });
    }

    function queueWrite(op) {
      const queue = getPendingWrites().filter(item => item.opId !== op.opId);
      queue.push(op);
      setPendingWrites(queue);
    }

    function removeQueuedWrite(opId) {
      setPendingWrites(getPendingWrites().filter(item => item.opId !== opId));
    }

    function isRetryableError(error) {
      return !error.status || error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
    }

    function upsertLocalVisibleEvent(events, event, extra = {}) {
      if (!event?.id) return events;
      const visibleEvent = { ...event, ...extra };
      const index = events.findIndex(item => String(item.id) === String(visibleEvent.id));
      if (index === -1) events.push(visibleEvent);
      else events[index] = { ...events[index], ...visibleEvent };
      return events;
    }

    function applyPendingOps(baseEvents, queue = getPendingWrites()) {
      let events = Array.isArray(baseEvents) ? [...baseEvents] : [];

      // Local mirror keeps just-created/just-edited tasks visible even if a server refresh
      // briefly returns the older Blob file before the write is visible everywhere.
      Object.values(getLocalEventMirror()).forEach(value => {
        if (value?.event) events = upsertLocalVisibleEvent(events, value.event, { _pendingLocalSave: true, _localMirrorSave: true });
      });

      queue.forEach(op => {
        if (op.method === 'DELETE_ALL') {
          events = [];
          return;
        }
        if (op.method === 'DELETE') {
          events = events.filter(event => String(event.id) !== String(op.id));
          forgetLocalEvent(op.id);
          return;
        }
        if ((op.method === 'POST' || op.method === 'PUT') && op.event) {
          events = upsertLocalVisibleEvent(events, op.event, { _pendingLocalSave: true });
        }
      });
      return applyCompletionOverrides(events).sort((a, b) => new Date(a.start) - new Date(b.start));
    }

    function signalOtherOpenViewsToRefresh() {
      try { localStorage.setItem(LAST_WRITE_SIGNAL_KEY, String(Date.now())); } catch {}
    }

    function refreshEventsFromServerEvents() {
      cleanupConfirmedCompletionOverrides(state.serverEvents);
      cleanupConfirmedLocalEventMirror(state.serverEvents);
      state.events = applyPendingOps(state.serverEvents);
    }

    async function performServerWrite(op) {
      let url = '/api/events';
      const options = { method: op.method, headers: { 'x-admin-pin': getPin() } };

      if (op.method === 'DELETE_ALL') {
        url = '/api/events?all=1';
        options.method = 'DELETE';
      } else if (op.method === 'DELETE') {
        url = `/api/events?id=${encodeURIComponent(op.id)}`;
        options.method = 'DELETE';
      } else {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(op.event);
      }

      const response = await fetch(url, options);
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) {
        const error = new Error(data.error || 'Server is busy. The change is saved on this device and will retry.');
        error.status = response.status;
        throw error;
      }
      return data;
    }

    async function processPendingWrites(options = {}) {
      if (state.pendingWriteActive) return;
      state.pendingWriteActive = true;
      let fatalError = null;
      let blockedByRetryableError = false;
      try {
        while (true) {
          const queue = getPendingWrites();
          if (!queue.length) break;
          blockedByRetryableError = false;

          for (const op of queue) {
            try {
              const data = await performServerWrite(op);
              if (data.reminderSync) state.lastReminderSync = data.reminderSync;
              if (op.event && data.event && String(data.event.id) === String(op.event.id)) {
                rememberLocalEvent(data.event, op.opId, op.method);
              }
              const serverHasSavedEvent = !op.event || !Array.isArray(data.events) || data.events.some(event => String(event.id) === String(op.event.id));
              if (serverHasSavedEvent) removeQueuedWrite(op.opId);
              if (Array.isArray(data.events)) {
                state.serverEvents = data.events;
                rememberCachedEvents(state.serverEvents);
                refreshEventsFromServerEvents();
                signalOtherOpenViewsToRefresh();
              }
            } catch (error) {
              if (!isRetryableError(error)) {
                removeQueuedWrite(op.opId);
                if (op.event?.id) forgetLocalEvent(op.event.id);
                refreshEventsFromServerEvents();
                if (!options.silent) setStatus(error.message, true);
                if (options.throwNonRetryable && (!options.targetOpId || options.targetOpId === op.opId)) {
                  fatalError = error;
                  break;
                }
                continue;
              }
              blockedByRetryableError = true;
              if (!options.silent) setStatus('Server is busy/offline. Saved on this device and will retry automatically.', true);
              break;
            }
          }

          if (fatalError || blockedByRetryableError) break;
          if (!getPendingWrites().length) break;
        }
      } finally {
        state.pendingWriteActive = false;
        refreshEventsFromServerEvents();
        updateLocalQueueStatus();
        renderDisplay();
        renderAdminEvents();
      }
      if (fatalError) throw fatalError;
    }

    async function fetchEvents(options = {}) {
      const now = Date.now();
      if (state.eventFetchActive) return;
      if (!options.force && state.lastEventFetchAt && now - state.lastEventFetchAt < minEventFetchGapMs()) {
        renderFromLocalState();
        return;
      }

      state.eventFetchActive = true;
      state.lastEventFetchAt = now;
      try {
        const url = options.force ? `/api/events?fresh=1&t=${Date.now()}` : '/api/events';
        const response = await fetch(url, { cache: options.force ? 'no-store' : 'default' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load events.');
        state.serverEvents = Array.isArray(data.events) ? data.events : [];
        rememberCachedEvents(state.serverEvents);
        refreshEventsFromServerEvents();
      } catch (error) {
        console.warn(error);
        if (!state.serverEvents.length) hydrateEventsFromLocalCache();
        else refreshEventsFromServerEvents();
      } finally {
        state.eventFetchActive = false;
      }
      renderDisplay();
      renderAdminEvents();
      processPendingWrites({ silent: true });
      const editParam = params.get('edit');
      if (adminMode && editParam && !state.editingId) setTimeout(() => editEvent(editParam), 50);
    }


    function getUpcomingDisplayLimit() {
      return DEFAULT_UPCOMING_LIMIT;
    }

    function getUpcomingCardAspectRatio() {
      const grid = els.upcomingGrid;
      const cols = Math.max(1, getUpcomingDisplayLimit());
      if (grid) {
        const styles = getComputedStyle(grid);
        const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0;
        const width = (grid.clientWidth - gap * Math.max(0, cols - 1)) / cols;
        const height = grid.clientHeight || grid.offsetHeight;
        if (width > 0 && height > 0) return width / height;
      }
      return 2.35;
    }

    function upcomingImageFocusStyle(event) {
      const hasImage = Boolean(event?.imageUrl);
      const x = clampPercent(event?.imageFocusX, 50);
      const y = clampPercent(event?.imageFocusY, hasImage ? 38 : 50);
      const zoom = clampZoom(event?.imageZoom, 1.01);
      return `--image-focus-x:${x}%;--image-focus-y:${y}%;--image-scale:${zoom};`;
    }

    function hiddenRepeatingTasksVisible() {
      return Number(state.hiddenRepeatingTasksVisibleUntil || 0) > Date.now();
    }

    function scheduleHiddenRepeatingTasksHide() {
      if (state.hiddenRepeatingTasksTimer) {
        clearTimeout(state.hiddenRepeatingTasksTimer);
        state.hiddenRepeatingTasksTimer = null;
      }
      const remaining = Number(state.hiddenRepeatingTasksVisibleUntil || 0) - Date.now();
      if (remaining > 0) {
        state.hiddenRepeatingTasksTimer = setTimeout(() => {
          state.hiddenRepeatingTasksVisibleUntil = 0;
          state.upcomingPage = 0;
          renderDisplay();
        }, Math.min(remaining, 5 * 60 * 1000 + 1000));
      }
    }

    function isHiddenFutureRepeatingOccurrence(event, cutoff = endOfNextMonth(new Date())) {
      if (!event || !event._isRecurring) return false;
      const occurrenceDate = event.date instanceof Date ? event.date : new Date(event.start);
      if (Number.isNaN(occurrenceDate.getTime())) return false;
      return occurrenceDate > cutoff;
    }

    function showHiddenRepeatingTasksTemporarily() {
      state.hiddenRepeatingTasksVisibleUntil = Date.now() + 5 * 60 * 1000;
      scheduleHiddenRepeatingTasksHide();
      renderDisplay();
    }

    function getDisplayEvents() {
      const now = new Date();
      // Daily view should keep showing today's tasks for the full calendar day.
      // Do not drop a 15:00 task just because the current time is 19:23.
      const floor = todayStart();

      // Look up to one year ahead so one-off future tasks like September events
      // can appear. Long-range repeating occurrences are still limited below
      // unless the temporary "load hidden repeats" button is used.
      const end = new Date(now.getTime() + 365 * 86400000);
      const expandedEvents = expandEventsInRange(floor, end, { includeCompleted: false });

      const repeatCutoff = endOfNextMonth(now);
      const showHiddenRepeats = hiddenRepeatingTasksVisible();
      const hiddenRepeats = expandedEvents.filter(event => isHiddenFutureRepeatingOccurrence(event, repeatCutoff));
      const events = showHiddenRepeats
        ? expandedEvents
        : expandedEvents.filter(event => !isHiddenFutureRepeatingOccurrence(event, repeatCutoff));

      if (state.selectedInstanceId && !events.some(event => event._instanceId === state.selectedInstanceId)) {
        state.selectedInstanceId = null;
      }

      const todays = events
        .filter(event => sameDay(event.date, now) && !event._completed)
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      const featuredToday = todays.find(event => event.featured) || null;

      // Main hero should only show intentionally featured tasks for today.
      // Featured future tasks belong in Upcoming, not the hero.
      const daily = featuredToday || null;
      const selected = state.selectedInstanceId ? events.find(event => event._instanceId === state.selectedInstanceId) : null;
      const main = selected || daily;
      if (!selected && daily && todays.length > 1 && !state.todayCycleTimer) state.selectedInstanceId = daily._instanceId;

      const candidates = events
        .filter(event => !main || event._instanceId !== main._instanceId)
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      // Show the next 15 normal upcoming tasks, but always include manually
      // featured future tasks within the one-year window even if they are past
      // the first 15. This fixes the case where a September event is marked
      // featured after creation but would otherwise be crowded out.
      const nextUpcoming = candidates.slice(0, 15);
      const included = new Set(nextUpcoming.map(event => event._instanceId));
      const featuredFuture = candidates.filter(event => event.featured && !included.has(event._instanceId));
      const allUpcoming = [...nextUpcoming, ...featuredFuture]
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      const upcomingLimit = getUpcomingDisplayLimit();
      const maxUpcomingPage = Math.max(0, Math.ceil(allUpcoming.length / upcomingLimit) - 1);
      if (state.upcomingPage > maxUpcomingPage) state.upcomingPage = maxUpcomingPage;
      const startIndex = state.upcomingPage * upcomingLimit;
      const upcoming = allUpcoming.slice(startIndex, startIndex + upcomingLimit);
      return {
        daily,
        main,
        upcoming,
        allUpcomingCount: allUpcoming.length,
        upcomingPage: state.upcomingPage,
        maxUpcomingPage,
        upcomingLimit,
        hiddenRepeatsCount: showHiddenRepeats ? 0 : hiddenRepeats.length,
        hiddenRepeatsVisible: showHiddenRepeats
      };
    }



    function renderUpcomingPager(total, page, maxPage, upcomingLimit = getUpcomingDisplayLimit(), hiddenRepeatsCount = 0, hiddenRepeatsVisible = false) {
      if (!els.upcomingPager) return;
      const showLoadHiddenButton = hiddenRepeatsCount > 0 && !hiddenRepeatsVisible && page >= maxPage;
      if (total <= upcomingLimit && !showLoadHiddenButton) {
        els.upcomingPager.innerHTML = '';
        return;
      }
      const currentStart = total ? page * upcomingLimit + 1 : 0;
      const currentEnd = total ? Math.min(total, currentStart + upcomingLimit - 1) : 0;
      const pageCount = total
        ? `<span class="upcoming-page-count">${currentStart}-${currentEnd} / ${total}</span>`
        : `<span class="upcoming-page-count">0 / 0</span>`;
      const loadHiddenButton = showLoadHiddenButton
        ? `<button class="upcoming-load-hidden" type="button" data-load-hidden-repeats>Load hidden repeats · ${hiddenRepeatsCount}</button>`
        : '';
      els.upcomingPager.innerHTML = `
        <button class="upcoming-arrow" type="button" data-upcoming-page="prev" ${page <= 0 ? 'disabled' : ''} aria-label="Previous upcoming tasks">‹</button>
        ${pageCount}
        <button class="upcoming-arrow" type="button" data-upcoming-page="next" ${page >= maxPage ? 'disabled' : ''} aria-label="Next upcoming tasks">›</button>
        ${loadHiddenButton}
      `;
    }

    function renderDisplay() {
      if (adminMode) return;
      const { daily, main, upcoming, allUpcomingCount, upcomingPage, maxUpcomingPage, upcomingLimit, hiddenRepeatsCount, hiddenRepeatsVisible } = getDisplayEvents();
      const hasMainEvent = Boolean(main);
      els.displayView.classList.toggle('no-daily', !hasMainEvent);
      els.displayView.classList.toggle('daily-calendar-mode', Boolean(hasMainEvent && state.dailyCalendarMode));
      state.weatherFocusDate = main ? new Date(main.date || main.start) : new Date();
      renderWeather();
      renderDailyCalendarPanel();

      if (!hasMainEvent) {
        renderWeekView();
        hideSelectedEventPanel();
      } else {
        hideSelectedEventPanel();
        renderHeroEvent(main);
      }
      fitKioskToScreen();
      scheduleHiddenRepeatingTasksHide();
      renderUpcomingPager(allUpcomingCount, upcomingPage, maxUpcomingPage, upcomingLimit, hiddenRepeatsCount, hiddenRepeatsVisible);

      if (!upcoming.length) {
        if (els.upcomingGrid) els.upcomingGrid.style.setProperty('--upcoming-cols', String(getUpcomingDisplayLimit()));
        els.upcomingGrid.innerHTML = '<div class="empty-upcoming" style="grid-column:1/-1">No upcoming events yet</div>';
        ensureTodayTaskCycle();
        return;
      }

      ensureTodayTaskCycle();
      if (els.upcomingGrid) els.upcomingGrid.style.setProperty('--upcoming-cols', String(upcomingLimit));
      els.upcomingGrid.innerHTML = upcoming.map(event => {
        const date = new Date(event.start);
        const exactDate = formatUpcomingDate(date);
        return `
          <button class="mini-event" type="button" data-upcoming-pick="${htmlEscape(event._instanceId)}" aria-label="Open ${htmlEscape(event.title)} on ${htmlEscape(exactDate)}">
            <img alt="" src="${htmlEscape(event.imageUrl || placeholderFor(event.id, event.title))}" style="${upcomingImageFocusStyle(event)}">
            <span class="mini-copy">
              <span class="mini-time">${htmlEscape(exactDate)} · ${formatTime(date, false)}</span>
              <span class="mini-title">${htmlEscape(event.title)}</span>
            </span>
          </button>
        `;
      }).join('');
    }

    async function fetchWeather() {
      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast');
        url.search = new URLSearchParams({
          latitude: WEATHER_CONFIG.lat,
          longitude: WEATHER_CONFIG.lon,
          timezone: WEATHER_CONFIG.timezone,
          current: 'temperature_2m,weather_code',
          hourly: 'temperature_2m,weather_code,precipitation_probability',
          daily: 'weather_code,temperature_2m_max,temperature_2m_min',
          forecast_days: '10'
        }).toString();

        const response = await fetch(url);
        if (!response.ok) throw new Error('Weather fetch failed');
        state.weather = await response.json();
      } catch (error) {
        state.weather = null;
      }
      renderWeather();
    }

    function renderWeatherEffect(code) {
      if (!els.weatherEffect) return;
      const effect = weatherCodeToEffect(code);
      els.weatherEffect.className = `weather-effect ${effect}`;

      if (effect === 'rain' || effect === 'drizzle' || effect === 'thunder') {
        const count = effect === 'drizzle' ? 34 : 52;
        els.weatherEffect.innerHTML = Array.from({ length: count }, (_, index) => {
          const x = (index * 37) % 104;
          const dur = effect === 'drizzle' ? 2400 + (index % 8) * 150 : 1350 + (index % 7) * 120;
          const delay = -((index * 173) % 1800);
          const height = effect === 'drizzle' ? 20 + (index % 5) * 3 : 34 + (index % 6) * 6;
          const width = effect === 'drizzle' ? 1 : 1 + (index % 2);
          const opacity = effect === 'drizzle' ? 0.18 + (index % 4) * 0.035 : 0.26 + (index % 5) * 0.045;
          return `<span class="drop" style="--x:${x}%;--dur:${dur}ms;--delay:${delay}ms;--h:${height}px;--w:${width}px;--o:${opacity}"></span>`;
        }).join('') + (effect === 'thunder' ? '<span class="bolt"></span>' : '');
        return;
      }

      if (effect === 'snow') {
        els.weatherEffect.innerHTML = Array.from({ length: 28 }, (_, index) => {
          const x = (index * 29) % 102;
          const size = 4 + (index % 5) * 1.5;
          const dur = 6200 + (index % 10) * 540;
          const delay = -((index * 307) % 7400);
          const drift = ((index % 2 ? 1 : -1) * (18 + (index % 5) * 8));
          const opacity = 0.38 + (index % 6) * 0.055;
          return `<span class="flake" style="--x:${x}%;--size:${size}px;--dur:${dur}ms;--delay:${delay}ms;--drift:${drift}px;--o:${opacity}"></span>`;
        }).join('');
        return;
      }

      if (effect === 'fog') {
        els.weatherEffect.innerHTML = Array.from({ length: 5 }, (_, index) => {
          const y = 14 + index * 12;
          const dur = 13000 + index * 950;
          const delay = -index * 1100;
          const opacity = 0.08 + index * 0.018;
          return `<span class="mist" style="--y:${y}%;--dur:${dur}ms;--delay:${delay}ms;--o:${opacity}"></span>`;
        }).join('');
        return;
      }

      if (effect === 'clouds' || effect === 'partly') {
        const cloudHtml = Array.from({ length: effect === 'partly' ? 4 : 7 }, (_, index) => {
          const x = -8 + ((index * 28) % 112);
          const y = 16 + ((index * 17) % 58);
          const size = 120 + (index % 4) * 58;
          const dur = 14000 + index * 1700;
          const delay = -index * 1400;
          const opacity = effect === 'partly' ? 0.12 + index * 0.025 : 0.16 + index * 0.025;
          return `<span class="cloud-puff" style="--x:${x}%;--y:${y}%;--size:${size}px;--dur:${dur}ms;--delay:${delay}ms;--o:${opacity}"></span>`;
        }).join('');
        els.weatherEffect.innerHTML = (effect === 'partly' ? '<span class="sun-glow"></span>' : '') + cloudHtml;
        return;
      }

      els.weatherEffect.innerHTML = '<span class="sun-glow"></span>';
    }

    function weatherEffectRank(code) {
      const effect = weatherCodeToEffect(code);
      return { thunder: 6, rain: 5, snow: 5, drizzle: 4, fog: 3, clouds: 2, partly: 1, clear: 0 }[effect] ?? 0;
    }

    function chooseWeatherEffectCode(weather, currentCode) {
      const now = new Date();
      const hourlyTimes = weather.hourly?.time || [];
      const hourlyCodes = weather.hourly?.weather_code || [];
      let best = currentCode;
      let bestRank = weatherEffectRank(currentCode);

      hourlyTimes.forEach((time, index) => {
        const date = new Date(time);
        if (Number.isNaN(date)) return;
        const hoursAway = (date - now) / 36e5;
        if (hoursAway < -0.5 || hoursAway > 6) return;
        const code = hourlyCodes[index];
        const rank = weatherEffectRank(code);
        if (rank > bestRank) {
          best = code;
          bestRank = rank;
        }
      });

      return best;
    }

    function renderHourlyWeather(weather, focusDate = new Date()) {
      if (!els.hourlyWeather) return;
      const hourly = weather.hourly;
      if (!hourly?.time?.length) {
        els.hourlyWeather.innerHTML = '';
        return;
      }

      const now = new Date();
      const chosenDate = focusDate instanceof Date && !Number.isNaN(focusDate.getTime()) ? focusDate : now;
      const focusKey = dateKey(chosenDate);
      const isToday = focusKey === dateKey(now);
      const items = hourly.time.map((time, index) => {
        const date = new Date(time);
        return {
          date,
          code: hourly.weather_code?.[index] ?? 2,
          temp: Math.round(hourly.temperature_2m?.[index] ?? weather.current?.temperature_2m ?? 0),
          rain: hourly.precipitation_probability?.[index]
        };
      }).filter(item => !Number.isNaN(item.date) && dateKey(item.date) === focusKey && (!isToday || item.date >= new Date(now.getTime() - 30 * 60 * 1000)));

      const compact = els.displayView && !els.displayView.classList.contains('no-daily');
      const rows = items.slice(0, compact ? 5 : 8);
      if (!rows.length) {
        const label = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(chosenDate);
        els.hourlyWeather.innerHTML = `<div class="hourly-title">No hourly weather available for ${htmlEscape(label)}</div>`;
        return;
      }

      const label = isToday
        ? 'Weather through today'
        : `Weather for ${new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(chosenDate)}`;

      els.hourlyWeather.innerHTML = `
        <div class="hourly-title">${htmlEscape(label)}</div>
        <div class="hourly-table">
          <div class="hourly-row hourly-head"><div>Time</div><div>Weather</div><div>Temp</div><div class="hourly-rain">Rain</div></div>
          ${rows.map(item => `
            <div class="hourly-row">
              <div>${new Intl.DateTimeFormat(undefined, { hour: '2-digit', hour12: false }).format(item.date)}</div>
              <div class="hourly-icon" title="${htmlEscape(weatherCodeToText(item.code))}">${weatherCodeToIcon(item.code)}</div>
              <div class="hourly-temp">${item.temp}°</div>
              <div class="hourly-rain">${Number.isFinite(item.rain) ? `${Math.round(item.rain)}%` : '—'}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    function renderWeather() {
      const fallback = {
        current: { temperature_2m: 20, weather_code: 2 },
        hourly: {
          time: Array.from({ length: 12 }, (_, i) => new Date(Date.now() + i * 3600000).toISOString()),
          weather_code: [2, 2, 61, 61, 3, 3, 2, 2, 1, 1, 2, 3],
          temperature_2m: [20, 20, 19, 18, 18, 17, 17, 16, 16, 15, 15, 14],
          precipitation_probability: [10, 12, 68, 74, 32, 22, 12, 8, 5, 4, 8, 15]
        },
        daily: {
          time: [0,1,2,3,4].map(i => new Date(Date.now() + i * 86400000).toISOString().slice(0,10)),
          weather_code: [2, 3, 61, 2, 1],
          temperature_2m_max: [22, 20, 19, 21, 23],
          temperature_2m_min: [12, 11, 10, 12, 13]
        }
      };

      const weather = state.weather || fallback;
      const code = weather.current?.weather_code ?? 2;
      const temp = Math.round(weather.current?.temperature_2m ?? 20);
      els.weatherIcon.textContent = weatherCodeToIcon(code);
      els.weatherTemp.textContent = `${temp}°`;
      els.weatherDesc.textContent = `${weatherCodeToText(code)} · ${WEATHER_CONFIG.name}`;
      renderWeatherEffect(chooseWeatherEffectCode(weather, code));

      const rows = (weather.daily?.time || []).slice(1, 5).map((day, index) => {
        const dayDate = new Date(`${day}T12:00:00`);
        const dailyCode = weather.daily.weather_code[index + 1] ?? 2;
        const high = Math.round(weather.daily.temperature_2m_max[index + 1] ?? 20);
        const low = Math.round(weather.daily.temperature_2m_min[index + 1] ?? 10);
        return `
          <div class="forecast-day">
            <span>${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(dayDate)}</span>
            <span class="small-icon">${weatherCodeToIcon(dailyCode)}</span>
            <strong>${high}°</strong>
            <span>${low}°</span>
          </div>
        `;
      }).join('');

      els.forecastRow.innerHTML = rows;
      renderHourlyWeather(weather, state.weatherFocusDate || new Date());
    }


    function renderWeeklyWeatherModal() {
      if (!els.weatherWeeklyList) return;
      const weather = state.weather;
      const daily = weather?.daily;
      if (!daily?.time?.length) {
        els.weatherWeeklyList.innerHTML = '<div class="empty-upcoming">No weekly forecast loaded yet.</div>';
        return;
      }

      const today = new Date();
      els.weatherWeeklyList.innerHTML = daily.time.slice(0, 7).map((day, index) => {
        const dayDate = new Date(`${day}T12:00:00`);
        const high = Math.round(daily.temperature_2m_max?.[index] ?? weather.current?.temperature_2m ?? 0);
        const low = Math.round(daily.temperature_2m_min?.[index] ?? high);
        const code = daily.weather_code?.[index] ?? weather.current?.weather_code ?? 2;
        const isToday = sameDay(dayDate, today);
        return `
          <article class="weather-week-day${isToday ? ' today' : ''}">
            <div class="weather-week-icon">${weatherCodeToIcon(code)}</div>
            <div class="weather-week-name">${htmlEscape(new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(dayDate))}</div>
            <div class="weather-week-temp">${high}°</div>
            <div class="weather-week-desc">${htmlEscape(weatherCodeToText(code))}</div>
            <div class="weather-week-low">Low ${low}°</div>
          </article>
        `;
      }).join('');
    }

    function openWeatherOverlay() {
      renderWeeklyWeatherModal();
      els.weatherOverlay?.classList.remove('hidden');
    }

    function closeWeatherOverlay() {
      els.weatherOverlay?.classList.add('hidden');
    }

    function setDangerStatus(message, isError = false) {
      if (!els.dangerStatus) return;
      els.dangerStatus.textContent = message;
      els.dangerStatus.style.color = isError ? '#8d4138' : 'var(--muted)';
    }

    function openDangerMenu() {
      if (els.dangerPinInput) els.dangerPinInput.value = getPin();
      if (els.dangerConfirmInput) els.dangerConfirmInput.value = '';
      setDangerStatus('Type DELETE to unlock the delete button.');
      els.dangerOverlay?.classList.remove('hidden');
      setTimeout(() => els.dangerConfirmInput?.focus({ preventScroll: true }), 80);
    }

    function closeDangerMenu() {
      els.dangerOverlay?.classList.add('hidden');
    }

    async function deleteAllEvents() {
      const pin = (els.dangerPinInput?.value || getPin()).trim();
      const confirmation = (els.dangerConfirmInput?.value || '').trim();
      if (!pin) {
        setDangerStatus('Enter the admin PIN first.', true);
        return;
      }
      if (confirmation !== 'DELETE') {
        setDangerStatus('Type DELETE exactly to confirm.', true);
        return;
      }
      if (!confirm('Delete ALL tasks/events from Home Organizer?')) return;
      if (!confirm('Last check: this clears the shared calendar list for everyone. Continue?')) return;

      localStorage.setItem('homeOrganizerAdminPin', pin);
      setDangerStatus('Deleting all tasks/events…');
      if (els.deleteAllEventsBtn) els.deleteAllEventsBtn.disabled = true;
      try {
        const op = {
          opId: `delete-all-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          method: 'DELETE_ALL',
          createdAt: new Date().toISOString()
        };
        queueWrite(op);
        state.serverEvents = [];
        refreshEventsFromServerEvents();
        state.selectedDayKey = null;
        state.selectedInstanceId = null;
        state.heroEventFlipped = false;
        state.selectedEventFlipped = false;
        renderAdminEvents();
        renderDisplay();
        await processPendingWrites({ silent: false, throwNonRetryable: true, targetOpId: op.opId });
        setDangerStatus(getPendingWrites().some(item => item.opId === op.opId)
          ? 'Deleted on this device. Server is busy, so deletion will retry automatically.'
          : 'All tasks/events deleted.');
        setTimeout(closeDangerMenu, 850);
      } catch (error) {
        setDangerStatus(error.message || 'Could not delete all events.', true);
      } finally {
        if (els.deleteAllEventsBtn) els.deleteAllEventsBtn.disabled = false;
      }
    }

    function getPin() {
      return localStorage.getItem('homeOrganizerAdminPin') || '';
    }

    function ensureDisplayActionPin() {
      if (adminMode) return true;
      const existingPin = getPin().trim();
      if (existingPin) return true;
      const pin = prompt('Enter the admin PIN to change this task:');
      if (!pin || !pin.trim()) return false;
      localStorage.setItem('homeOrganizerAdminPin', pin.trim());
      if (els.pinInput) els.pinInput.value = pin.trim();
      if (els.configPinInput) els.configPinInput.value = pin.trim();
      return true;
    }

    function setStatus(message, isError = false) {
      if (!els.statusLine) return;
      els.statusLine.textContent = message;
      els.statusLine.style.color = isError ? '#8d4138' : 'var(--muted)';
    }

    function hasSavedAdminPin() {
      return Boolean(getPin().trim());
    }

    function renderAdminShell() {
      if (!adminMode) return;
      const signedIn = hasSavedAdminPin();
      if (els.pinCard) els.pinCard.classList.toggle('hidden', signedIn);
      if (els.adminCalendarCard) els.adminCalendarCard.classList.toggle('hidden', !signedIn);
      if (!signedIn) closeEventEditor({ reset: false });
      else if (els.pinInput) els.pinInput.value = getPin();
    }

    function showEventEditor() {
      if (!hasSavedAdminPin()) {
        renderAdminShell();
        return;
      }
      if (els.eventEditorCard) els.eventEditorCard.classList.remove('hidden');
      if (els.adminView) els.adminView.classList.add('editor-open');
      setTimeout(() => {
        els.eventEditorCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        els.titleInput?.focus({ preventScroll: true });
      }, 80);
    }

    function closeEventEditor(options = {}) {
      if (els.eventEditorCard) els.eventEditorCard.classList.add('hidden');
      if (els.adminView) els.adminView.classList.remove('editor-open');
      state.editingId = null;
      if (params.get('edit')) {
        params.delete('edit');
        const query = params.toString();
        history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash || ''}`);
      }
      if (options.reset !== false && els.eventForm) resetForm();
      setTimeout(() => els.adminCalendarCard?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 40);
    }

    function openNewEventEditor() {
      resetForm();
      if (els.eventEditorTitle) els.eventEditorTitle.textContent = 'Create task/event';
      showEventEditor();
    }


    function setConfigStatus(message, isError = false) {
      if (!els.configStatus) return;
      els.configStatus.textContent = message;
      els.configStatus.style.color = isError ? '#8d4138' : 'var(--muted)';
    }

    function updateLocalQueueStatus() {
      const count = getPendingWrites().length;
      if (els.localQueueStatus) {
        els.localQueueStatus.textContent = count
          ? `Pending saves waiting to sync: ${count}`
          : 'Pending saves: 0. Everything on this device has been sent.';
      }
    }

    function fillConfigForm() {
      if (!els.configOverlay) return;
      if (els.configPinInput) els.configPinInput.value = getPin();
      updateLocalQueueStatus();
    }

    function openConfigMenu() {
      if (!els.configOverlay) return;
      fillConfigForm();
      els.configOverlay.classList.remove('hidden');
      document.body.classList.add('config-open');
      setConfigStatus('Local dashboard settings loaded.');
      setTimeout(() => els.configPinInput?.focus?.(), 50);
    }

    function closeConfigMenu() {
      if (!els.configOverlay) return;
      els.configOverlay.classList.add('hidden');
      document.body.classList.remove('config-open');
    }

    function setReminderMenuStatus(message, isError = false) {
      if (!els.reminderMenuStatus) return;
      els.reminderMenuStatus.textContent = message || '';
      els.reminderMenuStatus.style.color = isError ? '#8d4138' : 'var(--muted)';
    }

    function setReminderMenuExpanded(expanded, { persist = true } = {}) {
      state.reminderMenuExpanded = Boolean(expanded);
      if (persist) {
        localStorage.setItem('homeOrganizerReminderMenuExpanded', state.reminderMenuExpanded ? '1' : '0');
      }
      els.phoneReminderMenu?.classList.toggle('is-collapsed', !state.reminderMenuExpanded);
      els.reminderMenuToggle?.setAttribute('aria-expanded', state.reminderMenuExpanded ? 'true' : 'false');
      if (els.reminderMenuToggle) {
        els.reminderMenuToggle.title = state.reminderMenuExpanded ? 'Collapse reminder menu' : 'Expand reminder menu';
      }
    }

    function toggleReminderMenu() {
      setReminderMenuExpanded(!state.reminderMenuExpanded);
    }

    function defaultReminderEmails() {
      return HARD_CODED_REMINDER_CONTACTS.map(contact => normalizeReminderEmail(contact.email));
    }

    function normalizeReminderRecipientList(value, fallback = defaultReminderEmails()) {
      const source = Array.isArray(value) ? value : fallback;
      return [...new Set(source.map(normalizeReminderEmail).filter(email => isValidReminderEmail(email) && defaultReminderEmails().includes(email)))];
    }

    function setDigestRecipientInputs(selector, recipients) {
      const selected = new Set(normalizeReminderRecipientList(recipients));
      document.querySelectorAll(selector).forEach(input => {
        input.checked = selected.has(normalizeReminderEmail(input.value));
      });
    }

    function getDigestRecipientInputs(selector) {
      return [...document.querySelectorAll(selector)]
        .filter(input => input.checked)
        .map(input => normalizeReminderEmail(input.value))
        .filter(email => isValidReminderEmail(email) && defaultReminderEmails().includes(email));
    }

    function renderReminderSettings() {
      const settings = state.reminderSettings || {};
      const legacyRecipients = normalizeReminderRecipientList(settings.recipients);
      if (els.weeklyUpdatesInput) els.weeklyUpdatesInput.checked = Boolean(settings.weeklyUpdates);
      if (els.dailyNewTasksInput) els.dailyNewTasksInput.checked = Boolean(settings.endOfDayNewTasks);
      setDigestRecipientInputs('[data-weekly-recipient]', settings.weeklyRecipients || legacyRecipients);
      setDigestRecipientInputs('[data-daily-recipient]', settings.endOfDayRecipients || legacyRecipients);
    }

    async function loadReminderSettings() {
      try {
        const response = await fetch(`/api/reminder-settings?v=${Date.now()}`, { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not load reminder settings.');
        state.reminderSettings = data.settings || state.reminderSettings;
        renderReminderSettings();
        setReminderMenuStatus('Reminder settings loaded.');
      } catch (error) {
        renderReminderSettings();
        setReminderMenuStatus(error.message || 'Could not load reminder settings.', true);
      }
    }

    async function saveReminderSettings() {
      const pin = (els.pinInput?.value || getPin() || '').trim();
      if (!pin) {
        setReminderMenuStatus('Enter and save the admin PIN first.', true);
        return;
      }
      const weeklyRecipients = getDigestRecipientInputs('[data-weekly-recipient]');
      const endOfDayRecipients = getDigestRecipientInputs('[data-daily-recipient]');
      const settings = {
        weeklyUpdates: Boolean(els.weeklyUpdatesInput?.checked),
        endOfDayNewTasks: Boolean(els.dailyNewTasksInput?.checked),
        weeklyRecipients,
        endOfDayRecipients,
        recipients: [...new Set([...weeklyRecipients, ...endOfDayRecipients])]
      };
      setReminderMenuStatus('Saving reminder settings…');
      try {
        const response = await fetch('/api/reminder-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-admin-pin': pin },
          body: JSON.stringify({ settings })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not save reminder settings.');
        state.reminderSettings = data.settings || settings;
        renderReminderSettings();
        setReminderMenuStatus('Reminder settings saved.');
      } catch (error) {
        setReminderMenuStatus(error.message || 'Could not save reminder settings.', true);
      }
    }

    async function loadConfig() {
      fillConfigForm();
      return state.config;
    }

    async function saveConfig() {
      const pin = (els.configPinInput?.value || '').trim() || getPin();
      if (!pin) {
        setConfigStatus('Enter the admin PIN first.', true);
        return;
      }
      localStorage.setItem('homeOrganizerAdminPin', pin);
      if (els.pinInput) els.pinInput.value = pin;
      setConfigStatus('PIN saved on this device.');
      updateLocalQueueStatus();
    }

    function bindConfigMenu() {
      if (!els.configOverlay) return;
      els.configCloseBtn?.addEventListener('click', closeConfigMenu);
      els.configOverlay.addEventListener('click', event => {
        if (event.target === els.configOverlay) closeConfigMenu();
      });
      window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !els.configOverlay.classList.contains('hidden')) closeConfigMenu();
      });
      els.saveConfigBtn?.addEventListener('click', saveConfig);
      els.reloadConfigBtn?.addEventListener('click', async () => {
        setConfigStatus('Retrying pending saves…');
        await processPendingWrites({ silent: false });
        updateLocalQueueStatus();
        setConfigStatus(getPendingWrites().length ? 'Some saves are still pending. I will keep retrying.' : 'No pending saves.');
      });

      const startHold = event => {
        if (event.target.closest?.('.month-modal, .config-modal, .weather-modal, .danger-modal, .task-action-sheet, input, textarea, button, select, a')) return;
        if (els.monthOverlay && !els.monthOverlay.classList.contains('hidden')) return;
        state.longPressOpened = false;
        clearTimeout(state.longPressTimer);
        state.longPressTimer = setTimeout(() => {
          state.longPressOpened = true;
          openMonthView(true);
        }, 850);
      };
      const cancelHold = () => {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
      };

      window.addEventListener('pointerdown', startHold, { passive: true });
      window.addEventListener('pointerup', cancelHold, { passive: true });
      window.addEventListener('pointercancel', cancelHold, { passive: true });
      window.addEventListener('pointermove', event => {
        if (Math.abs(event.movementX || 0) + Math.abs(event.movementY || 0) > 12) cancelHold();
      }, { passive: true });
      window.addEventListener('contextmenu', event => {
        if (state.longPressOpened) event.preventDefault();
      });
    }

    function toLocalInputValue(dateLike) {
      if (!dateLike) return '';
      const date = new Date(dateLike);
      if (Number.isNaN(date)) return '';
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function fromLocalInputValue(value) {
      return value ? new Date(value).toISOString() : '';
    }

    function resetForm() {
      state.editingId = null;
      state.pendingImageFocus = null;
      state.imageFocusToken += 1;
      els.eventForm.reset();
      els.eventId.value = '';
      els.imageUrlInput.value = '';
      clearManualImagePreview();
      setManualImageControls({ imageFocusX: 50, imageFocusY: 38, imageZoom: 1.01 });
      if (els.repeatInput) els.repeatInput.value = 'none';
      if (els.emailReminderInput) els.emailReminderInput.checked = false;
      renderEmailContacts([]);
      setEmailReminderOptionsVisible();
      els.saveEventBtn.textContent = 'Save event';
      els.imageStatus.textContent = 'No image selected. A calm placeholder will be used.';
      setStatus('');
      const start = new Date(Date.now() + 60 * 60 * 1000);
      start.setMinutes(0, 0, 0);
      els.startInput.value = toLocalInputValue(start);
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '';
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function loadImage(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
          URL.revokeObjectURL(url);
          resolve(image);
        };
        image.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Could not read this image. Try a JPEG, PNG or WEBP instead.'));
        };
        image.src = url;
      });
    }

    function canvasToBlob(canvas, type, quality) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error('Image compression failed.'));
        }, type, quality);
      });
    }

    async function compressImageForUpload(file) {
      if (file.type === 'image/gif') {
        if (file.size <= MAX_UPLOAD_BYTES) return file;
        throw new Error('GIFs must be under 4 MB. Use a smaller GIF or a still image.');
      }

      if (file.size <= IMAGE_UPLOAD_PASSTHROUGH_BYTES && ['image/jpeg', 'image/webp'].includes(file.type)) {
        return file;
      }

      const action = file.size > MAX_UPLOAD_BYTES ? 'Compressing' : 'Optimizing';
      els.imageStatus.textContent = `${action} ${formatBytes(file.size)} image before upload…`;

      const image = await loadImage(file);
      const naturalWidth = image.naturalWidth || image.width;
      const naturalHeight = image.naturalHeight || image.height;
      if (!naturalWidth || !naturalHeight) throw new Error('Could not read image size.');

      const baseName = (file.name || 'event-image').replace(/\.[^.]+$/, '');
      let maxDimension = IMAGE_MAX_DIMENSION;
      let bestBlob = null;

      for (let sizeAttempt = 0; sizeAttempt < 8; sizeAttempt++) {
        const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
        const width = Math.max(360, Math.round(naturalWidth * scale));
        const height = Math.max(260, Math.round(naturalHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#f5f1eb';
        ctx.fillRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, width, height);

        for (const quality of JPEG_QUALITY_STEPS) {
          const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
          if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
          if (blob.size <= COMPRESSED_UPLOAD_TARGET_BYTES) {
            return new File([blob], `${baseName}-optimized.jpg`, {
              type: 'image/jpeg',
              lastModified: Date.now()
            });
          }
        }

        maxDimension = Math.round(maxDimension * 0.78);
      }

      if (bestBlob && bestBlob.size <= MAX_UPLOAD_BYTES) {
        return new File([bestBlob], `${baseName}-optimized.jpg`, {
          type: 'image/jpeg',
          lastModified: Date.now()
        });
      }

      throw new Error('Could not compress this image under 4 MB. Try a different image.');
    }

    async function uploadImageIfNeeded() {
      const file = els.imageInput.files?.[0];
      if (!file) return els.imageUrlInput.value;

      syncPendingFocusFromControls();

      const uploadFile = await compressImageForUpload(file);
      if (uploadFile.size > MAX_UPLOAD_BYTES) {
        throw new Error('Image is still over 4 MB after compression. Try a different image.');
      }

      const compressedNote = uploadFile !== file ? `Optimized to ${formatBytes(uploadFile.size)}. ` : '';
      els.imageStatus.textContent = `${compressedNote}Uploading image…`;
      const form = new FormData();
      form.append('image', uploadFile);

      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-admin-pin': getPin() },
        body: form
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed.');
      els.imageStatus.textContent = uploadFile !== file
        ? `Image optimized to ${formatBytes(uploadFile.size)} and uploaded.`
        : 'Image uploaded.';
      return data.url;
    }

    async function saveEvent(event) {
      const isUpdate = Boolean(event.id);
      const eventToSave = { ...event, id: event.id || makeLocalEventId() };
      const op = {
        opId: `write-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method: isUpdate ? 'PUT' : 'POST',
        event: eventToSave,
        createdAt: new Date().toISOString()
      };

      // Optimistic local save: show the task immediately on this device,
      // then sync to the server in the background.
      rememberLocalEvent(eventToSave, op.opId, op.method);
      queueWrite(op);
      refreshEventsFromServerEvents();
      renderDisplay();
      renderAdminEvents();
      signalOtherOpenViewsToRefresh();

      state.lastReminderSync = null;
      processPendingWrites({ silent: true }).catch(error => {
        console.warn('Background sync failed:', error);
        updateLocalQueueStatus();
        setStatus('Saved on this device. Server sync will retry automatically.', true);
      });

      return {
        event: eventToSave,
        events: state.events,
        queued: true,
        reminderSync: null,
        localSaved: true
      };
    }

    async function deleteEvent(id) {
      const op = {
        opId: `delete-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method: 'DELETE',
        id,
        createdAt: new Date().toISOString()
      };

      forgetLocalEvent(id);
      queueWrite(op);
      refreshEventsFromServerEvents();
      renderDisplay();
      renderAdminEvents();
      await processPendingWrites({ silent: true, throwNonRetryable: true, targetOpId: op.opId });
    }

    async function deleteOccurrence(instanceId) {
      const [sourceId, occurrenceKey] = String(instanceId || '').split('::');
      const source = getSourceEvent(sourceId);
      if (!source) throw new Error('Task not found.');

      if ((source.repeat || 'none') === 'none') {
        await deleteEvent(sourceId);
        return;
      }

      const excludedDates = Array.isArray(source.excludedDates) ? [...source.excludedDates] : [];
      if (!excludedDates.includes(occurrenceKey)) excludedDates.push(occurrenceKey);
      await saveEvent({ ...source, excludedDates });
    }

    async function deleteTaskWithChoice(instanceId) {
      const [sourceId] = String(instanceId || '').split('::');
      const source = getSourceEvent(sourceId);
      if (!source) throw new Error('Task not found.');

      if ((source.repeat || 'none') === 'none') {
        if (!confirm(`Delete ${source.title || 'this event'}?`)) return false;
        await deleteEvent(sourceId);
        return true;
      }

      const deleteOnlyThis = confirm(`This is a repeating task.

OK = delete only this occurrence.
Cancel = choose whether to delete the whole series.`);
      if (deleteOnlyThis) {
        await deleteOccurrence(instanceId);
        return true;
      }

      const deleteAll = confirm(`Delete ALL repeats connected to “${source.title || 'this task'}”?`);
      if (!deleteAll) return false;
      await deleteEvent(sourceId);
      return true;
    }

    function adminMonthLabel(date) {
      const now = new Date();
      if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'This month';

      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      if (date.getFullYear() === nextMonth.getFullYear() && date.getMonth() === nextMonth.getMonth()) return 'Next month';

      return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
    }

    function renderAdminEventCard(event) {
      const sourceId = event._sourceId || event.id;
      const completeText = event._completed ? '<span class="complete-badge">Done</span>' : '';
      const dateText = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(event.date);
      const locationText = event.location ? `<div class="admin-event-location">${htmlEscape(event.location)}</div>` : '';
      const emailText = reminderSummary(event);
      const reminderText = emailText ? `<div class="admin-event-location">✉ ${htmlEscape(emailText)}</div>` : '';
      return `
        <button class="admin-event-simple${event._completed ? ' admin-event-complete' : ''}" type="button" data-admin-card="${htmlEscape(event._instanceId)}" aria-label="Open actions for ${htmlEscape(event.title)}">
          <div class="admin-event-main">
            <img alt="" src="${htmlEscape(event.imageUrl || placeholderFor(sourceId, event.title))}" style="${imageFocusStyle(event)}">
            <div>
              <div class="admin-event-title">${htmlEscape(event.title)} ${event.featured ? '· Featured' : ''}${completeText}</div>
              <div class="admin-event-meta">${htmlEscape(dateText)}</div>
              ${locationText}
              ${reminderText}
            </div>
          </div>
        </button>
      `;
    }

    function closeAdminTaskActions() {
      state.activeAdminInstanceId = null;
      if (els.taskActionOverlay) {
        els.taskActionOverlay.classList.add('hidden');
        els.taskActionOverlay.setAttribute('aria-hidden', 'true');
      }
      if (els.taskActionContent) els.taskActionContent.innerHTML = '';
    }

    function openAdminTaskActions(instanceId) {
      const event = occurrenceByInstanceId(instanceId, { includeCompleted: true });
      if (!event || !els.taskActionOverlay || !els.taskActionContent) return;
      state.activeAdminInstanceId = instanceId;
      const sourceId = event._sourceId || event.id;
      const dateText = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(event.date);
      const noteText = event.note || 'No extra notes were added to this task.';
      const emailText = reminderSummary(event);
      const reminderText = emailText ? `<div class="task-action-meta">✉ ${htmlEscape(emailText)}</div>` : '';
      const recurringText = event._isRecurring ? '<div class="task-action-meta">Repeating task. Delete will ask if you want this one occurrence or the whole series.</div>' : '';
      els.taskActionContent.innerHTML = `
        <div class="task-action-head">
          <img alt="" src="${htmlEscape(event.imageUrl || placeholderFor(sourceId, event.title))}" style="${imageFocusStyle(event)}">
          <div>
            <div class="task-action-title">${htmlEscape(event.title)}</div>
            <div class="task-action-meta">${htmlEscape(dateText)}${event.location ? ` · ${htmlEscape(event.location)}` : ''}</div>
            ${reminderText}
            ${recurringText}
          </div>
          <button class="btn secondary" type="button" data-action-close>Close</button>
        </div>
        <div class="task-action-note">${htmlEscape(noteText)}</div>
        <div class="task-action-controls">
          <label>
            Change date/time
            <input type="datetime-local" value="${htmlEscape(toLocalInputValue(event.start))}" data-action-date aria-label="New date for ${htmlEscape(event.title)}">
          </label>
          <div class="task-action-buttons">
            <button class="btn secondary" type="button" data-action-change-date>Change date</button>
            <button class="btn secondary" type="button" data-action-edit="${htmlEscape(sourceId)}">Edit all details</button>
            <button class="btn secondary" type="button" data-action-complete>${event._completed ? 'Undo complete' : 'Mark as complete'}</button>
            <button class="btn danger" type="button" data-action-delete>Delete</button>
          </div>
        </div>
      `;
      els.taskActionOverlay.classList.remove('hidden');
      els.taskActionOverlay.setAttribute('aria-hidden', 'false');
    }


    function isFrequentRepeatingEvent(event) {
      const repeat = event?.repeat || 'none';
      return repeat === 'weekly' || repeat === 'biweekly';
    }

    function endOfNextMonth(fromDate = new Date()) {
      return new Date(fromDate.getFullYear(), fromDate.getMonth() + 2, 0, 23, 59, 59, 999);
    }

    function updateRepeatVisibilityControl(hiddenCount = 0) {
      if (!els.showFrequentRepeatingInput) return;
      els.showFrequentRepeatingInput.checked = Boolean(state.showFrequentRepeatingTasks);
      if (els.repeatVisibilityText) {
        els.repeatVisibilityText.textContent = state.showFrequentRepeatingTasks
          ? 'Limit repeating tasks'
          : 'Show more repeating tasks';
      }
      if (els.repeatVisibilityHelp) {
        els.repeatVisibilityHelp.textContent = state.showFrequentRepeatingTasks
          ? 'Showing frequent repeats several months ahead.'
          : hiddenCount
            ? `Showing this month + next month. ${hiddenCount} later repeat${hiddenCount === 1 ? '' : 's'} hidden.`
            : 'Showing frequent repeats for this month + next month.';
      }
    }

    function renderAdminEvents() {
      if (!adminMode) return;
      renderAdminShell();
      if (!hasSavedAdminPin()) {
        if (els.adminListSubtitle) els.adminListSubtitle.textContent = 'Enter your admin PIN first.';
        if (els.adminEvents) els.adminEvents.innerHTML = '';
        return;
      }

      const nowStart = todayStart();
      const rangeEnd = new Date(nowStart.getTime() + 365 * 86400000);
      const repeatVisibleThrough = endOfNextMonth(nowStart);
      const allFutureEvents = expandEventsInRange(nowStart, rangeEnd, { includeCompleted: true });

      // Default/off: show frequent repeats, but only through the end of next month.
      // Toggle/on: show frequent repeats for the whole loaded future range.
      const hiddenFrequentRepeats = allFutureEvents.filter(event =>
        isFrequentRepeatingEvent(event) && event.date > repeatVisibleThrough
      ).length;
      const futureEvents = allFutureEvents
        .filter(event => {
          if (!isFrequentRepeatingEvent(event)) return true;
          return state.showFrequentRepeatingTasks || event.date <= repeatVisibleThrough;
        })
        .slice(0, state.showFrequentRepeatingTasks ? 180 : 100);

      updateRepeatVisibilityControl(state.showFrequentRepeatingTasks ? 0 : hiddenFrequentRepeats);

      if (els.adminListSubtitle) {
        const repeatNote = state.showFrequentRepeatingTasks
          ? ' Frequent repeats are shown several months ahead.'
          : hiddenFrequentRepeats
            ? ` Frequent repeats are limited to this month and next month. ${hiddenFrequentRepeats} later repeat${hiddenFrequentRepeats === 1 ? '' : 's'} hidden.`
            : ' Frequent repeats are limited to this month and next month.';
        els.adminListSubtitle.textContent = futureEvents.length
          ? `${futureEvents.length} upcoming saved task${futureEvents.length === 1 ? '' : 's'} across your shared calendar.${repeatNote}`
          : `No upcoming tasks shown. Create your first task/event.${repeatNote}`;
      }

      if (!futureEvents.length) {
        els.adminEvents.innerHTML = '<div class="empty-upcoming">No events yet. Tap “Create a new task/event” to add one.</div>';
        return;
      }

      const groups = [];
      const seen = new Map();
      futureEvents.forEach(event => {
        const key = `${event.date.getFullYear()}-${pad(event.date.getMonth() + 1)}`;
        if (!seen.has(key)) {
          const group = { key, label: adminMonthLabel(event.date), events: [] };
          seen.set(key, group);
          groups.push(group);
        }
        seen.get(key).events.push(event);
      });

      els.adminEvents.innerHTML = groups.map(group => `
        <section class="month-group" aria-label="${htmlEscape(group.label)}">
          <div class="month-heading">
            <span>${htmlEscape(group.label)}</span>
            <span>${group.events.length} task${group.events.length === 1 ? '' : 's'}</span>
          </div>
          <div class="admin-events-month">
            ${group.events.map(renderAdminEventCard).join('')}
          </div>
        </section>
      `).join('');
    }

    function editEvent(id) {
      const event = getSourceEvent(id);
      if (!event) return;
      state.editingId = id;
      els.eventId.value = event.id;
      els.titleInput.value = event.title || '';
      els.startInput.value = toLocalInputValue(event.start);
      els.endInput.value = toLocalInputValue(event.end);
      els.locationInput.value = event.location || '';
      if (els.repeatInput) els.repeatInput.value = event.repeat || 'none';
      els.noteInput.value = event.note || '';
      els.imageUrlInput.value = event.imageUrl || '';
      els.featuredInput.checked = Boolean(event.featured);
      const reminder = event.emailReminder || {};
      if (els.emailReminderInput) els.emailReminderInput.checked = Boolean(reminder.enabled);
      renderEmailContacts(Array.isArray(reminder.recipients) ? reminder.recipients : []);
      setEmailReminderOptionsVisible();
      els.imageInput.value = '';
      state.pendingImageFocus = focusFromEvent(event) || { imageFocusX: 50, imageFocusY: 38, imageZoom: 1.01, imageFocusSource: 'manual' };
      state.imageFocusToken += 1;
      setManualImageControls(state.pendingImageFocus);
      setManualImagePreviewSource(event.imageUrl || '');
      els.imageStatus.textContent = event.imageUrl ? 'Current image will be kept unless you upload a new one. Adjust pan/zoom below if needed.' : 'No image selected. A calm placeholder will be used.';
      els.saveEventBtn.textContent = 'Update event';
      if (els.eventEditorTitle) els.eventEditorTitle.textContent = 'Edit task/event';
      showEventEditor();
    }

    async function toggleComplete(instanceId) {
      const [sourceId, occurrenceKey] = String(instanceId || '').split('::');
      const source = getSourceEvent(sourceId);
      if (!source) throw new Error('Task not found.');
      const repeat = source.repeat || 'none';
      const payload = { ...source };
      let willBeCompleted = false;

      if (repeat === 'none') {
        willBeCompleted = !Boolean(source.completed);
        payload.completed = willBeCompleted;
      } else {
        const dates = Array.isArray(source.completedDates) ? [...source.completedDates] : [];
        const index = dates.indexOf(occurrenceKey);
        if (index >= 0) {
          dates.splice(index, 1);
          willBeCompleted = false;
        } else {
          dates.push(occurrenceKey);
          willBeCompleted = true;
        }
        payload.completedDates = dates;
      }

      // Save the completion change locally before the server request starts, so the task
      // stays hidden/visible exactly as chosen even while Blob/Vercel is still catching up.
      saveCompletionOverride(payload);
      refreshEventsFromServerEvents();
      renderAdminEvents();
      renderDisplay();

      const result = await saveEvent(payload);
      if (willBeCompleted) {
        const completedEvent = occurrenceByInstanceId(instanceId);
        if (completedEvent && sameDay(completedEvent.date, new Date())) {
          state.heroEventFlipped = false;
        }
        if (state.selectedInstanceId === instanceId) state.selectedInstanceId = null;
        if (state.activeAdminInstanceId === instanceId) state.activeAdminInstanceId = null;
      }
      renderAdminEvents();
      renderDisplay();
      return result;
    }

    async function changeEventDate(instanceId, newLocalValue) {
      const [sourceId] = String(instanceId || '').split('::');
      const source = getSourceEvent(sourceId);
      if (!source) throw new Error('Task not found.');
      if (!newLocalValue) throw new Error('Choose a valid date first.');

      const oldStart = parseEventDate(source.start);
      const newStart = new Date(newLocalValue);
      if (!oldStart || Number.isNaN(newStart.getTime())) throw new Error('Invalid date.');

      const payload = { ...source, start: newStart.toISOString() };
      if (source.end) {
        const duration = eventDurationMs(source);
        payload.end = new Date(newStart.getTime() + duration).toISOString();
      }

      const result = await saveEvent(payload);
      renderAdminEvents();
      renderDisplay();
      return result;
    }


    async function handleAdminTaskActionClick(event) {
      if (!els.taskActionOverlay || els.taskActionOverlay.classList.contains('hidden')) return;
      const activeId = state.activeAdminInstanceId;
      if (!activeId) return;

      const close = event.target.closest('[data-action-close]');
      const edit = event.target.closest('[data-action-edit]')?.dataset.actionEdit;
      const changeDate = event.target.closest('[data-action-change-date]');
      const complete = event.target.closest('[data-action-complete]');
      const del = event.target.closest('[data-action-delete]');

      try {
        if (close) {
          closeAdminTaskActions();
          return;
        }

        if (edit) {
          closeAdminTaskActions();
          editEvent(edit);
          return;
        }

        if (changeDate) {
          const input = els.taskActionOverlay.querySelector('[data-action-date]');
          setStatus('Changing date…');
          await changeEventDate(activeId, input?.value);
          closeAdminTaskActions();
          setStatus('Date changed.');
          return;
        }

        if (complete) {
          setStatus('Updating completion…');
          await toggleComplete(activeId);
          closeAdminTaskActions();
          setStatus('Task completion updated.');
          return;
        }

        if (del) {
          setStatus('Deleting…');
          const didDelete = await deleteTaskWithChoice(activeId);
          if (!didDelete) {
            setStatus('Delete cancelled.');
            return;
          }
          closeAdminTaskActions();
          renderAdminEvents();
          renderDisplay();
          setStatus(getPendingWrites().length ? 'Deleted locally. Server is busy, so it will retry.' : 'Deleted.');
        }
      } catch (error) {
        setStatus(error.message, true);
      }
    }

    function goToDisplayMode() {
      const url = new URL(location.href);
      url.searchParams.delete('admin');
      url.searchParams.set('display', '1');
      location.href = `${url.pathname}${url.search}${url.hash}`;
    }

    async function toggleFullscreen() {
      if (adminMode) return;
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          setTimeout(fitKioskToScreen, 120);
          return;
        }
        const target = document.documentElement;
        if (target.requestFullscreen) {
          await target.requestFullscreen({ navigationUI: 'hide' });
        }
        setTimeout(fitKioskToScreen, 120);
      } catch (error) {
        console.warn('Fullscreen request failed:', error);
      }
    }

    function bindFullscreenShortcut() {
      const clock = els.clockCard;
      if (!clock) return;
      let lastPress = 0;
      let singlePressTimer = null;

      const returnToToday = () => {
        if (adminMode) return;
        const todayKey = dateKey(new Date());
        const viewingAnotherDay = state.selectedDayKey && state.selectedDayKey !== todayKey;
        const hasTodayTask = getTodayEventsForCycle().length > 0;

        if (viewingAnotherDay || !hasTodayTask) {
          clearSelectedDayPreview();
          return;
        }

        state.selectedDayKey = null;
        state.dailyCalendarMode = !state.dailyCalendarMode;
        state.upcomingPage = 0;
        state.selectedEventFlipped = false;
        state.heroEventFlipped = false;
        startDailyHomeTimer();
        updateClock();
        renderDisplay();
      };

      const handleClockPress = event => {
        if (adminMode) return;
        // Do not let the day buttons inside the clock card trigger "return to today".
        // Only the actual clock/date area should use this shortcut.
        if (event.target?.closest?.('.week-view, .week-day, .daily-calendar-panel, .daily-calendar-day')) return;
        const now = Date.now();
        const isDoublePress = now - lastPress < 420;

        if (isDoublePress) {
          event.preventDefault?.();
          if (singlePressTimer) clearTimeout(singlePressTimer);
          singlePressTimer = null;
          lastPress = 0;
          toggleFullscreen();
          return;
        }

        lastPress = now;
        if (singlePressTimer) clearTimeout(singlePressTimer);
        singlePressTimer = setTimeout(() => {
          singlePressTimer = null;
          lastPress = 0;
          returnToToday();
        }, 260);
      };

      clock.addEventListener('pointerup', handleClockPress);
      clock.addEventListener('dblclick', event => {
        event.preventDefault();
        if (singlePressTimer) clearTimeout(singlePressTimer);
        singlePressTimer = null;
      });
      document.addEventListener('fullscreenchange', () => setTimeout(fitKioskToScreen, 120));
    }

    function bindAdmin() {
      els.pinInput.value = getPin();
      els.savePinBtn.addEventListener('click', () => {
        localStorage.setItem('homeOrganizerAdminPin', els.pinInput.value.trim());
        if (els.configPinInput) els.configPinInput.value = els.pinInput.value.trim();
        renderAdminShell();
        renderAdminEvents();
        setStatus('PIN saved on this phone.');
      });

      els.newTaskBtn?.addEventListener('click', openNewEventEditor);
      setReminderMenuExpanded(state.reminderMenuExpanded, { persist: false });
      els.reminderMenuToggle?.addEventListener('click', toggleReminderMenu);
      els.saveReminderSettingsBtn?.addEventListener('click', saveReminderSettings);
      els.weeklyUpdatesInput?.addEventListener('change', () => setReminderMenuStatus('Unsaved reminder setting. Press Save.'));
      els.dailyNewTasksInput?.addEventListener('change', () => setReminderMenuStatus('Unsaved reminder setting. Press Save.'));
      document.querySelectorAll('[data-weekly-recipient], [data-daily-recipient]').forEach(input => {
        input.addEventListener('change', () => setReminderMenuStatus('Unsaved recipient setting. Press Save.'));
      });
      els.showFrequentRepeatingInput?.addEventListener('change', () => {
        state.showFrequentRepeatingTasks = Boolean(els.showFrequentRepeatingInput.checked);
        localStorage.setItem('homeOrganizerShowFrequentRepeatingTasks', state.showFrequentRepeatingTasks ? '1' : '0');
        renderAdminEvents();
      });
      els.closeEditorBtn?.addEventListener('click', () => closeEventEditor());
      els.emailReminderInput?.addEventListener('change', () => {
        setEmailReminderOptionsVisible();
        if (els.emailReminderInput.checked) renderEmailContacts(getSelectedReminderRecipients());
      });

      els.imageInput.addEventListener('change', () => {
        const file = els.imageInput.files?.[0];
        if (!file) {
          state.pendingImageFocus = null;
          state.imageFocusToken += 1;
          els.imageStatus.textContent = els.imageUrlInput.value
            ? 'Current image will be kept unless you upload a new one.'
            : 'No image selected. A calm placeholder will be used.';
          return;
        }

        updateImageFocusPreview(file);
      });

      [els.imageFocusXInput, els.imageFocusYInput, els.imageZoomInput].forEach(input => {
        input?.addEventListener('input', renderManualImagePreview);
      });
      els.titleInput?.addEventListener('input', renderManualImagePreview);
      els.imageCenterBtn?.addEventListener('click', () => {
        setManualImageControls({ imageFocusX: 50, imageFocusY: 50, imageZoom: 1.01 });
      });
      els.imageTextSafeBtn?.addEventListener('click', () => {
        setManualImageControls({ imageFocusX: 50, imageFocusY: 34, imageZoom: 1.08 });
      });

      els.eventForm.addEventListener('submit', async event => {
        event.preventDefault();
        els.saveEventBtn.disabled = true;
        setStatus('Saving…');
        try {
          if (els.pinInput.value.trim() && els.pinInput.value.trim() !== getPin()) {
            localStorage.setItem('homeOrganizerAdminPin', els.pinInput.value.trim());
          }
          const imageUrl = await uploadImageIfNeeded();
          const payload = {
            id: els.eventId.value || undefined,
            title: els.titleInput.value,
            start: fromLocalInputValue(els.startInput.value),
            end: fromLocalInputValue(els.endInput.value),
            location: els.locationInput.value,
            note: els.noteInput.value,
            repeat: els.repeatInput?.value || 'none',
            imageUrl,
            emailReminder: collectEmailReminderPayload(),
            ...currentImageFocusPayload(),
            featured: els.featuredInput.checked
          };
          const saved = await saveEvent(payload);
          resetForm();
          setStatus('Saved instantly on this device. Syncing to the server in the background.');
          closeEventEditor({ reset: false });
          closeAdminTaskActions();
          renderAdminEvents();
        } catch (error) {
          setStatus(error.message, true);
        } finally {
          els.saveEventBtn.disabled = false;
        }
      });

      els.resetBtn.addEventListener('click', resetForm);

      els.adminEvents.addEventListener('click', async event => {
        const cardId = event.target.closest('[data-admin-card]')?.dataset.adminCard;
        if (cardId) openAdminTaskActions(cardId);
      });

      els.taskActionOverlay?.addEventListener('click', async event => {
        if (event.target === els.taskActionOverlay) {
          closeAdminTaskActions();
          return;
        }
        await handleAdminTaskActionClick(event);
      });

      window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && els.taskActionOverlay && !els.taskActionOverlay.classList.contains('hidden')) {
          closeAdminTaskActions();
        }
      });

      resetForm();
      closeEventEditor({ reset: false });
      renderAdminShell();
    }


    function bindWeatherOverlay() {
      els.weatherCard?.addEventListener('click', event => {
        if (event.target.closest?.('.selected-event-panel, .daily-calendar-panel, button, a')) return;
        if (state.dailyCalendarMode) return;
        openWeatherOverlay();
      });
      els.weatherOverlayCloseBtn?.addEventListener('click', closeWeatherOverlay);
      els.weatherOverlay?.addEventListener('click', event => {
        if (event.target === els.weatherOverlay) closeWeatherOverlay();
      });
      window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !els.weatherOverlay?.classList.contains('hidden')) closeWeatherOverlay();
      });
    }


    async function handleHeroBackActionClick(event) {
      const completeButton = event.target.closest?.('[data-hero-complete]');
      const editButton = event.target.closest?.('[data-hero-edit]');
      const deleteButton = event.target.closest?.('[data-hero-delete-instance]');
      const closeButton = event.target.closest?.('[data-hero-close]');
      if (!completeButton && !editButton && !deleteButton && !closeButton) return false;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      try {
        if (completeButton) {
          if (!ensureDisplayActionPin()) return true;
          completeButton.disabled = true;
          await toggleComplete(completeButton.dataset.heroComplete);
          setTaskCardFlipped('hero', false);
          renderDisplay();
          return true;
        }

        if (editButton) {
          location.href = `${location.pathname}?admin=1&edit=${encodeURIComponent(editButton.dataset.heroEdit)}`;
          return true;
        }

        if (deleteButton) {
          if (!ensureDisplayActionPin()) return true;
          deleteButton.disabled = true;
          const didDelete = await deleteTaskWithChoice(deleteButton.dataset.heroDeleteInstance);
          if (didDelete) clearSelectedDayPreview();
          else renderDisplay();
          return true;
        }

        if (closeButton) {
          state.heroEventFlipped = false;
          renderDisplay();
          return true;
        }
      } catch (error) {
        alert(error.message || 'Could not update task. Make sure the admin PIN is saved on this device.');
        renderDisplay();
        return true;
      }

      return true;
    }

    function bindDangerMenu() {
      els.dangerCloseBtn?.addEventListener('click', closeDangerMenu);
      els.cancelDeleteAllBtn?.addEventListener('click', closeDangerMenu);
      els.deleteAllEventsBtn?.addEventListener('click', deleteAllEvents);
      els.dangerOverlay?.addEventListener('click', event => {
        if (event.target === els.dangerOverlay) closeDangerMenu();
      });

      const title = els.adminTitle;
      if (!title) return;
      const startTitleHold = event => {
        event.stopPropagation();
        state.dangerHoldOpened = false;
        clearTimeout(state.dangerHoldTimer);
        state.dangerHoldTimer = setTimeout(() => {
          state.dangerHoldOpened = true;
          openDangerMenu();
        }, 950);
      };
      const cancelTitleHold = event => {
        event?.stopPropagation?.();
        clearTimeout(state.dangerHoldTimer);
        state.dangerHoldTimer = null;
      };
      title.addEventListener('pointerdown', startTitleHold);
      title.addEventListener('pointerup', cancelTitleHold);
      title.addEventListener('pointercancel', cancelTitleHold);
      title.addEventListener('pointermove', event => {
        if (Math.abs(event.movementX || 0) + Math.abs(event.movementY || 0) > 12) cancelTitleHold(event);
      });
      title.addEventListener('contextmenu', event => {
        if (state.dangerHoldOpened) event.preventDefault();
      });
    }


    // Camera motion dimmer
    // - Website mode: darkens with an overlay after 30 minutes without camera motion.
    // - Electron/PC app mode: also asks the desktop wrapper to change Windows brightness.
    const MOTION_DIMMER_ENABLED_KEY = 'homeOrganizerMotionDimmerEnabled';
    const MOTION_DIMMER_IDLE_MS = 30 * 60 * 1000;
    const MOTION_DIMMER_CHECK_MS = 2000;
    const MOTION_DIMMER_THRESHOLD = 22;
    const MOTION_DIM_BRIGHTNESS = 18;
    const MOTION_FULL_BRIGHTNESS = 100;

    const motionDimmer = {
      enabled: false,
      running: false,
      dimmed: false,
      lastMotionAt: Date.now(),
      stream: null,
      video: null,
      canvas: null,
      ctx: null,
      previousFrame: null,
      timer: null,
      bootHideTimer: null,
      button: null,
      overlay: null,
    };

    function updateMotionDimmerButton() {
      if (!motionDimmer.button) return;
      motionDimmer.button.textContent = motionDimmer.enabled ? 'Camera dimmer on' : 'Camera dimmer off';
      motionDimmer.button.classList.toggle('is-on', motionDimmer.enabled);
    }

    function hideMotionDimmerBootButton() {
      if (!motionDimmer.button) return;
      motionDimmer.button.classList.add('is-boot-hidden');
      motionDimmer.button.setAttribute('aria-hidden', 'true');
      motionDimmer.button.tabIndex = -1;
    }

    function startMotionDimmerBootVisibilityTimer() {
      clearTimeout(motionDimmer.bootHideTimer);
      motionDimmer.bootHideTimer = setTimeout(hideMotionDimmerBootButton, 30 * 1000);
    }

    async function setScreenBrightnessPercent(percent) {
      const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
      try {
        if (window.organizerBrightness?.setBrightness) {
          await window.organizerBrightness.setBrightness(safePercent);
        }
      } catch (error) {
        console.warn('Could not set PC brightness:', error);
      }
    }

    async function setMotionDimmed(dimmed) {
      if (motionDimmer.dimmed === dimmed) return;
      motionDimmer.dimmed = dimmed;
      document.body.classList.toggle('motion-dimmed', dimmed);
      await setScreenBrightnessPercent(dimmed ? MOTION_DIM_BRIGHTNESS : MOTION_FULL_BRIGHTNESS);
    }

    function detectMotionFromCameraFrame() {
      if (!motionDimmer.video || motionDimmer.video.readyState < 2) return;

      const w = 96;
      const h = 54;
      motionDimmer.ctx.drawImage(motionDimmer.video, 0, 0, w, h);
      const image = motionDimmer.ctx.getImageData(0, 0, w, h);
      const data = image.data;

      if (!motionDimmer.previousFrame) {
        motionDimmer.previousFrame = new Uint8ClampedArray(data);
        return;
      }

      let changed = 0;
      for (let i = 0; i < data.length; i += 16) {
        const diff = Math.abs(data[i] - motionDimmer.previousFrame[i])
          + Math.abs(data[i + 1] - motionDimmer.previousFrame[i + 1])
          + Math.abs(data[i + 2] - motionDimmer.previousFrame[i + 2]);
        if (diff > MOTION_DIMMER_THRESHOLD) changed++;
      }

      motionDimmer.previousFrame = new Uint8ClampedArray(data);

      if (changed > 18) {
        motionDimmer.lastMotionAt = Date.now();
        if (motionDimmer.dimmed) setMotionDimmed(false);
      }

      const idleFor = Date.now() - motionDimmer.lastMotionAt;
      if (idleFor >= MOTION_DIMMER_IDLE_MS) setMotionDimmed(true);
    }

    async function startMotionDimmer() {
      if (motionDimmer.running) return true;
      if (!navigator.mediaDevices?.getUserMedia) {
        alert('Camera access is not available in this browser/app.');
        return false;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 320 }, height: { ideal: 180 } },
          audio: false,
        });

        motionDimmer.stream = stream;
        motionDimmer.video = document.createElement('video');
        motionDimmer.video.className = 'motion-camera-video';
        motionDimmer.video.autoplay = true;
        motionDimmer.video.muted = true;
        motionDimmer.video.playsInline = true;
        motionDimmer.video.srcObject = stream;
        document.body.appendChild(motionDimmer.video);
        await motionDimmer.video.play();

        motionDimmer.canvas = document.createElement('canvas');
        motionDimmer.canvas.width = 96;
        motionDimmer.canvas.height = 54;
        motionDimmer.ctx = motionDimmer.canvas.getContext('2d', { willReadFrequently: true });
        motionDimmer.previousFrame = null;
        motionDimmer.lastMotionAt = Date.now();
        motionDimmer.running = true;
        motionDimmer.timer = setInterval(detectMotionFromCameraFrame, MOTION_DIMMER_CHECK_MS);
        return true;
      } catch (error) {
        console.warn('Camera motion dimmer failed:', error);
        alert('Could not start camera motion dimmer. Allow camera access and try again.');
        return false;
      }
    }

    async function stopMotionDimmer() {
      motionDimmer.running = false;
      clearInterval(motionDimmer.timer);
      motionDimmer.timer = null;
      motionDimmer.previousFrame = null;
      if (motionDimmer.stream) motionDimmer.stream.getTracks().forEach(track => track.stop());
      motionDimmer.stream = null;
      motionDimmer.video?.remove();
      motionDimmer.video = null;
      await setMotionDimmed(false);
    }

    async function toggleMotionDimmer() {
      if (motionDimmer.enabled) {
        motionDimmer.enabled = false;
        localStorage.setItem(MOTION_DIMMER_ENABLED_KEY, '0');
        await stopMotionDimmer();
        updateMotionDimmerButton();
        return;
      }

      motionDimmer.enabled = true;
      localStorage.setItem(MOTION_DIMMER_ENABLED_KEY, '1');
      updateMotionDimmerButton();
      const ok = await startMotionDimmer();
      if (!ok) {
        motionDimmer.enabled = false;
        localStorage.setItem(MOTION_DIMMER_ENABLED_KEY, '0');
        updateMotionDimmerButton();
      }
    }

    function bindMotionDimmer() {
      if (isPhoneLike) {
        motionDimmer.enabled = false;
        document.body.classList.remove('motion-dimmed');
        return;
      }
      motionDimmer.overlay = document.createElement('div');
      motionDimmer.overlay.className = 'motion-dim-overlay';
      document.body.appendChild(motionDimmer.overlay);

      motionDimmer.button = document.createElement('button');
      motionDimmer.button.type = 'button';
      motionDimmer.button.className = 'motion-dimmer-toggle';
      motionDimmer.button.addEventListener('click', toggleMotionDimmer);
      document.body.appendChild(motionDimmer.button);
      startMotionDimmerBootVisibilityTimer();

      motionDimmer.enabled = localStorage.getItem(MOTION_DIMMER_ENABLED_KEY) === '1';
      updateMotionDimmerButton();
      if (motionDimmer.enabled) startMotionDimmer();
    }

    function init() {
      setMode();
      window.addEventListener('resize', () => { fitKioskToScreen(); if (!adminMode) renderDisplay(); });
      window.addEventListener('orientationchange', () => setTimeout(fitKioskToScreen, 250));
      bindMonthView();
      bindConfigMenu();
      bindWeatherOverlay();
      bindDangerMenu();
      bindFullscreenShortcut();
      bindMotionDimmer();
      els.returnToDisplayBtn?.addEventListener('click', goToDisplayMode);
      document.addEventListener('click', event => {
        handleHeroBackActionClick(event);
      }, true);
      document.addEventListener('pointerdown', event => {
        if (event.target.closest?.('[data-hero-complete], [data-hero-edit], [data-hero-delete-instance], [data-hero-close], [data-display-add-email-reminders], [data-display-email-recipient]')) {
          event.stopPropagation();
        }
      }, true);
      loadConfig();
      if (els.weekView) {
        els.weekView.addEventListener('pointerup', event => {
          // Keep date taps from bubbling to the clock-card shortcut.
          if (event.target.closest('.week-day')) event.stopPropagation();
        });
        els.weekView.addEventListener('click', event => {
          const dayButton = event.target.closest('.week-day.has-event');
          if (!dayButton) return;
          event.stopPropagation();
          selectDayPreview(dayButton.dataset.day);
        });
      }
      if (els.dailyCalendarPanel) {
        els.dailyCalendarPanel.addEventListener('pointerdown', event => {
          if (event.target.closest?.('[data-daily-calendar-day]')) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
          }
        }, true);
        els.dailyCalendarPanel.addEventListener('pointerup', event => {
          handleDailyCalendarDayPick(event);
        }, true);
        els.dailyCalendarPanel.addEventListener('click', event => {
          handleDailyCalendarDayPick(event);
        }, true);
      }
      if (els.upcomingPager) {
        els.upcomingPager.addEventListener('click', event => {
          const loadHidden = event.target.closest('[data-load-hidden-repeats]');
          if (loadHidden) {
            event.stopPropagation();
            showHiddenRepeatingTasksTemporarily();
            return;
          }
          const direction = event.target.closest('[data-upcoming-page]')?.dataset.upcomingPage;
          if (!direction) return;
          event.stopPropagation();
          state.upcomingPage = Math.max(0, state.upcomingPage + (direction === 'next' ? 1 : -1));
          renderDisplay();
        });
      }

      if (els.upcomingGrid) {
        els.upcomingGrid.addEventListener('click', event => {
          const pick = event.target.closest('[data-upcoming-pick]')?.dataset.upcomingPick;
          if (!pick) return;
          selectEventPreview(pick);
        });
      }

      if (els.heroEvent) {
        els.heroEvent.addEventListener('click', async event => {
          const completeId = event.target.closest('[data-hero-complete]')?.dataset.heroComplete;
          const editId = event.target.closest('[data-hero-edit]')?.dataset.heroEdit;
          const deleteInstanceId = event.target.closest('[data-hero-delete-instance]')?.dataset.heroDeleteInstance;
          const close = event.target.closest('[data-hero-close]');
          const addEmail = event.target.closest('[data-display-add-email-reminders]');
          const interactive = event.target.closest('button, input, textarea, select, a, label');
          if (completeId || editId || deleteInstanceId || close || addEmail || interactive) event.stopPropagation();

          try {
            if (addEmail) {
              await addEmailRemindersFromDisplay(addEmail.dataset.displayAddEmailReminders, addEmail);
              return;
            }
            if (interactive && !completeId && !editId && !deleteInstanceId && !close) return;
            if (completeId) {
              if (!ensureDisplayActionPin()) return;
              await toggleComplete(completeId);
              state.heroEventFlipped = false;
              renderDisplay();
              return;
            }
            if (editId) {
              location.href = `${location.pathname}?admin=1&edit=${encodeURIComponent(editId)}`;
              return;
            }
            if (deleteInstanceId) {
              if (!ensureDisplayActionPin()) return;
              const didDelete = await deleteTaskWithChoice(deleteInstanceId);
              if (didDelete) clearSelectedDayPreview();
              return;
            }
            if (close) {
              setTaskCardFlipped('hero', false);
              renderDisplay();
              return;
            }
            if (event.target.closest('[data-hero-flip]') && !state.heroEventFlipped) {
              setTaskCardFlipped('hero', true);
              renderDisplay();
            }
          } catch (error) {
            alert(error.message || 'Could not update task. Make sure the admin PIN is saved on this device.');
          }
        });
      }

      if (els.selectedEventPanel) {
        els.selectedEventPanel.addEventListener('click', async event => {
          const flip = event.target.closest('[data-selected-flip]');
          const pickId = event.target.closest('[data-selected-pick]')?.dataset.selectedPick;
          const completeId = event.target.closest('[data-display-complete]')?.dataset.displayComplete;
          const editId = event.target.closest('[data-display-edit]')?.dataset.displayEdit;
          const deleteInstanceId = event.target.closest('[data-display-delete-instance]')?.dataset.displayDeleteInstance;
          const close = event.target.closest('[data-selected-close]');
          const addEmail = event.target.closest('[data-display-add-email-reminders]');

          const interactive = event.target.closest('button, input, textarea, select, a, label');
          if (pickId || completeId || editId || deleteInstanceId || close || addEmail || interactive) event.stopPropagation();

          try {
            if (addEmail) {
              await addEmailRemindersFromDisplay(addEmail.dataset.displayAddEmailReminders, addEmail);
              return;
            }
            if (interactive && !pickId && !completeId && !editId && !deleteInstanceId && !close) return;
            if (pickId) {
              state.selectedInstanceId = pickId;
              state.selectedEventFlipped = false;
              renderDisplay();
              return;
            }
            if (completeId) {
              if (!ensureDisplayActionPin()) return;
              await toggleComplete(completeId);
              state.selectedEventFlipped = false;
              renderDisplay();
              return;
            }
            if (editId) {
              location.href = `${location.pathname}?admin=1&edit=${encodeURIComponent(editId)}`;
              return;
            }
            if (deleteInstanceId) {
              if (!ensureDisplayActionPin()) return;
              const didDelete = await deleteTaskWithChoice(deleteInstanceId);
              if (didDelete) clearSelectedDayPreview();
              return;
            }
            if (close) {
              setTaskCardFlipped('selected', false);
              renderDisplay();
              return;
            }
            if (flip && !state.selectedEventFlipped) {
              setTaskCardFlipped('selected', true);
              renderDisplay();
            }
          } catch (error) {
            alert(error.message || 'Could not update task. Make sure the admin PIN is saved on this device.');
          }
        });
      }
      updateClock();
      setInterval(updateClock, 1000);
      if (!adminMode) setInterval(renderDisplay, 60 * 1000);
      fetchWeather();
      setInterval(fetchWeather, 30 * 60 * 1000);
      hydrateEventsFromLocalCache();
      // Page boot should always spend one fresh read so the dashboard starts with newest data.
      // Local cache still renders instantly first, then this refresh replaces it when loaded.
      fetchEvents({ force: true, reason: 'page-boot' });
      bindInteractionRefresh();
      scheduleNextHourlyEventRefresh();
      window.addEventListener('online', () => processPendingWrites({ silent: true }));
      window.addEventListener('storage', event => {
        if (event.key === LAST_WRITE_SIGNAL_KEY) {
          renderFromLocalState();
          // Another open tab already updated local state. Do not spend a Blob read here.
        }
      });
      window.addEventListener('pageshow', () => {
        hydrateEventsFromLocalCache();
        renderFromLocalState();
      });
      if (adminMode) {
        bindAdmin();
        loadReminderSettings();
      }
    }

    init();
  