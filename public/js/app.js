/**
 * SMS2Pay POS Terminal Application
 * Offline-first SMS Payment Client & State Machine
 */

(function () {
  'use strict';

  // Constants & Storage Keys
  const STORAGE_KEYS = {
    HISTORY: 'sms2pay_pos_history_v1',
    SETTINGS: 'sms2pay_pos_settings_v1',
    ACTIVE_TX: 'sms2pay_active_tx_v1'
  };

  const DEFAULT_SHORTCODE = '66578';
  const TIMEOUT_SECONDS = 60;

  // Pre-seeded pending transaction for demo flip test
  const DEMO_PRESEEDED_UUID = 'A1B2C3D4E5F60718293A4B5C';
  const DEMO_PRESEEDED_PHONE = '0722123456';
  const DEMO_PRESEEDED_AMOUNT = '250';

  // State Machine States
  const STATES = {
    IDLE: 'IDLE',               // Screen 1: New Payment
    REVIEW: 'REVIEW',           // Screen 2: Confirm
    SENDING: 'SENDING',         // Screen 3: State A
    WAITING: 'WAITING',         // Screen 3: State B (60s countdown)
    SEND_FAILED: 'SEND_FAILED', // Screen 3: State C (Network/SIM error)
    TIMEOUT: 'TIMEOUT',         // Screen 3: State D (60s expired)
    SUCCESS: 'SUCCESS',         // Screen 4: Result OK
    FAILURE: 'FAILURE',         // Screen 4: Result FAIL
    HISTORY: 'HISTORY'          // Screen 5: History View
  };

  // Application State
  const appState = {
    currentState: STATES.IDLE,
    shortcode: DEFAULT_SHORTCODE,
    hasSignal: true,
    autoRespond: false,
    autoRespondDelay: 4, // seconds
    timeoutRemaining: TIMEOUT_SECONDS,
    timerInterval: null,
    historyFilter: 'all',

    // In-flight transaction
    inFlight: null
    /*
      {
        uuid: '...',
        phone: '...',
        normalizedPhone: '...',
        amount: '...',
        reference: '...',
        payMessage: '...',
        resMessage: null,
        status: 'Pending', // 'Pending' | 'Success' | 'Failed' | 'Timeout' | 'Send Failed'
        failureReason: null,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    */
  };

  // DOM Elements
  const elements = {
    // Hardware Status
    statusBarTime: document.getElementById('status-time'),
    statusBarShortcode: document.getElementById('status-shortcode'),
    signalIndicator: document.getElementById('signal-indicator'),
    pendingBanner: document.getElementById('pending-banner'),
    pendingBannerText: document.getElementById('pending-banner-text'),
    pendingBannerLink: document.getElementById('pending-banner-link'),
    pendingBadgeCount: document.getElementById('pending-badge-count'),

    // Screens
    screenNewPayment: document.getElementById('screen-new-payment'),
    screenConfirm: document.getElementById('screen-confirm'),
    screenWaiting: document.getElementById('screen-waiting'),
    screenResult: document.getElementById('screen-result'),
    screenHistory: document.getElementById('screen-history'),

    // Navigation & Buttons
    btnOpenHistory: document.getElementById('btn-open-history'),
    btnOpenSettings: document.getElementById('btn-open-settings'),
    btnBackFromHistory: document.getElementById('btn-back-history'),

    // Screen 1: New Payment
    inputPhone: document.getElementById('input-phone'),
    inputAmount: document.getElementById('input-amount'),
    inputReference: document.getElementById('input-reference'),
    phoneError: document.getElementById('phone-error'),
    amountError: document.getElementById('amount-error'),
    btnSendPayment: document.getElementById('btn-send-payment'),
    quickAmtButtons: document.querySelectorAll('.quick-amt-btn'),

    // Screen 2: Confirm
    confirmPhone: document.getElementById('confirm-phone'),
    confirmAmount: document.getElementById('confirm-amount'),
    confirmReferenceRow: document.getElementById('confirm-ref-row'),
    confirmReference: document.getElementById('confirm-reference'),
    confirmShortcode: document.getElementById('confirm-shortcode'),
    confirmSmsPreview: document.getElementById('confirm-sms-preview'),
    btnConfirmCancel: document.getElementById('btn-confirm-cancel'),
    btnConfirmSend: document.getElementById('btn-confirm-send'),

    // Screen 3: Waiting / Sending states
    stateSending: document.getElementById('state-sending'),
    stateWaiting: document.getElementById('state-waiting'),
    stateSendFailed: document.getElementById('state-send-failed'),
    stateTimeout: document.getElementById('state-timeout'),
    waitingCountdownText: document.getElementById('waiting-countdown-text'),
    waitingCountdownBar: document.getElementById('waiting-countdown-bar'),
    waitingPhoneDisplay: document.getElementById('waiting-phone-display'),
    waitingAmountDisplay: document.getElementById('waiting-amount-display'),
    waitingUuidDisplay: document.getElementById('waiting-uuid-display'),
    btnRetrySend: document.getElementById('btn-retry-send'),
    btnCancelFailed: document.getElementById('btn-cancel-failed'),
    btnTimeoutStatus: document.getElementById('btn-timeout-status'),
    btnTimeoutNew: document.getElementById('btn-timeout-new'),

    // Screen 4: Result
    resultIcon: document.getElementById('result-icon'),
    resultTitle: document.getElementById('result-title'),
    resultSubtitle: document.getElementById('result-subtitle'),
    resultAmount: document.getElementById('result-amount'),
    resultPhone: document.getElementById('result-phone'),
    resultReceipt: document.getElementById('result-receipt'),
    resultTime: document.getElementById('result-time'),
    resultRawSms: document.getElementById('result-raw-sms'),
    btnResultNew: document.getElementById('btn-result-new'),
    btnResultHistory: document.getElementById('btn-result-history'),
    btnResultTryAgain: document.getElementById('btn-result-try-again'),

    // Screen 5: History
    historyList: document.getElementById('history-list'),
    historyFilterPills: document.querySelectorAll('.filter-pill'),
    historyEmptyState: document.getElementById('history-empty'),

    // Modals
    modalDetail: document.getElementById('modal-detail'),
    modalDetailClose: document.getElementById('modal-detail-close'),
    detailUuid: document.getElementById('detail-uuid'),
    detailPhone: document.getElementById('detail-phone'),
    detailAmount: document.getElementById('detail-amount'),
    detailStatusBadge: document.getElementById('detail-status-badge'),
    detailTime: document.getElementById('detail-time'),
    detailReference: document.getElementById('detail-reference'),
    detailPay1: document.getElementById('detail-pay1'),
    detailRes1: document.getElementById('detail-res1'),

    modalSettings: document.getElementById('modal-settings'),
    modalSettingsClose: document.getElementById('modal-settings-close'),
    inputShortcode: document.getElementById('input-shortcode'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    btnResetDemoData: document.getElementById('btn-reset-demo'),
    settingsAlert: document.getElementById('settings-alert'),

    // Simulator Panel
    simSignalToggle: document.getElementById('sim-signal-toggle'),
    simAutoToggle: document.getElementById('sim-auto-toggle'),
    btnSimOk: document.getElementById('btn-sim-ok'),
    btnSimCancel: document.getElementById('btn-sim-cancel'),
    btnSimTimeout: document.getElementById('btn-sim-timeout'),
    btnSimInsufficient: document.getElementById('btn-sim-insufficient'),
    btnSimFlipPending: document.getElementById('btn-sim-flip-pending'),
    simCustomSms: document.getElementById('sim-custom-sms'),
    btnSimSendCustom: document.getElementById('btn-sim-send-custom'),
    trafficLog: document.getElementById('traffic-log')
  };

  // ==========================================
  // UTILITIES & HELPERS
  // ==========================================

  /**
   * Generates a 24-character uppercase hex UUID using crypto.getRandomValues
   */
  function generate24CharHexUUID() {
    const array = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(array);
    } else {
      // Fallback
      for (let i = 0; i < 12; i++) {
        array[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(array)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  /**
   * Normalises customer phone number:
   * Strips spaces, dashes, parentheses.
   * Converts +254... to 254...
   */
  function normalisePhone(rawPhone) {
    if (!rawPhone) return '';
    let cleaned = rawPhone.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) {
      cleaned = cleaned.substring(1);
    }
    return cleaned;
  }

  /**
   * Validates customer phone:
   * Digits only, 10–12 chars, starts with '0' or '254'
   */
  function validatePhone(phone) {
    const cleaned = normalisePhone(phone);
    if (!/^\d+$/.test(cleaned)) return false;
    if (cleaned.length < 10 || cleaned.length > 12) return false;
    return cleaned.startsWith('0') || cleaned.startsWith('254');
  }

  /**
   * Formats phone for human readability: e.g. 0712 345 678
   */
  function formatPhoneDisplay(phone) {
    const n = normalisePhone(phone);
    if (n.startsWith('0') && n.length === 10) {
      return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
    }
    if (n.startsWith('254') && n.length === 12) {
      return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9)}`;
    }
    return n;
  }

  /**
   * Validates amount:
   * Digits only, 1–8 chars, min 1 shilling, whole integer, no decimals
   */
  function validateAmount(amount) {
    if (!amount) return false;
    const str = String(amount).trim();
    if (!/^\d+$/.test(str)) return false;
    if (str.length < 1 || str.length > 8) return false;
    const num = parseInt(str, 10);
    return num >= 1;
  }

  /**
   * Format currency KES
   */
  function formatKes(amount) {
    const num = parseInt(amount, 10) || 0;
    return `KES ${num.toLocaleString('en-KE')}`;
  }

  /**
   * Shortens UUID for display: e.g. 550E8400...
   */
  function shortenUuid(uuid) {
    if (!uuid) return '';
    return uuid.length > 10 ? `${uuid.slice(0, 8)}…` : uuid;
  }

  /**
   * Human-friendly time
   */
  function formatTime(isoString) {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function formatDateTime(isoString) {
    const date = new Date(isoString);
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })}`;
  }

  // ==========================================
  // STORAGE & HISTORY MANAGEMENT
  // ==========================================

  function loadSettings() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.shortcode) {
          appState.shortcode = parsed.shortcode;
        }
      }
    } catch (e) {
      console.warn('Failed loading settings', e);
    }
    updateStatusBar();
  }

  function saveSettings(shortcode) {
    appState.shortcode = shortcode;
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify({ shortcode }));
    updateStatusBar();
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.HISTORY);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn('Failed loading history', e);
    }
    return [];
  }

  function saveHistory(historyArray) {
    try {
      localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(historyArray));
      updatePendingBadge();
    } catch (e) {
      console.warn('Failed saving history', e);
    }
  }

  /**
   * Seeds demo pending transaction if history is empty
   */
  function ensurePreSeededDemoTransaction() {
    const history = loadHistory();
    const hasPreseeded = history.some(item => item.uuid === DEMO_PRESEEDED_UUID);
    if (!hasPreseeded) {
      // 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const preseeded = {
        uuid: DEMO_PRESEEDED_UUID,
        phone: DEMO_PRESEEDED_PHONE,
        normalizedPhone: DEMO_PRESEEDED_PHONE,
        amount: DEMO_PRESEEDED_AMOUNT,
        reference: 'Demo Order #1',
        payMessage: `PAY1-${DEMO_PRESEEDED_PHONE}-${DEMO_PRESEEDED_AMOUNT}-${DEMO_PRESEEDED_UUID}`,
        resMessage: null,
        status: 'Pending',
        failureReason: null,
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo
      };
      history.unshift(preseeded);
      saveHistory(history);
      logTraffic(`[Init] Pre-seeded demo transaction ${DEMO_PRESEEDED_UUID} (KES ${DEMO_PRESEEDED_AMOUNT}, Pending)`, 'tx');
    }
  }

  /**
   * Upserts a transaction record in history
   */
  function upsertTransactionRecord(txRecord) {
    const history = loadHistory();
    const index = history.findIndex(item => item.uuid === txRecord.uuid);
    if (index >= 0) {
      history[index] = { ...history[index], ...txRecord, updatedAt: new Date().toISOString() };
    } else {
      history.unshift({ ...txRecord, createdAt: txRecord.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    saveHistory(history);
    renderHistoryList();
    return history;
  }

  function updatePendingBadge() {
    const history = loadHistory();
    const pendingCount = history.filter(item => item.status === 'Pending').length;
    if (pendingCount > 0) {
      elements.pendingBadgeCount.textContent = pendingCount;
      elements.pendingBadgeCount.style.display = 'flex';
    } else {
      elements.pendingBadgeCount.style.display = 'none';
    }
  }

  // ==========================================
  // TRAFFIC LOGGING (SIMULATOR)
  // ==========================================

  function logTraffic(message, type = 'tx') {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour12: false });
    const entry = document.createElement('div');
    entry.className = `traffic-entry ${type}`;
    entry.innerHTML = `<span class="traffic-time">[${timeStr}]</span> ${escapeHtml(message)}`;
    elements.trafficLog.appendChild(entry);
    elements.trafficLog.scrollTop = elements.trafficLog.scrollHeight;
  }

  function escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ==========================================
  // STATE MACHINE & NAVIGATION
  // ==========================================

  function transitionTo(newState, data = {}) {
    console.log(`State transition: ${appState.currentState} -> ${newState}`, data);
    appState.currentState = newState;

    // Hide all screens
    elements.screenNewPayment.classList.remove('active');
    elements.screenConfirm.classList.remove('active');
    elements.screenWaiting.classList.remove('active');
    elements.screenResult.classList.remove('active');
    elements.screenHistory.classList.remove('active');

    // Manage screen-specific state
    switch (newState) {
      case STATES.IDLE:
        stopCountdownTimer();
        elements.screenNewPayment.classList.add('active');
        if (data.clearInputs) {
          clearPaymentInputs();
        }
        validateNewPaymentInputs();
        break;

      case STATES.REVIEW:
        elements.screenConfirm.classList.add('active');
        renderConfirmScreen();
        break;

      case STATES.SENDING:
        elements.screenWaiting.classList.add('active');
        renderWaitingSubstate('SENDING');
        executeSmsSend();
        break;

      case STATES.WAITING:
        elements.screenWaiting.classList.add('active');
        renderWaitingSubstate('WAITING');
        startCountdownTimer();
        break;

      case STATES.SEND_FAILED:
        stopCountdownTimer();
        elements.screenWaiting.classList.add('active');
        renderWaitingSubstate('SEND_FAILED');
        break;

      case STATES.TIMEOUT:
        stopCountdownTimer();
        elements.screenWaiting.classList.add('active');
        renderWaitingSubstate('TIMEOUT');
        handleTimeoutOccurred();
        break;

      case STATES.SUCCESS:
        stopCountdownTimer();
        elements.screenResult.classList.add('active');
        renderResultScreen(true, data);
        break;

      case STATES.FAILURE:
        stopCountdownTimer();
        elements.screenResult.classList.add('active');
        renderResultScreen(false, data);
        break;

      case STATES.HISTORY:
        elements.screenHistory.classList.add('active');
        renderHistoryList();
        break;

      default:
        console.error('Unknown state:', newState);
    }

    checkPendingBanner();
  }

  // ==========================================
  // SCREEN 1: NEW PAYMENT LOGIC
  // ==========================================

  function clearPaymentInputs() {
    elements.inputPhone.value = '';
    elements.inputAmount.value = '';
    elements.inputReference.value = '';
    elements.phoneError.textContent = '';
    elements.amountError.textContent = '';
    elements.btnSendPayment.disabled = true;
  }

  function validateNewPaymentInputs() {
    const rawPhone = elements.inputPhone.value.trim();
    const rawAmount = elements.inputAmount.value.trim();

    let phoneValid = false;
    let amountValid = false;

    // Phone validation
    if (rawPhone.length === 0) {
      elements.phoneError.textContent = '';
      elements.inputPhone.classList.remove('is-invalid');
    } else {
      const cleanPhone = normalisePhone(rawPhone);
      if (validatePhone(cleanPhone)) {
        phoneValid = true;
        elements.phoneError.textContent = '';
        elements.inputPhone.classList.remove('is-invalid');
      } else {
        elements.phoneError.textContent = 'Must start with 0 or 254 (10–12 digits)';
        elements.inputPhone.classList.add('is-invalid');
      }
    }

    // Amount validation: strictly digits, no decimals
    if (rawAmount.length === 0) {
      elements.amountError.textContent = '';
      elements.inputAmount.classList.remove('is-invalid');
    } else {
      if (validateAmount(rawAmount)) {
        amountValid = true;
        elements.amountError.textContent = '';
        elements.inputAmount.classList.remove('is-invalid');
      } else {
        elements.amountError.textContent = 'Whole shillings only (min 1, no decimals)';
        elements.inputAmount.classList.add('is-invalid');
      }
    }

    elements.btnSendPayment.disabled = !(phoneValid && amountValid);
  }

  function handleStartPayment() {
    const rawPhone = elements.inputPhone.value.trim();
    const rawAmount = elements.inputAmount.value.trim();
    const reference = elements.inputReference.value.trim().substring(0, 20);

    const normalizedPhone = normalisePhone(rawPhone);
    const amount = String(parseInt(rawAmount, 10));

    // Generate 24-character uppercase hex UUID
    const uuid = generate24CharHexUUID();
    const payMessage = `PAY1-${normalizedPhone}-${amount}-${uuid}`;

    appState.inFlight = {
      uuid,
      phone: rawPhone,
      normalizedPhone,
      amount,
      reference,
      payMessage,
      resMessage: null,
      status: 'Pending',
      failureReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Store in history as pending right away
    upsertTransactionRecord(appState.inFlight);

    transitionTo(STATES.REVIEW);
  }

  // ==========================================
  // SCREEN 2: CONFIRM / REVIEW
  // ==========================================

  function renderConfirmScreen() {
    if (!appState.inFlight) return;
    const tx = appState.inFlight;

    elements.confirmPhone.textContent = formatPhoneDisplay(tx.normalizedPhone);
    elements.confirmAmount.textContent = formatKes(tx.amount);

    if (tx.reference) {
      elements.confirmReferenceRow.style.display = 'flex';
      elements.confirmReference.textContent = tx.reference;
    } else {
      elements.confirmReferenceRow.style.display = 'none';
    }

    elements.confirmShortcode.textContent = appState.shortcode;
    elements.confirmSmsPreview.textContent = tx.payMessage;
  }

  // ==========================================
  // SCREEN 3: SENDING / WAITING (4 STATES)
  // ==========================================

  function renderWaitingSubstate(substate) {
    elements.stateSending.style.display = 'none';
    elements.stateWaiting.style.display = 'none';
    elements.stateSendFailed.style.display = 'none';
    elements.stateTimeout.style.display = 'none';

    if (substate === 'SENDING') {
      elements.stateSending.style.display = 'flex';
    } else if (substate === 'WAITING') {
      elements.stateWaiting.style.display = 'flex';
      if (appState.inFlight) {
        elements.waitingPhoneDisplay.textContent = formatPhoneDisplay(appState.inFlight.normalizedPhone);
        elements.waitingAmountDisplay.textContent = formatKes(appState.inFlight.amount);
        elements.waitingUuidDisplay.textContent = shortenUuid(appState.inFlight.uuid);
      }
    } else if (substate === 'SEND_FAILED') {
      elements.stateSendFailed.style.display = 'flex';
    } else if (substate === 'TIMEOUT') {
      elements.stateTimeout.style.display = 'flex';
    }
  }

  /**
   * Simulates calling the device SMS API to send PAY1 to shortcode
   */
  function executeSmsSend() {
    if (!appState.inFlight) return;
    const tx = appState.inFlight;

    logTraffic(`[Device SMS API] Sending to ${appState.shortcode}: "${tx.payMessage}"`, 'tx');

    // Simulate SMS sending delay
    setTimeout(() => {
      // Check cellular signal
      if (!appState.hasSignal) {
        logTraffic(`[Device SMS API] SMS send failed: No cellular signal or SIM error`, 'err');
        tx.status = 'Send Failed';
        upsertTransactionRecord(tx);
        transitionTo(STATES.SEND_FAILED);
        return;
      }

      // SMS Sent successfully!
      logTraffic(`[Device SMS API] SMS sent successfully. Shortcode: ${appState.shortcode}`, 'tx');
      tx.status = 'Pending';
      upsertTransactionRecord(tx);

      // Transition to WAITING state (State B)
      transitionTo(STATES.WAITING);

      // If Auto-responder is enabled in simulator, schedule auto OK
      if (appState.autoRespond) {
        setTimeout(() => {
          if (appState.currentState === STATES.WAITING && appState.inFlight?.uuid === tx.uuid) {
            receiveSms(`RES1-${tx.uuid}-OK-${tx.amount}`);
          }
        }, appState.autoRespondDelay * 1000);
      }
    }, 1200);
  }

  /**
   * 60-Second Countdown Timer
   */
  function startCountdownTimer() {
    stopCountdownTimer();
    appState.timeoutRemaining = TIMEOUT_SECONDS;
    updateCountdownUI();

    appState.timerInterval = setInterval(() => {
      appState.timeoutRemaining -= 1;
      updateCountdownUI();

      if (appState.timeoutRemaining <= 0) {
        stopCountdownTimer();
        transitionTo(STATES.TIMEOUT);
      }
    }, 1000);
  }

  function stopCountdownTimer() {
    if (appState.timerInterval) {
      clearInterval(appState.timerInterval);
      appState.timerInterval = null;
    }
  }

  function updateCountdownUI() {
    const sec = Math.max(0, appState.timeoutRemaining);
    const mm = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, '0');
    elements.waitingCountdownText.textContent = `Waiting… ${mm}:${ss}`;

    const percent = (sec / TIMEOUT_SECONDS) * 100;
    elements.waitingCountdownBar.style.width = `${percent}%`;
  }

  function handleTimeoutOccurred() {
    if (!appState.inFlight) return;
    const tx = appState.inFlight;
    logTraffic(`[Timeout] 60s expired without confirmation for ${tx.uuid}`, 'err');
    tx.status = 'Timeout';
    upsertTransactionRecord(tx);
  }

  function handleRetrySend() {
    // Critical requirement: MUST reuse the SAME UUID on retry
    if (!appState.inFlight) return;
    logTraffic(`[Retry] Retrying with SAME UUID: ${appState.inFlight.uuid}`, 'tx');
    transitionTo(STATES.SENDING);
  }

  // ==========================================
  // INCOMING SMS RECEIVER (CORE CONTRACT)
  // ==========================================

  /**
   * Parses and handles an incoming SMS string:
   * RES1-<uuid>-OK-<amount>
   * RES1-<uuid>-FAIL-<reason>
   */
  function receiveSms(rawSms) {
    if (!rawSms || typeof rawSms !== 'string') return;
    const trimmed = rawSms.trim();
    logTraffic(`[Device SMS Receiver] Inbound SMS from ${appState.shortcode}: "${trimmed}"`, 'rx');

    const parts = trimmed.split('-');
    if (parts.length < 4 || parts[0] !== 'RES1') {
      logTraffic(`[Ignored] Malformed incoming SMS format: "${trimmed}"`, 'err');
      return;
    }

    const uuid = parts[1].toUpperCase();
    const statusPart = parts[2].toUpperCase(); // 'OK' | 'FAIL'
    const valuePart = parts[3]; // amount or reason

    // Look for matching record in history
    const history = loadHistory();
    const existingIndex = history.findIndex(item => item.uuid === uuid);

    // Rule: POS must ignore RES1 if UUID does not match any record it generated
    if (existingIndex < 0 && (!appState.inFlight || appState.inFlight.uuid !== uuid)) {
      logTraffic(`[Orphan RES1] UUID ${uuid} not recognized. Storing as orphan record.`, 'err');
      upsertTransactionRecord({
        uuid,
        phone: 'Unknown',
        normalizedPhone: 'Unknown',
        amount: statusPart === 'OK' ? valuePart : '0',
        reference: 'Orphan RES1',
        payMessage: 'N/A',
        resMessage: trimmed,
        status: statusPart === 'OK' ? 'Success' : 'Failed',
        failureReason: statusPart === 'FAIL' ? valuePart : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      return;
    }

    // Check duplicate RES1 handling: if already marked Success or Failed, ignore second one
    if (existingIndex >= 0) {
      const existing = history[existingIndex];
      if (existing.status === 'Success' || existing.status === 'Failed') {
        logTraffic(`[Duplicate RES1] UUID ${uuid} is already resolved as ${existing.status}. Ignoring duplicate.`, 'err');
        return;
      }
    }

    // Determine final status
    const isSuccess = statusPart === 'OK';
    const finalStatus = isSuccess ? 'Success' : 'Failed';
    const failureReason = isSuccess ? null : valuePart;

    // Update the record in history
    const updatedRecord = {
      uuid,
      resMessage: trimmed,
      status: finalStatus,
      failureReason,
      updatedAt: new Date().toISOString()
    };
    upsertTransactionRecord(updatedRecord);

    // Special Check: If this matches the DEMO PRE-SEEDED item, trigger visual highlight!
    if (uuid === DEMO_PRESEEDED_UUID) {
      highlightFlippedItem(uuid);
    }

    // If currently on WAITING screen and UUID matches in-flight transaction:
    if (appState.inFlight && appState.inFlight.uuid === uuid) {
      appState.inFlight.resMessage = trimmed;
      appState.inFlight.status = finalStatus;
      appState.inFlight.failureReason = failureReason;

      if (isSuccess) {
        transitionTo(STATES.SUCCESS, { tx: appState.inFlight, amount: valuePart });
      } else {
        transitionTo(STATES.FAILURE, { tx: appState.inFlight, reason: valuePart });
      }
    } else {
      // RES1 arrived while app was on another screen or backgrounded
      logTraffic(`[Async Confirmation] Updated transaction ${uuid} in history to ${finalStatus}`, 'rx');
      renderHistoryList();
    }
  }

  // ==========================================
  // SCREEN 4: RESULT SCREEN
  // ==========================================

  function renderResultScreen(isSuccess, data) {
    const tx = data?.tx || appState.inFlight;
    if (!tx) return;

    elements.resultPhone.textContent = formatPhoneDisplay(tx.normalizedPhone);
    elements.resultAmount.textContent = formatKes(tx.amount);
    elements.resultReceipt.textContent = shortenUuid(tx.uuid);
    elements.resultReceipt.title = tx.uuid;
    elements.resultTime.textContent = formatDateTime(tx.updatedAt || new Date().toISOString());
    elements.resultRawSms.textContent = tx.resMessage || 'N/A';

    if (isSuccess) {
      // Success State
      elements.resultIcon.className = 'result-icon success';
      elements.resultIcon.innerHTML = '✓';
      elements.resultTitle.textContent = 'Payment confirmed';
      elements.resultSubtitle.textContent = 'M-Pesa payment processed successfully.';

      elements.btnResultNew.style.display = 'flex';
      elements.btnResultHistory.style.display = 'flex';
      elements.btnResultTryAgain.style.display = 'none';
    } else {
      // Failure State
      elements.resultIcon.className = 'result-icon failed';
      elements.resultIcon.innerHTML = '✕';
      elements.resultTitle.textContent = 'Payment failed';

      // Parse friendly reason
      const rawReason = data?.reason || tx.failureReason || '';
      let friendlyReason = 'Payment failed. Please try again.';
      if (rawReason === 'CANCELLED') {
        friendlyReason = 'Customer cancelled the M-Pesa prompt.';
      } else if (rawReason === 'TIMEOUT') {
        friendlyReason = 'M-Pesa prompt timed out.';
      } else if (rawReason === 'INSUFFICIENT') {
        friendlyReason = 'Insufficient M-Pesa balance.';
      }

      elements.resultSubtitle.textContent = friendlyReason;

      elements.btnResultNew.style.display = 'flex';
      elements.btnResultHistory.style.display = 'flex';
      elements.btnResultTryAgain.style.display = 'flex';
    }
  }

  // ==========================================
  // SCREEN 5: HISTORY
  // ==========================================

  function renderHistoryList() {
    const history = loadHistory();
    const filter = appState.historyFilter;

    let filtered = history;
    if (filter !== 'all') {
      filtered = history.filter(item => item.status.toLowerCase() === filter.toLowerCase());
    }

    elements.historyList.innerHTML = '';

    if (filtered.length === 0) {
      elements.historyEmptyState.style.display = 'block';
      return;
    }

    elements.historyEmptyState.style.display = 'none';

    filtered.forEach(tx => {
      const itemEl = document.createElement('div');
      itemEl.className = 'history-item';
      itemEl.setAttribute('data-uuid', tx.uuid);

      // Status badge class
      let badgeClass = 'badge-pending';
      if (tx.status === 'Success') badgeClass = 'badge-success';
      else if (tx.status === 'Failed') badgeClass = 'badge-failed';
      else if (tx.status === 'Timeout') badgeClass = 'badge-timeout';

      itemEl.innerHTML = `
        <div class="history-item-top">
          <span class="history-phone">${formatPhoneDisplay(tx.normalizedPhone || tx.phone)}</span>
          <span class="history-amount">${formatKes(tx.amount)}</span>
        </div>
        <div class="history-item-bottom">
          <span class="history-time">${formatDateTime(tx.createdAt)}</span>
          <span class="status-badge ${badgeClass}">${tx.status}</span>
        </div>
      `;

      itemEl.addEventListener('click', () => openDetailModal(tx));
      elements.historyList.appendChild(itemEl);
    });

    updatePendingBadge();
  }

  function highlightFlippedItem(uuid) {
    renderHistoryList();
    setTimeout(() => {
      const row = elements.historyList.querySelector(`[data-uuid="${uuid}"]`);
      if (row) {
        row.classList.add('flipped-highlight');
        setTimeout(() => row.classList.remove('flipped-highlight'), 2200);
      }
    }, 50);
  }

  function openDetailModal(tx) {
    elements.detailUuid.textContent = tx.uuid;
    elements.detailPhone.textContent = formatPhoneDisplay(tx.normalizedPhone || tx.phone);
    elements.detailAmount.textContent = formatKes(tx.amount);

    let badgeClass = 'badge-pending';
    if (tx.status === 'Success') badgeClass = 'badge-success';
    else if (tx.status === 'Failed') badgeClass = 'badge-failed';
    else if (tx.status === 'Timeout') badgeClass = 'badge-timeout';

    elements.detailStatusBadge.className = `status-badge ${badgeClass}`;
    elements.detailStatusBadge.textContent = tx.status;

    elements.detailTime.textContent = formatDateTime(tx.createdAt);
    elements.detailReference.textContent = tx.reference || 'None';
    elements.detailPay1.textContent = tx.payMessage || 'N/A';
    elements.detailRes1.textContent = tx.resMessage || (tx.status === 'Pending' ? 'Awaiting incoming SMS...' : 'None');

    elements.modalDetail.classList.add('active');
  }

  // ==========================================
  // SETTINGS & MODALS
  // ==========================================

  function openSettingsModal() {
    // Rule: Refuse to change shortcode while in SENDING or WAITING
    if (appState.currentState === STATES.SENDING || appState.currentState === STATES.WAITING) {
      elements.settingsAlert.style.display = 'block';
      elements.settingsAlert.textContent = 'Cannot change shortcode while a payment is in progress.';
      elements.inputShortcode.disabled = true;
      elements.btnSaveSettings.disabled = true;
    } else {
      elements.settingsAlert.style.display = 'none';
      elements.inputShortcode.disabled = false;
      elements.btnSaveSettings.disabled = false;
    }

    elements.inputShortcode.value = appState.shortcode;
    elements.modalSettings.classList.add('active');
  }

  function saveSettingsModal() {
    const newShortcode = elements.inputShortcode.value.trim();
    if (!newShortcode) return;
    saveSettings(newShortcode);
    logTraffic(`[Settings] Shortcode updated to ${newShortcode}`, 'tx');
    elements.modalSettings.classList.remove('active');
  }

  function resetDemoData() {
    if (confirm('Reset all transaction history and reload demo pre-seeded items?')) {
      localStorage.removeItem(STORAGE_KEYS.HISTORY);
      ensurePreSeededDemoTransaction();
      renderHistoryList();
      elements.modalSettings.classList.remove('active');
      logTraffic('[Reset] Demo data reset to initial state.', 'tx');
    }
  }

  // ==========================================
  // MID-TRANSACTION KILL RECOVERY
  // ==========================================

  function checkPendingBanner() {
    // Scan history for pending younger than 5 min
    const history = loadHistory();
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const activePending = history.find(item => {
      const created = new Date(item.createdAt).getTime();
      return item.status === 'Pending' && created > fiveMinutesAgo;
    });

    if (activePending && appState.currentState === STATES.IDLE) {
      elements.pendingBanner.classList.remove('hidden');
      elements.pendingBannerText.textContent = `Pending payment: ${formatKes(activePending.amount)} to ${formatPhoneDisplay(activePending.normalizedPhone)}`;
      elements.pendingBannerLink.onclick = () => {
        appState.inFlight = activePending;
        transitionTo(STATES.WAITING);
      };
    } else {
      elements.pendingBanner.classList.add('hidden');
    }
  }

  // ==========================================
  // STATUS BAR & TIME
  // ==========================================

  function updateStatusBar() {
    elements.statusBarShortcode.textContent = `SMS: ${appState.shortcode}`;
    const now = new Date();
    elements.statusBarTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  // ==========================================
  // EVENT LISTENERS BINDING
  // ==========================================

  function bindEvents() {
    // Input events for Screen 1
    elements.inputPhone.addEventListener('input', validateNewPaymentInputs);
    elements.inputAmount.addEventListener('input', (e) => {
      // Reject non-integers, strip decimals e.g. 500.00
      e.target.value = e.target.value.replace(/[^\d]/g, '');
      validateNewPaymentInputs();
    });

    elements.quickAmtButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const amt = btn.getAttribute('data-amt');
        elements.inputAmount.value = amt;
        validateNewPaymentInputs();
      });
    });

    elements.btnSendPayment.addEventListener('click', handleStartPayment);

    // Screen 2 events
    elements.btnConfirmCancel.addEventListener('click', () => {
      transitionTo(STATES.IDLE, { clearInputs: false });
    });
    elements.btnConfirmSend.addEventListener('click', () => {
      transitionTo(STATES.SENDING);
    });

    // Screen 3 events
    elements.btnRetrySend.addEventListener('click', handleRetrySend);
    elements.btnCancelFailed.addEventListener('click', () => {
      transitionTo(STATES.IDLE, { clearInputs: false });
    });
    elements.btnTimeoutStatus.addEventListener('click', () => {
      transitionTo(STATES.HISTORY);
    });
    elements.btnTimeoutNew.addEventListener('click', () => {
      transitionTo(STATES.IDLE, { clearInputs: true });
    });

    // Screen 4 events
    elements.btnResultNew.addEventListener('click', () => {
      transitionTo(STATES.IDLE, { clearInputs: true });
    });
    elements.btnResultHistory.addEventListener('click', () => {
      transitionTo(STATES.HISTORY);
    });
    elements.btnResultTryAgain.addEventListener('click', () => {
      if (appState.inFlight) {
        elements.inputPhone.value = appState.inFlight.phone;
        elements.inputAmount.value = appState.inFlight.amount;
        elements.inputReference.value = appState.inFlight.reference || '';
      }
      transitionTo(STATES.IDLE, { clearInputs: false });
    });

    // Screen 5 events
    elements.btnOpenHistory.addEventListener('click', () => {
      if (appState.currentState === STATES.SENDING || appState.currentState === STATES.WAITING) {
        // Can still view history while waiting
        transitionTo(STATES.HISTORY);
      } else {
        transitionTo(STATES.HISTORY);
      }
    });

    elements.btnBackFromHistory.addEventListener('click', () => {
      if (appState.inFlight && appState.inFlight.status === 'Pending') {
        transitionTo(STATES.WAITING);
      } else {
        transitionTo(STATES.IDLE, { clearInputs: false });
      }
    });

    elements.historyFilterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        elements.historyFilterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        appState.historyFilter = pill.getAttribute('data-filter');
        renderHistoryList();
      });
    });

    // Modals
    elements.btnOpenSettings.addEventListener('click', openSettingsModal);
    elements.modalSettingsClose.addEventListener('click', () => elements.modalSettings.classList.remove('active'));
    elements.btnSaveSettings.addEventListener('click', saveSettingsModal);
    elements.btnResetDemoData.addEventListener('click', resetDemoData);
    elements.modalDetailClose.addEventListener('click', () => elements.modalDetail.classList.remove('active'));

    // SIMULATOR CONTROLS
    elements.simSignalToggle.addEventListener('change', (e) => {
      appState.hasSignal = e.target.checked;
      if (appState.hasSignal) {
        elements.signalIndicator.className = 'signal-indicator active';
        logTraffic('[Network] Cellular signal restored (Good signal)', 'tx');
      } else {
        elements.signalIndicator.className = 'signal-indicator no-signal';
        logTraffic('[Network] Cellular signal lost (SIM error / No service)', 'err');
      }
    });

    elements.simAutoToggle.addEventListener('change', (e) => {
      appState.autoRespond = e.target.checked;
      logTraffic(`[Simulator] Auto-responder ${appState.autoRespond ? 'ENABLED (4s delay)' : 'DISABLED'}`, 'tx');
    });

    // Fast Action Buttons in Simulator
    elements.btnSimOk.addEventListener('click', () => {
      if (!appState.inFlight) {
        alert('Start a payment first so there is an active transaction in flight.');
        return;
      }
      receiveSms(`RES1-${appState.inFlight.uuid}-OK-${appState.inFlight.amount}`);
    });

    elements.btnSimCancel.addEventListener('click', () => {
      if (!appState.inFlight) {
        alert('Start a payment first so there is an active transaction in flight.');
        return;
      }
      receiveSms(`RES1-${appState.inFlight.uuid}-FAIL-CANCELLED`);
    });

    elements.btnSimTimeout.addEventListener('click', () => {
      if (!appState.inFlight) {
        alert('Start a payment first so there is an active transaction in flight.');
        return;
      }
      receiveSms(`RES1-${appState.inFlight.uuid}-FAIL-TIMEOUT`);
    });

    elements.btnSimInsufficient.addEventListener('click', () => {
      if (!appState.inFlight) {
        alert('Start a payment first so there is an active transaction in flight.');
        return;
      }
      receiveSms(`RES1-${appState.inFlight.uuid}-FAIL-INSUFFICIENT`);
    });

    // Key Demo Feature: Flip pre-seeded pending transaction
    elements.btnSimFlipPending.addEventListener('click', () => {
      logTraffic(`[Demo Trigger] Delivering late RES1 for pre-seeded transaction ${DEMO_PRESEEDED_UUID}...`, 'rx');
      receiveSms(`RES1-${DEMO_PRESEEDED_UUID}-OK-${DEMO_PRESEEDED_AMOUNT}`);
    });

    // Custom raw SMS
    elements.btnSimSendCustom.addEventListener('click', () => {
      const text = elements.simCustomSms.value.trim();
      if (!text) return;
      receiveSms(text);
      elements.simCustomSms.value = '';
    });
  }

  // ==========================================
  // INITIALIZATION
  // ==========================================

  function init() {
    loadSettings();
    ensurePreSeededDemoTransaction();
    updatePendingBadge();
    bindEvents();
    updateStatusBar();
    setInterval(updateStatusBar, 10000);

    // Initial state
    transitionTo(STATES.IDLE);

    logTraffic('[System] SMS2Pay Offline POS Client initialized.', 'tx');
    logTraffic(`[Config] Shortcode: ${appState.shortcode} | Ready to transmit PAY1 messages.`, 'tx');
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging if needed
  window.SMS2Pay = {
    appState,
    receiveSms,
    transitionTo
  };
})();
