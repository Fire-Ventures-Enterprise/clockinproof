// ── DARK / LIGHT MODE ────────────────────────────────────────────────────────
function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark')
  localStorage.setItem('cip_theme', isDark ? 'dark' : 'light')
  _updateWorkerThemeUI()
}
function _updateWorkerThemeUI() {
  const isDark = document.documentElement.classList.contains('dark')
  const icon  = document.getElementById('wk-theme-icon')
  const label = document.getElementById('wk-theme-label')
  const btn   = document.getElementById('wk-theme-btn')
  if (icon)  icon.className  = isDark ? 'fas fa-sun' : 'fas fa-moon'
  if (label) label.textContent = isDark ? 'Light Mode' : 'Dark Mode'
  if (btn)   btn.style.background = isDark ? '#1e293b' : '#f0f9ff'
  // Also update bottom nav bg
  const nav = document.getElementById('wk-bottom-nav')
  if (nav) {
    nav.style.background = isDark ? '#1e293b' : '#fff'
    nav.style.borderTopColor = isDark ? '#334155' : '#e5e7eb'
  }
}
document.addEventListener('DOMContentLoaded', _updateWorkerThemeUI)
// ─────────────────────────────────────────────────────────────────────────────

let currentWorker = null
let activeSession = null
let currentLat = null
let currentLng = null
let currentAddress = null
let map = null
let marker = null
let durationTimer = null
// Location bias for address search — populated from settings on initMain
let _searchCountry = 'ca'   // ISO 2-letter country code (lowercase)
let _searchCity    = ''     // city name for query boost
let _searchLat     = 45.42  // fallback lat (Ottawa centre)
let _searchLng     = -75.70 // fallback lng (Ottawa centre)
let pingInterval = null
let recentLocations = []
// GPS fraud override state
let pendingOverrideId = null
let overridePollTimer = null
let fraudMap = null
// Active dispatch assigned to this worker
let pendingDispatch = null

// ── Init ──────────────────────────────────────────────────────────────────────
window.onload = async () => {
  const saved = localStorage.getItem('wt_worker')
  recentLocations = JSON.parse(localStorage.getItem('wt_recent_locations') || '[]')
  if (saved) {
    // Even for returning workers (auto-login), consent must be confirmed on THIS device.
    // If they cleared storage or this is a new browser/device, show consent first.
    if (!hasDeviceConsent()) {
      showConsentModal(async () => {
        currentWorker = JSON.parse(saved)
        await initMain()
      })
    } else {
      currentWorker = JSON.parse(saved)
      await initMain()
    }
  } else {
    // Check if we arrived here from a join link (admin invited this worker)
    const joinPhone = localStorage.getItem('wt_join_phone')
    if (joinPhone) {
      // Admin-created worker → send them to LOGIN screen with phone pre-filled
      // They must enter their temp PIN (sent by SMS/email) then set a personal PIN
      showScreen('login')
      const lp = document.getElementById('login-phone')
      if (lp) lp.value = joinPhone
      // Clean up join hints (used once)
      localStorage.removeItem('wt_join_phone')
      localStorage.removeItem('wt_join_worker_id')
      // Show a friendly banner so they know what to do
      showToast('Enter your phone + the temporary PIN from your invite SMS/email.', 'info', 7000)
    } else {
      showScreen('register')
    }
  }
  getLocation()

  // Close map when user presses ESC
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const wrapper = document.getElementById('map-wrapper')
      if (wrapper && !wrapper.classList.contains('hidden')) closeMap()
    }
  })

  // Close map when screen locks / tab goes hidden (mobile screen lock)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const wrapper = document.getElementById('map-wrapper')
      if (wrapper && !wrapper.classList.contains('hidden')) closeMap()
    }
  })
}

function showScreen(name) {
  ['register','login','main'].forEach(s => {
    const el = document.getElementById('screen-' + s)
    el.style.display = 'none'
    el.classList.add('hidden')
  })
  const target = document.getElementById('screen-' + name)
  target.classList.remove('hidden')
  // screen-main needs flex layout for scroll to work correctly
  target.style.display = (name === 'main') ? 'flex' : 'block'
}
function showLogin() { showScreen('login') }
function showRegister() { showScreen('register') }

// ── Register ──────────────────────────────────────────────────────────────────
// ── Consent check: have they agreed to device ID collection on THIS device? ──
function hasDeviceConsent() {
  return localStorage.getItem('wt_device_consent') === '1'
}
function recordDeviceConsent() {
  localStorage.setItem('wt_device_consent', '1')
  localStorage.setItem('wt_device_consent_at', new Date().toISOString())
}

// ── Show the one-time device consent modal before first registration ──────────
function showConsentModal(onAccept) {
  // Only show once per device
  if (hasDeviceConsent()) { onAccept(); return }
  let m = document.getElementById('device-consent-modal')
  if (!m) {
    m = document.createElement('div')
    m.id = 'device-consent-modal'
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;z-index:9999;padding:16px'
    m.innerHTML = `
<div style="background:#fff;border-radius:20px 20px 12px 12px;max-width:420px;width:100%;padding:24px;box-shadow:0 -4px 32px rgba(0,0,0,.15)">
  <div style="text-align:center;margin-bottom:16px">
    <div style="width:48px;height:48px;background:#eff6ff;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px">
      <i class="fas fa-shield-alt" style="color:#2563eb;font-size:20px"></i>
    </div>
    <h3 style="font-size:17px;font-weight:700;color:#111;margin:0 0 6px">Device Verification</h3>
    <p style="font-size:13px;color:#4b5563;line-height:1.5;margin:0">To prevent time-clock fraud, ClockInProof links your clock-in activity to <strong>this specific phone</strong>.</p>
  </div>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:16px;font-size:12px;color:#374151;line-height:1.6">
    <p style="margin:0 0 8px;font-weight:600;color:#111">What we collect &amp; why:</p>
    <ul style="margin:0;padding-left:18px;space-y:4px">
      <li>A <strong>random device token</strong> generated by your browser — stored only on this phone</li>
      <li>This is <strong>not</strong> biometric data (no fingerprint, face, or body information)</li>
      <li>Used <strong>only</strong> to verify that clock-ins come from your registered device</li>
      <li>You can request a device reset from your manager at any time</li>
    </ul>
    <p style="margin:10px 0 0;font-size:11px;color:#6b7280">Collected under PIPEDA (Canada) and applicable US state privacy laws. Your employer is the data controller. See <a href="/privacy" style="color:#2563eb">Privacy Policy</a>.</p>
  </div>
  <button id="consent-accept-btn" onclick="acceptDeviceConsent()" style="width:100%;background:#2563eb;color:#fff;border:none;border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px">
    <i class="fas fa-check mr-2"></i>I Understand &amp; Agree
  </button>
  <button onclick="declineDeviceConsent()" style="width:100%;background:transparent;color:#6b7280;border:none;font-size:13px;cursor:pointer;padding:6px">
    Decline (you will not be able to use the app)
  </button>
</div>`
    document.body.appendChild(m)
  }
  window._consentCallback = onAccept
  m.style.display = 'flex'
}

function acceptDeviceConsent() {
  recordDeviceConsent()
  const m = document.getElementById('device-consent-modal')
  if (m) m.style.display = 'none'
  if (window._consentCallback) window._consentCallback()
}

function declineDeviceConsent() {
  showToast('Device verification is required to use ClockInProof.', 'error')
  const m = document.getElementById('device-consent-modal')
  if (m) m.style.display = 'none'
}

async function registerWorker() {
  // Show consent screen first if not yet given on this device
  if (!hasDeviceConsent()) { showConsentModal(registerWorker); return }

  const rawName = document.getElementById('reg-name').value.trim()
  const name = rawName.replace(/\b\w/g, c => c.toUpperCase())
  const phone = document.getElementById('reg-phone').value.trim()
  const pin = document.getElementById('reg-pin').value.trim()
  if (!name || !phone) { showToast('Please enter name and phone', 'error'); return }
  if (pin && (pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin))) { showToast('PIN must be 4–8 numeric digits', 'error'); return }
  const btn = document.getElementById('reg-btn')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Please wait...'
  try {
    const res = await fetch('/api/workers/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, pin: pin || '0000', device_id: getDeviceId(), consent_given: true, device_consent_at: new Date().toISOString() })
    })
    const data = await res.json()
    if (data.worker) {
      currentWorker = data.worker
      localStorage.setItem('wt_worker', JSON.stringify(data.worker))
      if (data.isNew === false) {
        // Already registered — switch to login so they use their PIN properly
        showToast('You\'re already registered! Please sign in with your PIN.', 'info', 5000)
        showScreen('login')
        const lp = document.getElementById('login-phone')
        if (lp) lp.value = phone
        return
      }
      // Brand new worker — if admin set a temp PIN → force PIN change
      if (data.worker.is_temp_pin) {
        showChangePinScreen(data.worker, true)
      } else {
        showToast('Registered! Welcome 🎉', 'success')
        await initMain()
      }
    } else if (data.error === 'device_mismatch') {
      showDeviceMismatchScreen(phone)
    } else if (data.error === 'duplicate_phone') {
      // Phone exists but no device — redirect to login
      showToast('Phone already registered. Please sign in instead.', 'info', 5000)
      showScreen('login')
      const lp = document.getElementById('login-phone')
      if (lp) lp.value = phone
    } else {
      showToast(data.message || data.error || 'Registration failed', 'error')
    }
  } catch(e) { showToast('Connection error', 'error') }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus mr-2"></i>Get Started'
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function loginWorker() {
  // Show consent screen first if not yet given on this device
  if (!hasDeviceConsent()) { showConsentModal(loginWorker); return }

  const phone = document.getElementById('login-phone').value.trim()
  const pin   = document.getElementById('login-pin').value.trim()
  if (!phone) { showToast('Enter your phone number', 'error'); return }
  if (!pin)   { showToast('Enter your PIN', 'error'); return }

  const btn = document.getElementById('login-btn')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Signing in...'
  try {
    const url = '/api/workers/lookup/' + encodeURIComponent(phone)
      + '?device_id=' + encodeURIComponent(getDeviceId())
      + '&pin=' + encodeURIComponent(pin)
    const res = await fetch(url)
    const data = await res.json()
    if (data.worker) {
      currentWorker = data.worker
      localStorage.setItem('wt_worker', JSON.stringify(data.worker))
      // If worker still has temp PIN → force them to set their own PIN now
      if (data.worker.is_temp_pin) {
        showChangePinScreen(data.worker, true)
      } else {
        showToast('Welcome back, ' + data.worker.name + '!', 'success')
        await initMain()
      }
    } else if (data.error === 'device_mismatch') {
      showDeviceMismatchScreen(phone)
    } else if (data.error === 'wrong_pin') {
      showToast('Incorrect PIN. Please try again.', 'error')
    } else {
      showToast(data.message || 'Worker not found. Please register first.', 'error')
    }
  } catch(e) { showToast('Connection error', 'error') }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>Sign In'
}

// ── Change PIN screen (forced on first login with temp PIN) ───────────────────
function showChangePinScreen(worker, isForced) {
  let m = document.getElementById('change-pin-modal')
  if (!m) {
    m = document.createElement('div')
    m.id = 'change-pin-modal'
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;z-index:9999;padding:16px'
    m.innerHTML = `
<div style="background:#fff;border-radius:20px 20px 12px 12px;max-width:420px;width:100%;padding:24px;box-shadow:0 -4px 32px rgba(0,0,0,.15)">
  <div style="text-align:center;margin-bottom:18px">
    <div style="width:48px;height:48px;background:#eff6ff;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px">
      <i class="fas fa-lock" style="color:#2563eb;font-size:20px"></i>
    </div>
    <h3 style="font-size:17px;font-weight:700;color:#111;margin:0 0 6px">Create Your PIN</h3>
    <p id="change-pin-subtitle" style="font-size:13px;color:#4b5563;margin:0">You were given a temporary PIN. Please create your own personal PIN now.</p>
  </div>
  <div style="margin-bottom:12px">
    <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:6px">New PIN (4–8 digits)</label>
    <input id="new-pin-input" type="password" inputmode="numeric" maxlength="8" placeholder="Create your PIN"
      style="width:100%;padding:12px;border:2px solid #e5e7eb;border-radius:10px;font-size:18px;text-align:center;letter-spacing:8px;box-sizing:border-box"/>
  </div>
  <div style="margin-bottom:18px">
    <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:6px">Confirm PIN</label>
    <input id="confirm-pin-input" type="password" inputmode="numeric" maxlength="8" placeholder="Repeat your PIN"
      style="width:100%;padding:12px;border:2px solid #e5e7eb;border-radius:10px;font-size:18px;text-align:center;letter-spacing:8px;box-sizing:border-box"/>
  </div>
  <button id="save-pin-btn" onclick="saveNewPin()"
    style="width:100%;background:#2563eb;color:#fff;border:none;border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer">
    <i class="fas fa-check mr-2"></i>Save My PIN
  </button>
</div>`
    document.body.appendChild(m)
  }
  if (!isForced) {
    document.getElementById('change-pin-subtitle').textContent = 'Enter a new PIN to update your login.'
  }
  m.style.display = 'flex'
  document.getElementById('new-pin-input').value = ''
  document.getElementById('confirm-pin-input').value = ''
}

async function saveNewPin() {
  const newPin     = document.getElementById('new-pin-input').value.trim()
  const confirmPin = document.getElementById('confirm-pin-input').value.trim()
  if (!newPin || newPin.length < 4 || newPin.length > 8 || !/^\d+$/.test(newPin)) {
    showToast('PIN must be 4–8 numeric digits', 'error'); return
  }
  if (newPin !== confirmPin) { showToast('PINs do not match', 'error'); return }

  const btn = document.getElementById('save-pin-btn')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>Saving...'
  try {
    const worker = JSON.parse(localStorage.getItem('wt_worker') || '{}')
    const res = await fetch('/api/workers/' + worker.id + '/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_pin: newPin })
    })
    const data = await res.json()
    if (data.success) {
      // Update local storage — mark pin as no longer temp
      worker.is_temp_pin = 0
      localStorage.setItem('wt_worker', JSON.stringify(worker))
      currentWorker = worker
      // Close modal
      const m = document.getElementById('change-pin-modal')
      if (m) m.style.display = 'none'
      showToast('✅ PIN saved! Welcome, ' + worker.name + '!', 'success')
      await initMain()
    } else {
      showToast(data.message || 'Could not save PIN', 'error')
    }
  } catch(e) { showToast('Connection error', 'error') }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-check mr-2"></i>Save My PIN'
}

// ── Forgot PIN flow ──────────────────────────────────────────────────────────
function showForgotPin() {
  let m = document.getElementById('forgot-pin-modal')
  if (!m) {
    m = document.createElement('div')
    m.id = 'forgot-pin-modal'
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;z-index:9999;padding:16px'
    m.innerHTML = `
<div style="background:#fff;border-radius:20px 20px 12px 12px;max-width:420px;width:100%;padding:24px;box-shadow:0 -4px 32px rgba(0,0,0,.15)">
  <div style="text-align:center;margin-bottom:18px">
    <div style="width:48px;height:48px;background:#fef3c7;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px">
      <i class="fas fa-key" style="color:#d97706;font-size:20px"></i>
    </div>
    <h3 style="font-size:17px;font-weight:700;color:#111;margin:0 0 6px">Forgot Your PIN?</h3>
    <p style="font-size:13px;color:#4b5563;margin:0;line-height:1.5">Enter your phone number and we'll email you a temporary PIN to get back in.</p>
  </div>
  <div style="margin-bottom:16px">
    <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:6px">Phone Number</label>
    <input id="forgot-pin-phone" type="tel" placeholder="+1 234 567 8900" inputmode="tel"
      style="width:100%;padding:12px 14px;border:2px solid #e5e7eb;border-radius:10px;font-size:15px;box-sizing:border-box;outline:none"
      onfocus="this.style.borderColor='#6366f1'" onblur="this.style.borderColor='#e5e7eb'"/>
  </div>
  <div id="forgot-pin-msg" style="display:none;margin-bottom:12px;padding:12px;border-radius:10px;font-size:13px;line-height:1.5"></div>
  <button id="forgot-pin-btn" onclick="submitForgotPin()"
    style="width:100%;background:#4f46e5;color:#fff;border:none;border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px">
    <i class="fas fa-paper-plane mr-2"></i>Send Reset PIN
  </button>
  <button onclick="document.getElementById('forgot-pin-modal').style.display='none'"
    style="width:100%;background:transparent;color:#6b7280;border:none;font-size:13px;cursor:pointer;padding:6px">
    Cancel
  </button>
</div>`
    document.body.appendChild(m)
  }
  // Reset state
  document.getElementById('forgot-pin-phone').value = ''
  document.getElementById('forgot-pin-msg').style.display = 'none'
  document.getElementById('forgot-pin-btn').disabled = false
  document.getElementById('forgot-pin-btn').innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Send Reset PIN'
  m.style.display = 'flex'
  setTimeout(() => document.getElementById('forgot-pin-phone').focus(), 100)
}

async function submitForgotPin() {
  const phone = document.getElementById('forgot-pin-phone').value.trim()
  if (!phone) { showToast('Please enter your phone number', 'error'); return }

  const btn = document.getElementById('forgot-pin-btn')
  const msg = document.getElementById('forgot-pin-msg')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>Sending...'
  msg.style.display = 'none'

  try {
    const res = await fetch('/api/workers/forgot-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    })
    const data = await res.json()

    if (data.error === 'no_email') {
      msg.style.cssText = 'display:block;margin-bottom:12px;padding:12px;border-radius:10px;font-size:13px;line-height:1.5;background:#fef2f2;border:1px solid #fecaca;color:#991b1b'
      msg.innerHTML = '<i class="fas fa-exclamation-circle mr-1"></i>' + data.message
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Send Reset PIN'
    } else {
      // Success — show confirmation and close after delay
      msg.style.cssText = 'display:block;margin-bottom:12px;padding:12px;border-radius:10px;font-size:13px;line-height:1.5;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534'
      msg.innerHTML = '<i class="fas fa-check-circle mr-1"></i>Check your email! A temporary PIN has been sent. Use it to log in, then you will be prompted to set a new PIN.'
      btn.innerHTML = '<i class="fas fa-check mr-2"></i>Email Sent!'
      // Auto-close after 4 seconds
      setTimeout(() => {
        const m = document.getElementById('forgot-pin-modal')
        if (m) m.style.display = 'none'
        // Pre-fill phone in login screen
        const loginPhone = document.getElementById('login-phone')
        if (loginPhone) loginPhone.value = phone
        showScreen('login')
        document.getElementById('login-pin').focus()
      }, 4000)
    }
  } catch(e) {
    msg.style.cssText = 'display:block;margin-bottom:12px;padding:12px;border-radius:10px;font-size:13px;line-height:1.5;background:#fef2f2;border:1px solid #fecaca;color:#991b1b'
    msg.innerHTML = '<i class="fas fa-exclamation-circle mr-1"></i>Connection error. Please try again.'
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Send Reset PIN'
  }
}

// ── Device Mismatch: new-phone request screen ─────────────────────────────────
function showDeviceMismatchScreen(phone) {
  let m = document.getElementById('new-phone-modal')
  if (!m) {
    m = document.createElement('div')
    m.id = 'new-phone-modal'
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end;justify-content:center;z-index:9999;padding:16px'
    document.body.appendChild(m)
  }
  m.innerHTML = `
<div style="background:#fff;border-radius:20px 20px 12px 12px;max-width:420px;width:100%;padding:24px;box-shadow:0 -4px 32px rgba(0,0,0,.15)">
  <div style="text-align:center;margin-bottom:16px">
    <div style="width:48px;height:48px;background:#fef9c3;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px">
      <i class="fas fa-mobile-alt" style="color:#b45309;font-size:20px"></i>
    </div>
    <h3 style="font-size:17px;font-weight:700;color:#111;margin:0 0 6px">New Phone Detected</h3>
    <p style="font-size:13px;color:#4b5563;line-height:1.5;margin:0">This phone number is registered to a <strong>different device</strong>. For security, your manager must approve a device reset before you can clock in.</p>
  </div>
  <div style="margin-bottom:14px">
    <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Reason (optional)</label>
    <input id="new-phone-reason" type="text" placeholder="e.g. Got a new phone, old phone broken..." maxlength="100"
      style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;font-size:14px;box-sizing:border-box"/>
  </div>
  <button onclick="submitDeviceResetRequest('${phone}')" id="new-phone-submit-btn"
    style="width:100%;background:#2563eb;color:#fff;border:none;border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px">
    <i class="fas fa-paper-plane mr-2"></i>Request Device Reset
  </button>
  <button onclick="document.getElementById('new-phone-modal').style.display='none'" style="width:100%;background:transparent;color:#6b7280;border:none;font-size:13px;cursor:pointer;padding:6px">
    Cancel
  </button>
</div>`
  m.style.display = 'flex'
}

async function submitDeviceResetRequest(phone) {
  // We need the worker_id — do a basic phone lookup without device check
  const reason = (document.getElementById('new-phone-reason')?.value || '').trim() || 'New phone'
  const btn = document.getElementById('new-phone-submit-btn')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Sending...'
  try {
    // Look up worker by phone to get their ID (no device check on this route)
    const lookupRes = await fetch('/api/workers/lookup/' + encodeURIComponent(phone))
    const lookupData = await lookupRes.json()
    const workerId = lookupData.worker?.id || (lookupData.error === 'device_mismatch' ? null : null)

    // Use a special no-device-check lookup endpoint
    const res = await fetch('/api/device-reset-request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, reason })
    })
    const data = await res.json()
    if (data.success) {
      document.getElementById('new-phone-modal').innerHTML = `
<div style="background:#fff;border-radius:20px;max-width:420px;width:100%;padding:32px;text-align:center">
  <div style="width:56px;height:56px;background:#dcfce7;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:14px">
    <i class="fas fa-check" style="color:#16a34a;font-size:24px"></i>
  </div>
  <h3 style="font-size:18px;font-weight:700;color:#111;margin:0 0 8px">Request Sent!</h3>
  <p style="font-size:14px;color:#4b5563;line-height:1.6;margin:0 0 20px">Your manager has been notified. Once they approve, you can sign in on this phone.</p>
  <button onclick="document.getElementById('new-phone-modal').style.display='none'" style="background:#2563eb;color:#fff;border:none;border-radius:10px;padding:12px 28px;font-size:14px;font-weight:700;cursor:pointer">OK</button>
</div>`
    } else {
      showToast(data.message || data.error || 'Failed to send request', 'error')
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Request Device Reset'
    }
  } catch(e) {
    showToast('Connection error', 'error')
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Request Device Reset'
  }
}

function logout() {
  localStorage.removeItem('wt_worker')
  currentWorker = null; activeSession = null
  clearInterval(durationTimer); clearInterval(pingInterval)
  stopWatchdog(); hideAllBanners()
  showScreen('register')
}

// ── Main Init ─────────────────────────────────────────────────────────────────
async function initMain() {
  showScreen('main')
  document.getElementById('worker-name-display').textContent = currentWorker.name
  document.getElementById('worker-phone-display').textContent = currentWorker.phone
  document.getElementById('worker-rate-display').textContent = '$' + (currentWorker.hourly_rate || 0).toFixed(2) + '/hr'
  // Load settings for address-search location bias (country + city)
  try {
    const sr = await fetch('/api/settings')
    const sd = await sr.json()
    const ss = sd.settings || {}
    if (ss.country_code) _searchCountry = ss.country_code.toLowerCase()
    if (ss.city)         _searchCity    = ss.city
  } catch(_) {}
  // Load a known job-site lat/lng as search anchor (more precise than city centre)
  try {
    const jr = await fetch('/api/job-sites')
    const jd = await jr.json()
    const sites = jd.sites || []
    if (sites.length > 0 && sites[0].lat) {
      _searchLat = parseFloat(sites[0].lat)
      _searchLng = parseFloat(sites[0].lng)
    }
  } catch(_) {}
  // Fetch pending dispatch for this worker — used to pre-fill job modal
  await checkPendingDispatch()
  await checkStatus()
  await loadStats()
  await loadWorkLog()
  // Refresh dispatch badge count silently in background
  refreshDispatchBadge()
}

async function refreshDispatchBadge() {
  if (!currentWorker?.id) return
  try {
    const res  = await fetch('/api/dispatch/worker/' + currentWorker.id)
    const data = await res.json()
    const dispatches = data.dispatches || []
    const pending = dispatches.filter(d => ['sent','replied'].includes(d.status))
    const badgeEl = document.getElementById('wk-dispatch-badge')
    if (badgeEl) {
      if (pending.length > 0) {
        badgeEl.style.display = 'inline-block'
        badgeEl.textContent   = pending.length
      } else {
        badgeEl.style.display = 'none'
      }
    }
  } catch(_) {}
}

// ── Pending Dispatch ──────────────────────────────────────────────────────────
async function checkPendingDispatch() {
  if (!currentWorker?.id) return
  try {
    const res = await fetch('/api/dispatch/pending/' + currentWorker.id)
    const data = await res.json()
    pendingDispatch = data.dispatch || null
    renderDispatchBanner()
  } catch(_) {
    pendingDispatch = null
  }
}

function renderDispatchBanner() {
  // Remove any existing banner
  const existing = document.getElementById('dispatch-alert-banner')
  if (existing) existing.remove()

  if (!pendingDispatch || activeSession) return   // hide when clocked in

  const banner = document.createElement('div')
  banner.id = 'dispatch-alert-banner'
  banner.className = 'mx-4 mb-4 flex items-start gap-3 bg-blue-50 border-2 border-blue-400 rounded-2xl p-4 shadow-sm cursor-pointer'
  banner.onclick = () => openJobModal()
  banner.innerHTML = `
    <span class="text-3xl mt-0.5">📋</span>
    <div class="flex-1 min-w-0">
      <p class="font-bold text-blue-900 text-sm">Job Assigned to You</p>
      <p class="text-blue-800 font-semibold truncate mt-0.5">${escHtml(pendingDispatch.job_name)}</p>
      <p class="text-blue-600 text-xs truncate mt-0.5">📍 ${escHtml(pendingDispatch.job_address)}</p>
      ${pendingDispatch.notes ? `<p class="text-blue-500 text-xs mt-0.5 italic truncate">📝 ${escHtml(pendingDispatch.notes)}</p>` : ''}
      <p class="text-blue-400 text-xs mt-1">Tap Clock In — your job is pre-selected ✓</p>
    </div>
    <a href="${pendingDispatch.maps_url}" target="_blank" onclick="event.stopPropagation()"
       class="flex-shrink-0 bg-blue-600 text-white text-xs font-semibold rounded-lg px-3 py-2 hover:bg-blue-700">
       <i class="fas fa-directions mr-1"></i>Directions
    </a>
  `

  // Insert the banner just before the clock button area (after status row)
  const clockBtn = document.getElementById('clock-btn')
  if (clockBtn && clockBtn.parentNode) {
    clockBtn.parentNode.insertBefore(banner, clockBtn)
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

async function checkStatus() {
  try {
    const res = await fetch('/api/sessions/status/' + currentWorker.id)
    const data = await res.json()
    activeSession = data.active_session
    if (data.is_clocked_in && activeSession) {
      setClockedInUI(true)
      startDurationTimer()
      startPingInterval()
      startWatchdog()
    } else {
      setClockedInUI(false)
    }
  } catch(e) { console.error(e) }
}

function setClockedInUI(isClockedIn) {
  const btn = document.getElementById('clock-btn')
  const dot = document.getElementById('status-dot')
  const txt = document.getElementById('status-text')
  const icon = document.getElementById('clock-btn-icon')
  const btnTxt = document.getElementById('clock-btn-text')
  const info = document.getElementById('clock-in-info')
  const jobBanner = document.getElementById('active-job-banner')

  if (!isClockedIn) closeMap()  // always close map when not clocked in

  if (isClockedIn) {
    // Hide dispatch banner while worker is clocked in
    const db = document.getElementById('dispatch-alert-banner')
    if (db) db.remove()
    btn.className = 'w-full py-5 rounded-2xl text-white text-xl font-bold shadow-lg clock-btn flex items-center justify-center gap-3 bg-red-500 hover:bg-red-600'
    dot.className = 'w-3 h-3 rounded-full bg-green-500 pulse'
    txt.textContent = 'Currently Working'
    txt.className = 'font-semibold text-green-600'
    icon.className = 'fas fa-stop-circle text-2xl'
    btnTxt.textContent = 'Clock Out'
    info.classList.remove('hidden')
    if (activeSession) {
      const t = new Date(activeSession.clock_in_time)
      document.getElementById('session-start-time').textContent = t.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
      // Show job banner
      if (activeSession.job_location) {
        jobBanner.classList.remove('hidden')
        document.getElementById('active-job-location').textContent = '📍 ' + activeSession.job_location
        document.getElementById('active-job-desc').textContent = activeSession.job_description || ''
      }
    }
  } else {
    btn.className = 'w-full py-5 rounded-2xl text-white text-xl font-bold shadow-lg clock-btn flex items-center justify-center gap-3 bg-green-500 hover:bg-green-600'
    dot.className = 'w-3 h-3 rounded-full bg-gray-300'
    txt.textContent = 'Not Clocked In'
    txt.className = 'font-semibold text-gray-700'
    icon.className = 'fas fa-play-circle text-2xl'
    btnTxt.textContent = 'Clock In'
    info.classList.add('hidden')
    jobBanner.classList.add('hidden')
    clearInterval(durationTimer)
    clearInterval(pingInterval)
    // Re-show dispatch banner if there's still a pending dispatch
    renderDispatchBanner()
  }
}

// ── Clock Button Handler ───────────────────────────────────────────────────────
function handleClockBtn() {
  if (!activeSession) {
    openJobModal()           // Show job details form before clocking in
  } else {
    openClockoutConfirm()    // Show confirmation before clocking out
  }
}

// ── Clock-Out Confirmation Modal ──────────────────────────────────────────────
function openClockoutConfirm() {
  const modal = document.getElementById('clockout-confirm-modal')
  if (!modal) { _doClockOut(); return }   // fallback if modal missing

  // Build summary panel
  const infoEl = document.getElementById('co-confirm-info')
  if (infoEl && activeSession) {
    const clockInMs  = new Date(activeSession.clock_in_time).getTime()
    const hoursWorked = ((Date.now() - clockInMs) / 3600000)
    const earned      = (hoursWorked * (currentWorker?.hourly_rate || 0)).toFixed(2)
    const hrsText     = `${Math.floor(hoursWorked)}h ${Math.round((hoursWorked % 1) * 60)}m`
    const clockInStr  = new Date(activeSession.clock_in_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
    infoEl.innerHTML = `
      <div class="flex justify-between text-sm">
        <span class="text-gray-500"><i class="fas fa-sign-in-alt text-green-500 mr-1.5"></i>Clocked In</span>
        <span class="font-semibold text-gray-800">${clockInStr}</span>
      </div>
      <div class="flex justify-between text-sm">
        <span class="text-gray-500"><i class="fas fa-clock text-yellow-500 mr-1.5"></i>Time Worked</span>
        <span class="font-bold text-yellow-700">${hrsText}</span>
      </div>
      <div class="flex justify-between text-sm">
        <span class="text-gray-500"><i class="fas fa-dollar-sign text-green-500 mr-1.5"></i>Est. Earnings</span>
        <span class="font-bold text-green-700">$${earned}</span>
      </div>
      ${activeSession.job_location ? `
      <div class="flex justify-between text-sm">
        <span class="text-gray-500"><i class="fas fa-map-marker-alt text-red-400 mr-1.5"></i>Job Site</span>
        <span class="font-medium text-gray-700 text-right max-w-[55%] truncate">${activeSession.job_location}</span>
      </div>` : ''}
    `
  }

  // Reset confirm button state
  const btn = document.getElementById('co-confirm-btn')
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-stop-circle mr-2"></i>Yes, Clock Out' }

  modal.classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function cancelClockoutConfirm() {
  const modal = document.getElementById('clockout-confirm-modal')
  if (modal) modal.classList.add('hidden')
  document.body.style.overflow = ''
}

async function doConfirmClockout() {
  const btn = document.getElementById('co-confirm-btn')
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Clocking Out...' }
  cancelClockoutConfirm()
  await _doClockOut()
}

// ── Job Details Modal ─────────────────────────────────────────────────────────
function openJobModal() {
  const modal = document.getElementById('job-modal')
  modal.classList.remove('hidden')
  // Reset session type to regular on every open
  modal.dataset.sessionType = 'regular'
  modal.dataset.jobSiteId = ''
  hideSessionTypeBanner()
  document.getElementById('job-location-input').value = ''
  document.getElementById('job-location-input').placeholder = 'Start typing an address...'
  document.getElementById('job-description-input').value = ''
  document.getElementById('location-suggestions').classList.add('hidden')
  // Reset dropdown
  const sel = document.getElementById('saved-sites-select')
  if (sel) sel.value = ''
  // Update GPS status in modal
  const gpsEl = document.getElementById('modal-gps-status')
  if (gpsEl) {
    gpsEl.textContent = currentLat
      ? `✓ Location ready (±${currentLat.toFixed(3)}...)`
      : 'Getting location...'
  }
  // Pre-fill with most recent location only if no special type active
  if (recentLocations.length > 0) {
    document.getElementById('job-location-input').value = recentLocations[0]
  }
  // Load saved job sites from admin, then auto-apply pending dispatch
  loadSavedSitesDropdown(true)
  setTimeout(() => document.getElementById('job-location-input').focus(), 300)
}

async function loadSavedSitesDropdown(applyDispatch = false) {
  try {
    const res  = await fetch('/api/job-sites')
    const data = await res.json()
    const sites = data.sites || []
    const row = document.getElementById('saved-sites-row')
    const sel = document.getElementById('saved-sites-select')
    if (!row || !sel) return

    // Always show the dropdown — special activity types are always available
    sel.innerHTML = '<option value="">📍 Pick a saved job site or activity...</option>' +
      '<optgroup label="─── Off-Site Activities ───">' +
      '<option value="__material_pickup__">📦 Material Pickup (Home Depot, supplier, etc.)</option>' +
      '<option value="__emergency_job__">🚨 Emergency Job (urgent call-out to another site)</option>' +
      '</optgroup>' +
      (sites.length > 0
        ? '<optgroup label="─── Job Sites ───">' +
          sites.map(s => {
            // Strip [Encircle] prefix for clean display
            const displayName = s.name.replace(/^\[Encircle\]\s*/i, '').trim()
            // Show city only (first two parts of address) to keep option short
            const addrParts = (s.address || '').split(',')
            const shortAddr = addrParts.slice(0, 2).join(',').trim()
            // Highlight dispatched job
            const isDispatched = pendingDispatch && (
              s.id == pendingDispatch.matched_site_id ||
              (s.address && pendingDispatch.job_address &&
               s.address.trim().toLowerCase() === pendingDispatch.job_address.trim().toLowerCase())
            )
            const prefix = isDispatched ? '🔔 ASSIGNED · ' : ''
            return '<option value="' + s.address + '" data-site-id="' + s.id + '">' + prefix + displayName + '  ·  ' + shortAddr + '</option>'
          }).join('') +
          '</optgroup>'
        : '')
    row.classList.remove('hidden')

    // Auto-select and apply the dispatched job if requested
    if (applyDispatch && pendingDispatch) {
      // Try to find the matching option by address
      let matchedOption = null
      for (const opt of sel.options) {
        if (!opt.value || opt.value.startsWith('__')) continue
        if (opt.value.trim().toLowerCase() === pendingDispatch.job_address.trim().toLowerCase()) {
          matchedOption = opt
          break
        }
      }
      if (matchedOption) {
        sel.value = matchedOption.value
        // Apply it
        pickSavedSite(matchedOption.value)
        // Pre-fill notes / description from dispatch
        if (pendingDispatch.notes) {
          const descInput = document.getElementById('job-description-input')
          if (descInput && !descInput.value.trim()) descInput.value = pendingDispatch.notes
        }
        // Show dispatch pre-fill banner inside modal
        showDispatchPrefilledBanner(pendingDispatch)
      } else {
        // No exact match in saved sites — fill address directly
        document.getElementById('job-location-input').value = pendingDispatch.job_address
        document.getElementById('job-location-input').placeholder = pendingDispatch.job_address
        if (pendingDispatch.notes) {
          const descInput = document.getElementById('job-description-input')
          if (descInput && !descInput.value.trim()) descInput.value = pendingDispatch.notes
        }
        showDispatchPrefilledBanner(pendingDispatch)
      }
    }
  } catch(_) {}
}

function showDispatchPrefilledBanner(dispatch) {
  // Remove any old pre-fill banner
  const old = document.getElementById('dispatch-prefill-banner')
  if (old) old.remove()

  const banner = document.createElement('div')
  banner.id = 'dispatch-prefill-banner'
  banner.className = 'mb-4 flex items-start gap-3 bg-blue-50 border border-blue-300 rounded-xl p-3'
  banner.innerHTML = `
    <span class="text-xl">📋</span>
    <div class="min-w-0">
      <p class="font-bold text-blue-900 text-xs uppercase tracking-wide">Dispatched Job Pre-Filled</p>
      <p class="text-blue-800 text-sm font-semibold truncate mt-0.5">${escHtml(dispatch.job_name)}</p>
      <p class="text-blue-600 text-xs truncate mt-0.5">📍 ${escHtml(dispatch.job_address)}</p>
    </div>
  `

  // Insert at top of modal body (before the first label)
  const firstLabel = document.querySelector('#job-modal label')
  if (firstLabel && firstLabel.parentNode) {
    firstLabel.parentNode.insertBefore(banner, firstLabel)
  }
}

function pickSavedSite(value) {
  if (!value) return
  const locInput = document.getElementById('job-location-input')
  const descInput = document.getElementById('job-description-input')

  if (value === '__material_pickup__') {
    // Special: Material Pickup — worker is going off-site to get supplies
    locInput.value = ''
    locInput.placeholder = 'Where are you picking up? (e.g. Home Depot, 123 Main St)'
    locInput.focus()
    // Pre-fill description if empty
    if (!descInput.value.trim()) descInput.value = 'Material pickup'
    // Tag the session type on the modal so it gets sent at clock-in
    document.getElementById('job-modal').dataset.sessionType = 'material_pickup'
    // Show info banner
    showSessionTypeBanner('material_pickup')
    return
  }

  if (value === '__emergency_job__') {
    // Special: Emergency Job — urgent call-out to another site
    locInput.value = ''
    locInput.placeholder = 'Where is the emergency job? (address or description)'
    locInput.focus()
    if (!descInput.value.trim()) descInput.value = 'Emergency job call-out'
    document.getElementById('job-modal').dataset.sessionType = 'emergency_job'
    showSessionTypeBanner('emergency_job')
    return
  }

  // Normal saved site — fill address AND store site id for GPS check
  locInput.value = value
  locInput.placeholder = 'Start typing an address...'
  document.getElementById('location-suggestions').classList.add('hidden')
  document.getElementById('job-modal').dataset.sessionType = 'regular'
  // Store the site id so backend can verify GPS against exact coordinates
  const sel = document.getElementById('saved-sites-select')
  const selectedOption = sel ? sel.options[sel.selectedIndex] : null
  document.getElementById('job-modal').dataset.jobSiteId = selectedOption ? (selectedOption.dataset.siteId || '') : ''
  hideSessionTypeBanner()
}

function showSessionTypeBanner(type) {
  let banner = document.getElementById('session-type-banner')
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'session-type-banner'
    const locationLabel = document.querySelector('#job-modal label')
    locationLabel.parentNode.insertBefore(banner, locationLabel)
  }
  if (type === 'material_pickup') {
    banner.className = 'mb-4 flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-3'
    banner.innerHTML = '<span class="text-2xl">📦</span><div><p class="font-semibold text-amber-800 text-sm">Material Pickup</p><p class="text-xs text-amber-600 mt-0.5">Geofence check is <strong>bypassed</strong>. Your manager will see you are off-site for pickups. Enter the destination below.</p></div>'
  } else if (type === 'emergency_job') {
    banner.className = 'mb-4 flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-3'
    banner.innerHTML = '<span class="text-2xl">🚨</span><div><p class="font-semibold text-red-800 text-sm">Emergency Job</p><p class="text-xs text-red-600 mt-0.5">Geofence check is <strong>bypassed</strong>. Your manager is notified you have been called to an emergency job. Enter the location below.</p></div>'
  }
  banner.classList.remove('hidden')
}

function hideSessionTypeBanner() {
  const banner = document.getElementById('session-type-banner')
  if (banner) banner.classList.add('hidden')
}

function closeJobModal() {
  document.getElementById('job-modal').classList.add('hidden')
  // Clean up dispatch pre-fill banner for next open
  const b = document.getElementById('dispatch-prefill-banner')
  if (b) b.remove()
}

// Close modal on backdrop click
document.getElementById('job-modal').addEventListener('click', function(e) {
  if (e.target === this) closeJobModal()
})

function addChip(task) {
  const el = document.getElementById('job-description-input')
  const current = el.value.trim()
  if (current) {
    el.value = current.endsWith(',') ? current + ' ' + task : current + ', ' + task
  } else {
    el.value = task
  }
  el.focus()
}

// ── Address Autocomplete (Nominatim) ─────────────────────────────────────────
let acTimer = null   // debounce handle

async function fetchAddressSuggestions(query) {
  if (!query || query.length < 3) return []
  try {
    // Use Photon (komoot) — typo-tolerant, free, fast
    // lat/lon bias: use worker GPS if available, else nearest job site, else city centre
    const lat = currentLat  || _searchLat
    const lng = currentLng  || _searchLng

    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=7&lang=en&lat=${lat}&lon=${lng}`
    const res  = await fetch(url)
    const data = await res.json()

    return (data.features || []).map(f => {
      const p = f.properties
      const coords = f.geometry?.coordinates || []
      // Build a clean short address: house# + street + city + province + postal
      const short = [
        p.housenumber, p.street || p.name,
        p.district || p.locality,
        p.city || p.town || p.village,
        p.state,
        p.postcode
      ].filter(Boolean).join(', ')
      return {
        display: short,
        short,
        lat: coords[1] || 0,
        lng: coords[0] || 0
      }
    }).filter(r => r.short.length > 0)
  } catch(_) { return [] }
}

function renderSuggestions(suggestions, inputId, boxId, onSelect) {
  const box = document.getElementById(boxId)
  if (!box) return
  if (!suggestions || suggestions.length === 0) { box.classList.add('hidden'); return }
  box.innerHTML = suggestions.map((s, i) => `
    <button data-idx="${i}"
      class="w-full text-left px-4 py-3 hover:bg-blue-50 text-sm text-gray-700 border-b border-gray-100 last:border-0 flex items-start gap-3"
      onmousedown="event.preventDefault()"
      onclick="(function(){ ${onSelect}('${s.short.replace(/'/g,"\\\\'").replace(/"/g,'&quot;')}'); })()">
      <i class="fas fa-map-marker-alt text-red-400 mt-0.5 flex-shrink-0 text-xs"></i>
      <span>${s.short}</span>
    </button>
  `).join('')
  box.classList.remove('hidden')
}

// Worker clock-in: replace old local-filter with live Nominatim lookup
function filterLocationSuggestions(val) {
  const box = document.getElementById('location-suggestions')
  clearTimeout(acTimer)
  if (!val || val.length < 3) {
    // Fall back to recent locations while typing short strings
    if (recentLocations.length > 0 && val.length > 0) {
      const filtered = recentLocations.filter(l => l.toLowerCase().includes(val.toLowerCase()))
      if (filtered.length > 0) {
        box.innerHTML = filtered.slice(0, 5).map(l => `
          <button class="w-full text-left px-4 py-3 hover:bg-blue-50 text-sm text-gray-700 border-b border-gray-100 last:border-0 flex items-center gap-3"
            onmousedown="event.preventDefault()"
            onclick="selectLocation('${l.replace(/'/g,"\\\\'").replace(/"/g,'&quot;')}')">
            <i class="fas fa-history text-gray-400 text-xs flex-shrink-0"></i><span>${l}</span>
          </button>
        `).join('')
        box.classList.remove('hidden')
        return
      }
    }
    box.classList.add('hidden')
    return
  }
  // Show loading state
  box.innerHTML = '<div class="px-4 py-3 text-xs text-gray-400"><i class="fas fa-circle-notch fa-spin mr-2"></i>Searching addresses...</div>'
  box.classList.remove('hidden')
  acTimer = setTimeout(async () => {
    const suggestions = await fetchAddressSuggestions(val)
    if (suggestions.length === 0 && recentLocations.length > 0) {
      const filtered = recentLocations.filter(l => l.toLowerCase().includes(val.toLowerCase()))
      if (filtered.length > 0) {
        box.innerHTML = filtered.slice(0, 5).map(l => `
          <button class="w-full text-left px-4 py-3 hover:bg-blue-50 text-sm text-gray-700 border-b border-gray-100 last:border-0 flex items-center gap-3"
            onmousedown="event.preventDefault()"
            onclick="selectLocation('${l.replace(/'/g,"\\\\'").replace(/"/g,'&quot;')}')">
            <i class="fas fa-history text-gray-400 text-xs flex-shrink-0"></i><span>${l}</span>
          </button>
        `).join('')
        box.classList.remove('hidden')
        return
      }
    }
    renderSuggestions(suggestions, 'job-location-input', 'location-suggestions', 'selectLocation')
  }, 350)
}

function selectLocation(loc) {
  document.getElementById('job-location-input').value = loc
  document.getElementById('location-suggestions').classList.add('hidden')
}

async function confirmClockIn() {
  const jobLocation = document.getElementById('job-location-input').value.trim()
  const jobDescription = document.getElementById('job-description-input').value.trim()
  // Read session type set by pickSavedSite (default: regular)
  const sessionType = document.getElementById('job-modal').dataset.sessionType || 'regular'

  if (!jobLocation) { showToast('Please enter the job location', 'error'); document.getElementById('job-location-input').focus(); return }
  if (!jobDescription) { showToast('Please describe what you are doing', 'error'); document.getElementById('job-description-input').focus(); return }

  const btn = document.getElementById('confirm-clock-in-btn')
  btn.disabled = true
  if (sessionType === 'material_pickup') {
    btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Starting material pickup...'
  } else if (sessionType === 'emergency_job') {
    btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Starting emergency job...'
  } else {
    btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Verifying location...'
  }

  try {
    const res = await fetch('/api/sessions/clock-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker_id: currentWorker.id,
        latitude: currentLat,
        longitude: currentLng,
        address: currentAddress,
        job_location: jobLocation,
        job_description: jobDescription,
        session_type: sessionType,
        device_id: getDeviceId(),
        job_site_id: document.getElementById('job-modal').dataset.jobSiteId || null
      })
    })
    const data = await res.json()

    // ── GPS FRAUD BLOCKED ─────────────────────────────────────────────────────
    if (res.status === 403 && data.error === 'location_mismatch') {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-play-circle mr-2"></i>Start Working'
      closeJobModal()
      showFraudBlockedModal(data)
      return
    }

    // ── NORMAL SUCCESS ────────────────────────────────────────────────────────
    if (data.session) {
      activeSession = data.session
      // Save location to recent list
      if (!recentLocations.includes(jobLocation)) {
        recentLocations.unshift(jobLocation)
        recentLocations = recentLocations.slice(0, 10)
        localStorage.setItem('wt_recent_locations', JSON.stringify(recentLocations))
      }
      closeJobModal()
      setClockedInUI(true)
      startDurationTimer()
      startPingInterval()
      startWatchdog()
      showToast('Clocked in! Have a great shift \u{1F4AA}', 'success')
      await loadStats()
      await loadWorkLog()
    } else {
      showToast(data.error || 'Failed to clock in', 'error')
    }
  } catch(e) { showToast('Connection error', 'error') }

  btn.disabled = false; btn.innerHTML = '<i class="fas fa-play-circle mr-2"></i>Start Working'
}

// ── Fraud Blocked Modal ────────────────────────────────────────────────────────
function showFraudBlockedModal(data) {
  pendingOverrideId = data.request_id || null

  // Populate distance message
  const distKm = parseFloat(data.distance_km || 0)
  const distM  = parseInt(data.distance_meters || 0)
  const radius = parseInt(data.geofence_radius_meters || 300)
  document.getElementById('fraud-distance-msg').textContent =
    'You are ' + (distM >= 1000 ? distKm + ' km' : distM + ' m') + ' from the job site. Required: within ' + radius + ' m.'

  // Your location label
  const yourLoc = data.worker_location
  document.getElementById('fraud-your-loc').textContent =
    yourLoc && yourLoc.address ? yourLoc.address.substring(0, 60) + '...' :
    (yourLoc ? yourLoc.lat.toFixed(5) + ', ' + yourLoc.lng.toFixed(5) : 'Unknown')

  // Job site label
  const jobLoc = data.job_location_coords
  document.getElementById('fraud-job-loc').textContent =
    jobLoc && jobLoc.address ? jobLoc.address.substring(0, 60) + '...' :
    (jobLoc ? jobLoc.lat.toFixed(5) + ', ' + jobLoc.lng.toFixed(5) : 'Unknown')

  // Show initial "request sent" panel, hide pending
  document.getElementById('fraud-request-sent').classList.remove('hidden')
  document.getElementById('fraud-pending').classList.add('hidden')
  document.getElementById('fraud-wait-btn').classList.remove('hidden')

  // Show modal
  document.getElementById('fraud-blocked-modal').classList.remove('hidden')

  // Draw map with two markers after a tick
  setTimeout(() => {
    if (fraudMap) { fraudMap.remove(); fraudMap = null }
    const mapEl = document.getElementById('fraud-map')
    if (yourLoc && jobLoc && window.L) {
      const midLat = (yourLoc.lat + jobLoc.lat) / 2
      const midLng = (yourLoc.lng + jobLoc.lng) / 2
      fraudMap = L.map(mapEl).setView([midLat, midLng], 12)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(fraudMap)
      // Worker marker (blue)
      const workerIcon = L.divIcon({ className: '', html: '<div style="background:#3b82f6;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>', iconSize:[14,14], iconAnchor:[7,7] })
      L.marker([yourLoc.lat, yourLoc.lng], { icon: workerIcon }).addTo(fraudMap).bindPopup('You are here')
      // Job site marker (red)
      const jobIcon = L.divIcon({ className: '', html: '<div style="background:#ef4444;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>', iconSize:[14,14], iconAnchor:[7,7] })
      L.marker([jobLoc.lat, jobLoc.lng], { icon: jobIcon }).addTo(fraudMap).bindPopup('Job site')
      // Line between them
      L.polyline([[yourLoc.lat, yourLoc.lng],[jobLoc.lat, jobLoc.lng]], { color:'#ef4444', weight:2, dashArray:'6,4' }).addTo(fraudMap)
      // Fit bounds
      fraudMap.fitBounds([[yourLoc.lat, yourLoc.lng],[jobLoc.lat, jobLoc.lng]], { padding:[20,20] })
    } else {
      mapEl.innerHTML = '<div class="flex items-center justify-center h-full text-gray-400 text-sm"><i class="fas fa-map-marked-alt mr-2"></i>Map unavailable</div>'
    }
  }, 200)
}

function closeFraudModal() {
  document.getElementById('fraud-blocked-modal').classList.add('hidden')
  stopOverridePolling()
  if (fraudMap) { fraudMap.remove(); fraudMap = null }
}

function startOverridePolling() {
  if (!pendingOverrideId) return
  document.getElementById('fraud-request-sent').classList.add('hidden')
  document.getElementById('fraud-pending').classList.remove('hidden')
  document.getElementById('fraud-wait-btn').classList.add('hidden')
  stopOverridePolling()
  pollOverrideStatus()
  overridePollTimer = setInterval(pollOverrideStatus, 15000)
}

function stopOverridePolling() {
  if (overridePollTimer) { clearInterval(overridePollTimer); overridePollTimer = null }
}

async function pollOverrideStatus() {
  if (!pendingOverrideId) return
  document.getElementById('fraud-poll-status').textContent = 'Checking... ' + new Date().toLocaleTimeString()
  try {
    const res = await fetch('/api/override/status/' + pendingOverrideId)
    const data = await res.json()
    const req = data.request
    if (!req) return

    if (req.status === 'approved') {
      stopOverridePolling()
      closeFraudModal()
      // Fetch the newly created session
      const sRes = await fetch('/api/sessions/status/' + currentWorker.id)
      const sData = await sRes.json()
      if (sData.active_session) {
        activeSession = sData.active_session
        setClockedInUI(true)
        startDurationTimer()
        startPingInterval()
        startWatchdog()
        showToast('\u2705 Admin approved! You are now clocked in.', 'success')
        await loadStats()
        await loadWorkLog()
      }
    } else if (req.status === 'denied') {
      stopOverridePolling()
      closeFraudModal()
      showToast('\u274C Admin denied your clock-in request. Contact your supervisor.', 'error')
    }
  } catch(e) {
    document.getElementById('fraud-poll-status').textContent = 'Checking every 15 seconds...'
  }
}

// ── Clock Out (internal — always call openClockoutConfirm() from UI) ──────────
async function _doClockOut() {
  const btn = document.getElementById('clock-btn')
  if (btn) btn.disabled = true
  try {
    const res = await fetch('/api/sessions/clock-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker_id: currentWorker.id,
        latitude: currentLat,
        longitude: currentLng,
        address: currentAddress
      })
    })
    const data = await res.json()
    if (data.session) {
      const hrs = (data.total_hours || 0).toFixed(2)
      const earned = '$' + (data.earnings || 0).toFixed(2)
      activeSession = null
      stopWatchdog()
      clearInterval(durationTimer)
      clearInterval(pingInterval)
      closeMap()  // always close map on clock-out
      hideAllBanners()
      setClockedInUI(false)
      showToast(`Clocked out! ${hrs}h worked · ${earned} earned 🎉`, 'success')
      await loadStats()
      await loadWorkLog()
    } else { showToast(data.error || 'Failed to clock out', 'error') }
  } catch(e) { showToast('Connection error', 'error') }
  if (btn) btn.disabled = false
}

// ── Duration Timer ────────────────────────────────────────────────────────────
function startDurationTimer() {
  clearInterval(durationTimer)
  durationTimer = setInterval(() => {
    if (!activeSession) return
    const diff = (new Date() - new Date(activeSession.clock_in_time)) / 1000
    const h = Math.floor(diff / 3600)
    const m = Math.floor((diff % 3600) / 60)
    const s = Math.floor(diff % 60)
    document.getElementById('session-duration').textContent = `${h}h ${m}m ${s}s`
    document.getElementById('session-earnings').textContent = '$' + ((diff / 3600) * (currentWorker.hourly_rate || 0)).toFixed(2)
  }, 1000)
}

// ── Location ──────────────────────────────────────────────────────────────────
function getLocation() {
  if (!navigator.geolocation) {
    document.getElementById('location-status').innerHTML = '<i class="fas fa-exclamation-circle text-red-500 mr-1"></i> GPS not supported'
    return
  }
  document.getElementById('location-status').innerHTML = '<i class="fas fa-circle-notch spinner mr-1"></i> Getting location...'
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      currentLat = pos.coords.latitude
      currentLng = pos.coords.longitude
      const acc = Math.round(pos.coords.accuracy)
      document.getElementById('location-status').innerHTML =
        `<i class="fas fa-check-circle text-green-500 mr-1"></i> <span class="text-gray-700 font-medium">${currentLat.toFixed(5)}, ${currentLng.toFixed(5)}</span> <span class="text-xs text-gray-400">±${acc}m</span>`
      try {
        const geo = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${currentLat}&lon=${currentLng}&format=json`)
        const gd = await geo.json()
        if (gd.display_name) {
          currentAddress = gd.display_name
          document.getElementById('location-status').innerHTML =
            `<i class="fas fa-map-marker-alt text-red-500 mr-1"></i> <span class="text-gray-700 text-xs">${gd.display_name.substring(0,80)}...</span> <span class="text-xs text-gray-400">±${acc}m</span>`
        }
      } catch(e) {}
      showMap(currentLat, currentLng)
    },
    () => {
      document.getElementById('location-status').innerHTML = '<i class="fas fa-exclamation-triangle text-yellow-500 mr-1"></i> Location access denied'
      currentLat = null; currentLng = null
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  )
}

function showMap(lat, lng) {
  // Store coords for lazy map render — don't auto-open the map
  // Just reveal the "View Map" button so the user can open it on demand
  const toggleBtn = document.getElementById('toggle-map-btn')
  if (toggleBtn) toggleBtn.classList.remove('hidden')
  // If map is already open, refresh it in place
  const wrapper = document.getElementById('map-wrapper')
  if (wrapper && !wrapper.classList.contains('hidden')) {
    renderMap(lat, lng)
  }
}

function renderMap(lat, lng) {
  const mapEl = document.getElementById('map')
  if (!mapEl) return
  // Destroy and recreate to prevent sticky grey tiles
  if (map) { map.remove(); map = null; marker = null }
  map = L.map('map', { zoomControl: true, attributionControl: false })
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map)
  map.setView([lat, lng], 16)
  marker = L.circleMarker([lat, lng], { color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.8, radius: 10 }).addTo(map)
  // Force Leaflet to recalculate size after reveal
  setTimeout(() => { if (map) map.invalidateSize() }, 150)
}

function toggleMap() {
  const wrapper = document.getElementById('map-wrapper')
  const btn = document.getElementById('toggle-map-btn')
  if (!wrapper) return
  if (wrapper.classList.contains('hidden')) {
    // Open map
    wrapper.classList.remove('hidden')
    document.body.style.overflow = 'hidden' // prevent scroll behind mobile overlay
    if (btn) btn.innerHTML = '<i class="fas fa-map mr-1"></i>Hide Map'
    if (currentLat && currentLng) renderMap(currentLat, currentLng)
  } else {
    closeMap()
  }
}

function closeMap() {
  const wrapper = document.getElementById('map-wrapper')
  const btn = document.getElementById('toggle-map-btn')
  if (wrapper) wrapper.classList.add('hidden')
  document.body.style.overflow = ''
  if (btn) btn.innerHTML = '<i class="fas fa-map mr-1"></i>View Map'
  // Destroy Leaflet instance so it doesn't get stuck
  if (map) { map.remove(); map = null; marker = null }
}

function startPingInterval() {
  clearInterval(pingInterval)
  // Send one immediate ping right away (best-effort, lat may still be null — retried in interval)
  // This ensures there is at least one ping in the DB shortly after clock-in,
  // preventing the watchdog from falsely flagging the worker as "GPS lost"
  // before the 5-minute interval fires for the first time.
  setTimeout(async () => {
    if (!activeSession) return
    // Wait up to 8s for GPS to resolve before giving up on first ping
    const waitForGps = (ms) => new Promise(res => setTimeout(res, ms))
    let tries = 0
    while (!currentLat && tries < 4) { await waitForGps(2000); tries++ }
    if (!activeSession || !currentLat) return
    try {
      await fetch('/api/location/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: activeSession.id, worker_id: currentWorker.id, latitude: currentLat, longitude: currentLng })
      })
    } catch(e) {}
  }, 1000)  // start 1 second after clock-in

  pingInterval = setInterval(async () => {
    if (!activeSession || !currentLat) return
    try {
      const res = await fetch('/api/location/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: activeSession.id, worker_id: currentWorker.id, latitude: currentLat, longitude: currentLng })
      })
      const pingData = await res.json()
      // Show drift banner if server detected worker has left the job site
      if (pingData.drift_detected) {
        const distTxt = pingData.drift_distance_meters >= 1000
          ? (pingData.drift_distance_meters / 1000).toFixed(1) + ' km'
          : pingData.drift_distance_meters + ' m'
        showGuardrailBanner('drift', 'You are ' + distTxt + ' away from "' + (activeSession.job_location || 'the job site') + '".')
      }
      getLocation()
    } catch(e) {}
  }, 5 * 60 * 1000)  // ping every 5 min
}

// ── Guardrail Watchdog (runs every 60s while clocked in) ──────────────────────
let watchdogTimer = null
let lastPingTime  = Date.now()

function startWatchdog() {
  stopWatchdog()
  lastPingTime = Date.now()
  watchdogTimer = setInterval(async () => {
    if (!activeSession || !currentWorker) return
    try {
      const res = await fetch('/api/sessions/watchdog')
      const data = await res.json()
      const myResult = (data.results || []).find(r => r.session_id === activeSession?.id)

      if (!myResult) {
        // Session no longer active — check WHY it was closed
        clearInterval(watchdogTimer)
        clearInterval(durationTimer)
        clearInterval(pingInterval)

        // Fetch the closed session to get the reason
        let clockoutReason = 'You have been clocked out.'
        let clockoutType   = 'admin'  // 'admin' | 'geofence' | 'maxshift' | 'eod'
        try {
          const sr = await fetch('/api/sessions/last/' + currentWorker.id)
          if (sr.ok) {
            const sd = await sr.json()
            const reason = (sd.auto_clockout_reason || '').toLowerCase()
            if (reason.includes('geofence') || reason.includes('drift') || reason.includes('left job site')) {
              clockoutType = 'geofence'
              clockoutReason = '📍 You were clocked out automatically because you left the job site geofence.'
            } else if (reason.includes('max shift') || reason.includes('maximum shift')) {
              clockoutType = 'maxshift'
              clockoutReason = '⏰ You were clocked out automatically — you reached the maximum shift limit.'
            } else if (reason.includes('end of day') || reason.includes('forgot to clock out')) {
              clockoutType = 'eod'
              clockoutReason = '🌙 You were automatically clocked out at end of day because you forgot to clock out.'
            } else if (reason.includes('admin') || reason.includes('manager') || reason.includes('manually')) {
              clockoutType = 'admin'
              clockoutReason = '🔴 Your manager has clocked you out' + (sd.auto_clockout_reason ? ': ' + sd.auto_clockout_reason.replace('Admin clock-out: ', '') : '.') + '\nIf you have questions, contact your manager.'
            }
          }
        } catch(e) {}

        activeSession = null
        setClockedInUI(false)
        hideAllBanners()
        showClockoutNotification(clockoutType, clockoutReason)
        await loadStats()
        await loadWorkLog()
        return
      }

      const hoursWorked   = myResult.hours_worked || 0
      const maxShiftHours = myResult.max_shift_hours || 10
      const hoursLeft     = maxShiftHours - hoursWorked

      // Max shift warning — show 30 min before limit
      if (hoursLeft <= 0.5 && hoursLeft > 0) {
        const minsLeft = Math.round(hoursLeft * 60)
        showGuardrailBanner('maxshift', 'You have worked ' + hoursWorked.toFixed(1) + 'h. Auto clock-out in ' + minsLeft + ' minutes.')
      } else {
        hideBanner('maxshift')
      }

      // Away detection — based on time since last ping from this device
      const minsSinceDevicePing = (Date.now() - lastPingTime) / (1000 * 60)
      const awayThreshold = 30  // matches server setting
      if (minsSinceDevicePing >= awayThreshold) {
        showGuardrailBanner('away', 'No GPS update for ' + Math.round(minsSinceDevicePing) + ' minutes.')
      } else {
        hideBanner('away')
      }

      // Drift banner (set by ping response, kept visible)
      if (!myResult.drift_flag) hideBanner('drift')

    } catch(e) {}
  }, 60 * 1000)  // check every 60s
}

function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
}

// Show a prominent notification when a worker is clocked out remotely
function showClockoutNotification(type, message) {
  // Remove any existing notification
  const existing = document.getElementById('clockout-notification')
  if (existing) existing.remove()

  const colors = {
    admin:    { bg: '#dc2626', icon: '🔴', title: 'Clocked Out by Manager' },
    geofence: { bg: '#d97706', icon: '📍', title: 'Auto Clock-Out: Left Job Site' },
    maxshift: { bg: '#7c3aed', icon: '⏰', title: 'Auto Clock-Out: Max Shift Reached' },
    eod:      { bg: '#2563eb', icon: '🌙', title: 'Auto Clock-Out: End of Day' }
  }
  const c = colors[type] || colors.admin

  const notif = document.createElement('div')
  notif.id = 'clockout-notification'
  notif.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.85); z-index: 99999;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  `
  notif.innerHTML = `
    <div style="background: white; border-radius: 20px; padding: 32px 24px; max-width: 360px; width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.4);">
      <div style="width: 72px; height: 72px; background: ${c.bg}; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; margin: 0 auto 16px;">${c.icon}</div>
      <h2 style="font-size: 20px; font-weight: 700; color: #111827; margin: 0 0 12px;">${c.title}</h2>
      <p style="font-size: 14px; color: #4b5563; line-height: 1.6; margin: 0 0 24px; white-space: pre-line;">${message}</p>
      <button onclick="document.getElementById('clockout-notification').remove()"
        style="background: ${c.bg}; color: white; border: none; padding: 14px 32px; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; width: 100%;">
        OK, Got It
      </button>
    </div>
  `
  document.body.appendChild(notif)

  // Also vibrate phone if supported
  if (navigator.vibrate) navigator.vibrate([300, 100, 300])
}

function showGuardrailBanner(type, msg) {
  const banner = document.getElementById('banner-' + type)
  const msgEl  = document.getElementById('banner-' + type + '-msg')
  if (!banner) return
  if (msgEl && msg) msgEl.textContent = msg
  banner.classList.remove('hidden')
}

function hideBanner(type) {
  const banner = document.getElementById('banner-' + type)
  if (banner) banner.classList.add('hidden')
}

function hideAllBanners() {
  ['drift','away','maxshift'].forEach(t => hideBanner(t))
}

async function confirmStillWorking() {
  // Worker tapped "Yes, still here" — refresh location to reset the away timer
  lastPingTime = Date.now()
  hideBanner('away')
  getLocation()
  showToast('Got it — refreshing your location', 'success')
}

// ── Stats & Pay ───────────────────────────────────────────────────────────────
let _payData = null   // cached response from /api/stats/worker
let _payView  = 'today'  // current tab: today | week | month | period

async function loadStats() {
  try {
    const res = await fetch('/api/stats/worker/' + currentWorker.id)
    const data = await res.json()
    _payData = data

    // My Stats row (all-time)
    if (data.stats) {
      document.getElementById('stat-sessions').textContent = data.stats.total_sessions || 0
      document.getElementById('stat-hours').textContent    = (data.stats.total_hours   || 0).toFixed(1)
      document.getElementById('stat-earnings').textContent = '$' + (data.stats.total_earnings || 0).toFixed(0)
    }

    // Set pay rate display
    const rate = currentWorker.hourly_rate || 0
    const rateEl = document.getElementById('pay-rate')
    if (rateEl) rateEl.textContent = parseFloat(rate).toFixed(2)

    // Render pay view (default: today)
    renderPayView(_payView)
  } catch(e) { console.error('loadStats error', e) }
}

function switchPayView(view) {
  _payView = view
  // Update tab button styles
  ;['today','week','month','period'].forEach(v => {
    const btn = document.getElementById('pv-' + v)
    if (!btn) return
    if (v === view) {
      btn.className = 'px-2.5 py-1 text-xs font-medium rounded-lg bg-white shadow-sm text-gray-700'
    } else {
      btn.className = 'px-2.5 py-1 text-xs font-medium rounded-lg text-gray-500'
    }
  })
  renderPayView(view)
}

function renderPayView(view) {
  if (!_payData) return
  const bd = _payData.breakdown || {}
  const pi = _payData.pay_info   || {}

  const labels = { today: 'Today', week: 'This Week', month: 'This Month', period: 'This Pay Period' }

  // Pick the right bucket
  let hours    = 0
  let earnings = 0
  if (view === 'today')  { hours = bd.today?.hours  || 0; earnings = bd.today?.earnings  || 0 }
  if (view === 'week')   { hours = bd.week?.hours   || 0; earnings = bd.week?.earnings   || 0 }
  if (view === 'month')  { hours = bd.month?.hours  || 0; earnings = bd.month?.earnings  || 0 }
  if (view === 'period') { hours = bd.period?.hours || 0; earnings = bd.period?.earnings || 0 }

  // Update big numbers
  const hasHours = hours > 0
  document.getElementById('pay-hours').textContent      = hasHours ? hours.toFixed(1) : '0.0'
  document.getElementById('pay-gross').textContent      = '$' + (earnings).toFixed(2)
  document.getElementById('pay-hours-label').textContent = labels[view] || ''

  // Empty state
  document.getElementById('pay-empty').classList.toggle('hidden', hasHours || view !== 'today')

  // Next payday banner — only on "period" tab
  const banner = document.getElementById('pay-period-banner')
  banner.classList.toggle('hidden', view !== 'period')
  if (view === 'period' && pi.next_payday) {
    // Format next payday
    const nextDate = new Date(pi.next_payday + 'T00:00:00')
    const opts     = { weekday: 'long', month: 'long', day: 'numeric' }
    document.getElementById('pay-next-date').textContent = nextDate.toLocaleDateString('en-CA', opts)

    // Countdown in days
    const daysLeft = Math.ceil((nextDate - new Date()) / 86400000)
    document.getElementById('pay-next-countdown').textContent =
      daysLeft === 0 ? '🎉 Today is payday!'
      : daysLeft === 1 ? '1 day away'
      : daysLeft + ' days away'

    // Period range
    const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
    document.getElementById('pay-period-range').textContent = fmt(pi.period_start) + ' – ' + fmt(pi.period_end)
    document.getElementById('pay-period-hours').textContent = (bd.period?.hours || 0).toFixed(1) + ' hrs'
    document.getElementById('pay-period-gross').textContent = '$' + (bd.period?.earnings || 0).toFixed(2)
  }

  // Daily breakdown list — show for week / month / period
  const showBreakdown = ['week','month','period'].includes(view)
  document.getElementById('pay-daily-breakdown').classList.toggle('hidden', !showBreakdown)
  if (showBreakdown) {
    const daily = pi.daily || []
    const listEl = document.getElementById('pay-daily-list')
    if (daily.length === 0) {
      listEl.innerHTML = '<p class="text-gray-400 text-xs text-center py-2">No days recorded yet</p>'
    } else {
      listEl.innerHTML = daily.map(d => {
        const dt = new Date(d.day + 'T00:00:00')
        const label = dt.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })
        const barPct = Math.min(100, ((d.hours || 0) / 10) * 100)
        return `<div class="flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-0">
          <span class="text-xs text-gray-500 w-28 flex-shrink-0">${label}</span>
          <div class="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
            <div class="bg-blue-400 h-2 rounded-full" style="width:${barPct}%"></div>
          </div>
          <span class="text-xs font-bold text-gray-700 w-10 text-right">${(d.hours||0).toFixed(1)}h</span>
          <span class="text-xs font-bold text-emerald-600 w-14 text-right">$${(d.earnings||0).toFixed(2)}</span>
        </div>`
      }).join('')
    }
  }
}

// ── Work Log grouped by Day ───────────────────────────────────────────────────
async function loadWorkLog() {
  try {
    const res = await fetch('/api/sessions/worker/' + currentWorker.id + '?limit=60')
    const data = await res.json()
    const el = document.getElementById('work-log-by-day')
    if (!data.sessions || data.sessions.length === 0) {
      el.innerHTML = '<p class="text-gray-400 text-sm text-center py-6"><i class="fas fa-inbox mb-2 block text-2xl"></i>No sessions yet</p>'
      return
    }

    // Group sessions by calendar date
    const groups = {}
    data.sessions.forEach(s => {
      const d = new Date(s.clock_in_time)
      const key = d.toISOString().split('T')[0]           // YYYY-MM-DD key
      if (!groups[key]) groups[key] = { date: d, sessions: [] }
      groups[key].sessions.push(s)
    })

    const today = new Date().toISOString().split('T')[0]
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

    el.innerHTML = Object.keys(groups).sort((a,b) => b.localeCompare(a)).map(key => {
      const g = groups[key]
      const dayLabel = key === today ? '📅 Today'
        : key === yesterday ? '📅 Yesterday'
        : '📅 ' + g.date.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' })

      const dayHours = g.sessions.reduce((sum, s) => sum + (s.total_hours || 0), 0)
      const dayEarnings = g.sessions.reduce((sum, s) => sum + (s.earnings || 0), 0)
      const hasActive = g.sessions.some(s => s.status === 'active')

      const sessionsHTML = g.sessions.map(s => {
        const clockIn = new Date(s.clock_in_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
        const clockOut = s.clock_out_time
          ? new Date(s.clock_out_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
          : null
        const isActive = s.status === 'active'

        return `<div class="bg-white border border-gray-100 rounded-xl p-3.5 mb-2 last:mb-0 shadow-sm">
          <!-- Job location + description -->
          ${s.job_location ? `
            <div class="flex items-start gap-2 mb-2">
              <i class="fas fa-map-marker-alt text-red-500 mt-0.5 text-sm flex-shrink-0"></i>
              <div>
                <p class="text-sm font-bold text-gray-800">${s.job_location}</p>
                ${s.job_description ? `<p class="text-xs text-gray-500 mt-0.5">${s.job_description}</p>` : ''}
              </div>
            </div>
          ` : ''}
          <!-- Times + earnings -->
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-xs text-gray-500">
              <i class="fas fa-clock text-blue-400"></i>
              <span>${clockIn}</span>
              <span class="text-gray-300">→</span>
              ${isActive
                ? `<span class="bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium pulse">Working now</span>`
                : `<span>${clockOut}</span>`
              }
            </div>
            <div class="text-right">
              ${isActive
                ? `<span class="text-green-600 text-xs font-medium">In progress...</span>`
                : `<span class="text-xs font-bold text-gray-700">${(s.total_hours||0).toFixed(2)}h</span>
                   <span class="text-xs text-green-600 font-bold ml-1">$${(s.earnings||0).toFixed(2)}</span>`
              }
            </div>
          </div>
          ${s.clock_in_lat ? `
            <div class="mt-1.5">
              <a href="https://maps.google.com/?q=${s.clock_in_lat},${s.clock_in_lng}" target="_blank"
                class="text-xs text-blue-500 hover:text-blue-700">
                <i class="fas fa-external-link-alt mr-1"></i>View on map
              </a>
            </div>
          ` : ''}
          ${!isActive ? `
            <div class="mt-2 pt-2 border-t border-gray-100">
              <button onclick="openDisputeModal(${s.id})"
                class="text-xs text-rose-500 hover:text-rose-700 flex items-center gap-1">
                <i class="fas fa-flag mr-1"></i>Report an issue with this session
              </button>
            </div>
          ` : ''}
        </div>`
      }).join('')

      return `<div class="mb-4">
        <!-- Day header -->
        <div class="flex items-center justify-between mb-2 pl-1">
          <span class="text-sm font-bold text-gray-700">${dayLabel}</span>
          <div class="flex items-center gap-2 text-xs">
            ${hasActive
              ? `<span class="bg-green-100 text-green-700 px-2 py-0.5 rounded-full pulse font-medium">Active</span>`
              : `<span class="text-gray-500">${dayHours.toFixed(1)}h</span>
                 <span class="font-bold text-green-600">$${dayEarnings.toFixed(2)}</span>`
            }
          </div>
        </div>
        <!-- Sessions for this day -->
        <div class="day-group pl-3">
          ${sessionsHTML}
        </div>
      </div>`
    }).join('')
  } catch(e) { console.error(e) }
}

// ── Worker Calendar View ───────────────────────────────────────────────────────
let workerCalYear = new Date().getFullYear()
let workerCalMonth = new Date().getMonth() + 1
let workerCalHolidays = []
let workerCalSchedule = { work_days:[1,2,3,4,5] }
const WC_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function showWorkerView(v) {
  document.getElementById('view-log-panel').classList.toggle('hidden', v !== 'log')
  document.getElementById('view-cal-panel').classList.toggle('hidden', v !== 'calendar')
  document.getElementById('view-log-btn').className = v === 'log'
    ? 'px-3 py-1.5 text-xs font-medium rounded-xl bg-purple-600 text-white'
    : 'px-3 py-1.5 text-xs font-medium rounded-xl bg-gray-100 text-gray-600'
  document.getElementById('view-cal-btn').className = v === 'calendar'
    ? 'px-3 py-1.5 text-xs font-medium rounded-xl bg-purple-600 text-white'
    : 'px-3 py-1.5 text-xs font-medium rounded-xl bg-gray-100 text-gray-600'
  if (v === 'calendar') loadWorkerCalendar()
}

function workerCalPrev() { workerCalMonth--; if(workerCalMonth<1){workerCalMonth=12;workerCalYear--} loadWorkerCalendar() }
function workerCalNext() { workerCalMonth++; if(workerCalMonth>12){workerCalMonth=1;workerCalYear++} loadWorkerCalendar() }

async function loadWorkerCalendar() {
  if (!currentWorker) return
  document.getElementById('worker-cal-label').textContent = WC_MONTHS[workerCalMonth-1] + ' ' + workerCalYear
  try {
    const [calRes, holRes] = await Promise.all([
      fetch(`/api/calendar/${workerCalYear}/${workerCalMonth}?worker_id=${currentWorker.id}`),
      fetch(`/api/holidays/${workerCalYear}`)
    ])
    const calData = await calRes.json()
    const holData = await holRes.json()
    workerCalHolidays = holData.holidays || []
    workerCalSchedule = calData.settings || { work_days:[1,2,3,4,5] }
    renderWorkerCalGrid(calData)
    renderWorkerCalStats(calData)
    renderWorkerCalHolidays()
  } catch(e) { console.error(e) }
}

function renderWorkerCalGrid(calData) {
  const sessionsByDate = calData.sessions_by_date || {}
  const workDays = workerCalSchedule.work_days || [1,2,3,4,5]
  const today = new Date().toISOString().split('T')[0]
  const holidayDates = {}
  workerCalHolidays.forEach(h => { holidayDates[h.date] = h })

  const firstDay = new Date(workerCalYear, workerCalMonth-1, 1).getDay()
  const daysInMonth = new Date(workerCalYear, workerCalMonth, 0).getDate()
  let html = ''

  for (let i = 0; i < firstDay; i++) {
    html += `<div class="min-h-[44px] rounded-lg bg-gray-50"></div>`
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${workerCalYear}-${String(workerCalMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const dow = new Date(workerCalYear, workerCalMonth-1, d).getDay()
    const isWeekend = !workDays.includes(dow)
    const isToday = dateStr === today
    const isHoliday = !!holidayDates[dateStr]
    const sessions = sessionsByDate[dateStr] || []
    const hasSessions = sessions.length > 0
    const totalHours = sessions.reduce((s, x) => s + (x.total_hours || 0), 0)

    let cellClass = 'min-h-[44px] rounded-lg p-1 text-center border text-xs '
    if (isToday)          cellClass += 'bg-yellow-100 border-yellow-400 ring-1 ring-yellow-300 '
    else if (isHoliday)   cellClass += 'bg-red-50 border-red-200 '
    else if (isWeekend)   cellClass += 'bg-gray-50 border-gray-100 '
    else if (hasSessions) cellClass += 'bg-green-50 border-green-300 '
    else                  cellClass += 'bg-white border-gray-100 '

    html += `<div class="${cellClass}">
      <div class="font-bold ${isToday?'text-yellow-700':isWeekend?'text-gray-300':isHoliday?'text-red-500':'text-gray-700'}">${d}</div>
      ${isHoliday ? `<div style="font-size:7px" class="text-red-400 leading-tight mt-0.5">★</div>`
        : hasSessions ? `<div style="font-size:8px" class="text-green-600 font-bold">${totalHours.toFixed(1)}h</div>`
        : isWeekend ? `<div style="font-size:7px" class="text-gray-300">off</div>` : ''}
    </div>`
  }

  document.getElementById('worker-cal-grid').innerHTML = html
}

function renderWorkerCalStats(calData) {
  const sessionsByDate = calData.sessions_by_date || {}
  let totalHours = 0, totalEarnings = 0, daysWorked = 0
  Object.values(sessionsByDate).forEach((sessions) => {
    totalHours += sessions.reduce((s, x) => s + (x.total_hours || 0), 0)
    totalEarnings += sessions.reduce((s, x) => s + (x.earnings || 0), 0)
    daysWorked++
  })
  document.getElementById('worker-cal-stats').innerHTML = `
    <div class="bg-blue-50 rounded-xl p-2.5 text-center">
      <p class="text-lg font-bold text-blue-700">${daysWorked}</p>
      <p class="text-xs text-blue-400">Days</p>
    </div>
    <div class="bg-green-50 rounded-xl p-2.5 text-center">
      <p class="text-lg font-bold text-green-700">${totalHours.toFixed(1)}</p>
      <p class="text-xs text-green-400">Hours</p>
    </div>
    <div class="bg-purple-50 rounded-xl p-2.5 text-center">
      <p class="text-lg font-bold text-purple-700">$${totalEarnings.toFixed(0)}</p>
      <p class="text-xs text-purple-400">Earned</p>
    </div>
  `
}

function renderWorkerCalHolidays() {
  const monthHols = workerCalHolidays.filter(h => {
    const d = new Date(h.date)
    return d.getFullYear() === workerCalYear && d.getMonth()+1 === workerCalMonth
  })
  if (monthHols.length === 0) { document.getElementById('worker-cal-holidays').innerHTML = ''; return }
  document.getElementById('worker-cal-holidays').innerHTML = monthHols.map(h =>
    `<div class="flex items-center justify-between text-xs py-1 border-t border-gray-100">
      <span class="text-red-600 font-medium"><i class="fas fa-star mr-1"></i>${h.name}</span>
      <span class="text-amber-600 font-bold">${h.stat_multiplier || 1.5}× pay</span>
    </div>`
  ).join('')
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('wt_device_id')
  if (!id) { id = 'dev_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now(); localStorage.setItem('wt_device_id', id) }
  return id
}

// ── Feature 3: Report an Issue — handled below ────────────────────────────────

function showToast(msg, type = 'info', duration = 4000) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.className = `fixed bottom-6 left-1/2 transform -translate-x-1/2 px-5 py-3 rounded-xl shadow-xl z-50 text-sm font-medium text-white max-w-xs text-center
    ${type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-green-600' : 'bg-gray-800'}`
  t.classList.remove('hidden')
  setTimeout(() => t.classList.add('hidden'), duration)
}

// ── Add to Home Screen banner ────────────────────────────────────────────────
function dismissA2HS() {
  localStorage.setItem('a2hs_dismissed', '1')
  document.getElementById('a2hs-banner')?.remove()
}

;(function initA2HS() {
  if (localStorage.getItem('a2hs_dismissed')) return
  // Don't show if already installed (standalone mode)
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return
  const banner = document.getElementById('a2hs-banner')
  if (!banner) return
  const isAndroid = /android/i.test(navigator.userAgent)
  const isIOS     = /iphone|ipad|ipod/i.test(navigator.userAgent)
  if (!isIOS && !isAndroid) return   // desktop — don't show
  if (isAndroid) {
    banner.querySelector('.ios-hint')?.classList.add('hidden')
    banner.querySelector('.android-hint')?.classList.remove('hidden')
  }
  setTimeout(() => banner.classList.remove('hidden'), 2500)  // show after 2.5s
})()

// ── Feature 3: Worker Dispute / Report Issue ──────────────────────────────────
let disputeSessionId = null

function openDisputeModal(sessionId) {
  disputeSessionId = sessionId
  const modal = document.getElementById('dispute-modal')
  // Look up session details from the DOM or use a generic label
  const sessionLabel = 'Session #' + sessionId
  document.getElementById('dispute-session-label').textContent = sessionLabel
  document.getElementById('dispute-message').value = ''
  document.getElementById('dispute-send-btn').disabled = false
  document.getElementById('dispute-send-btn').innerHTML =
    '<i class="fas fa-paper-plane mr-1.5"></i>Send Report'
  modal.classList.remove('hidden')
  document.body.style.overflow = 'hidden'
  setTimeout(() => document.getElementById('dispute-message').focus(), 200)
}

function closeDisputeModal() {
  document.getElementById('dispute-modal').classList.add('hidden')
  document.body.style.overflow = ''
  disputeSessionId = null
}

async function sendDispute() {
  const message = document.getElementById('dispute-message').value.trim()
  if (!message) { showToast('Please describe the issue', 'error'); return }
  if (!disputeSessionId || !currentWorker) return

  const btn = document.getElementById('dispute-send-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Sending...'

  try {
    const res = await fetch('/api/disputes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: disputeSessionId,
        message
      })
    })
    const data = await res.json()
    if (data.success) {
      closeDisputeModal()
      showToast('Your report was sent to admin', 'success')
    } else {
      showToast(data.error || 'Failed to send report', 'error')
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-paper-plane mr-1.5"></i>Send Report'
    }
  } catch(e) {
    showToast('Connection error', 'error')
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-paper-plane mr-1.5"></i>Send Report'
  }
}

const DISPUTE_MSGS = [
  '',
  'I was auto clocked out but I was still working',
  'The clock-out time is wrong. I worked longer than recorded',
  'GPS showed wrong location. I was at the job site the whole time',
  'Hours or earnings look incorrect'
]
function setDisputeMsg(n) {
  document.getElementById('dispute-message').value = DISPUTE_MSGS[n] || ''
}

// ── Worker Bottom Tab Navigation ──────────────────────────────────────────────
const WK_TABS = ['clock','dispatches','history','profile']
const WK_ACCENT = '#4f46e5'

function wkShowTab(tab) {
  WK_TABS.forEach(t => {
    const panel = document.getElementById('wk-tab-' + t)
    const btn   = document.getElementById('wk-nav-' + t)
    if (!panel || !btn) return
    const active = (t === tab)
    // Use flex so the panel fills available height in the flex-column screen-main
    panel.style.display  = active ? 'flex' : 'none'
    panel.style.flexDirection = active ? 'column' : ''
    btn.style.color      = active ? WK_ACCENT : '#9ca3af'
    btn.style.fontWeight = active ? '700' : '600'
    btn.style.borderTop  = active ? '2px solid ' + WK_ACCENT : '2px solid transparent'
  })
  // Lazy-load data when tab is first opened
  if (tab === 'dispatches') loadWkDispatches()
  if (tab === 'history')    loadWkPayHistory()
  if (tab === 'profile')    loadWkProfile()
}

// ── Dispatches Tab ────────────────────────────────────────────────────────────
async function loadWkDispatches() {
  if (!currentWorker?.id) return
  const pendingEl = document.getElementById('wk-dispatches-pending')
  const histEl    = document.getElementById('wk-dispatches-history-list')
  const emptyEl   = document.getElementById('wk-dispatches-empty')
  const badgeEl   = document.getElementById('wk-dispatch-badge')
  if (!pendingEl) return

  pendingEl.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;font-size:13px"><i class="fas fa-spinner fa-spin"></i> Loading...</div>'
  if (histEl) histEl.innerHTML = ''

  try {
    const res  = await fetch('/api/dispatch/worker/' + currentWorker.id)
    const data = await res.json()
    const dispatches = data.dispatches || []

    const pending  = dispatches.filter(d => ['sent','replied'].includes(d.status))
    const history  = dispatches.filter(d => !['sent','replied'].includes(d.status))

    // Badge
    if (badgeEl) {
      if (pending.length > 0) {
        badgeEl.style.display = 'inline-block'
        badgeEl.textContent   = pending.length
      } else {
        badgeEl.style.display = 'none'
      }
    }

    if (!dispatches.length) {
      pendingEl.innerHTML = ''
      if (histEl) histEl.innerHTML = ''
      if (emptyEl) emptyEl.style.display = 'block'
      return
    }
    if (emptyEl) emptyEl.style.display = 'none'

    // Render pending
    if (pending.length === 0) {
      pendingEl.innerHTML = ''
    } else {
      pendingEl.innerHTML = '<p style="font-size:11px;font-weight:700;text-transform:uppercase;color:#ef4444;letter-spacing:.05em;margin-bottom:10px"><i class="fas fa-bell mr-1"></i>Needs Your Response</p>'
        + pending.map(d => renderDispatchCard(d, true)).join('')
    }

    // Render history
    if (histEl) {
      if (history.length === 0) {
        histEl.innerHTML = '<p style="text-align:center;color:#94a3b8;font-size:12px;padding:12px 0">No recent history</p>'
      } else {
        histEl.innerHTML = history.map(d => renderDispatchCard(d, false)).join('')
      }
    }
  } catch(e) {
    pendingEl.innerHTML = '<p style="text-align:center;color:#ef4444;font-size:13px;padding:20px">Could not load jobs. Try refreshing.</p>'
  }
}

function renderDispatchCard(d, isPending) {
  const date    = d.created_at ? new Date(d.created_at).toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric'}) : ''
  const time    = d.created_at ? new Date(d.created_at).toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit'}) : ''
  const statusColors = {
    sent:      '#f59e0b',
    replied:   '#3b82f6',
    arrived:   '#10b981',
    completed: '#6b7280',
    cancelled: '#ef4444',
    failed:    '#ef4444',
  }
  const statusLabels = {
    sent:      'Awaiting Response',
    replied:   'Accepted',
    arrived:   'Arrived on Site',
    completed: 'Completed',
    cancelled: 'Cancelled',
    failed:    'Failed',
  }
  const color  = statusColors[d.status] || '#9ca3af'
  const label  = statusLabels[d.status] || d.status

  const responseButtons = isPending ? `
    <div style="display:flex;gap:8px;margin-top:12px">
      <button onclick="respondDispatch(${d.id},'accepted')"
        style="flex:1;background:#10b981;color:#fff;border:none;padding:9px 0;border-radius:10px;font-weight:700;font-size:12px;cursor:pointer">
        <i class="fas fa-check mr-1"></i>Accept
      </button>
      <button onclick="respondDispatch(${d.id},'arrived')"
        style="flex:1;background:#3b82f6;color:#fff;border:none;padding:9px 0;border-radius:10px;font-weight:700;font-size:12px;cursor:pointer">
        <i class="fas fa-map-marker-alt mr-1"></i>I Arrived
      </button>
      <button onclick="respondDispatch(${d.id},'declined')"
        style="flex:1;background:#fff;color:#ef4444;border:1.5px solid #fecaca;padding:9px 0;border-radius:10px;font-weight:700;font-size:12px;cursor:pointer">
        Decline
      </button>
    </div>` : ''

  return `
  <div style="background:#fff;border-radius:16px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:10px;border-left:4px solid ${color}">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div style="flex:1;min-width:0">
        <p style="font-size:14px;font-weight:800;color:#1e293b;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${d.job_name || 'Job Dispatch'}
        </p>
        ${d.job_address ? `<p style="font-size:12px;color:#64748b;margin-bottom:4px"><i class="fas fa-map-marker-alt mr-1" style="color:#ef4444"></i>${d.job_address}</p>` : ''}
        <p style="font-size:11px;color:#94a3b8">${date} ${time}</p>
      </div>
      <span style="flex-shrink:0;background:${color}22;color:${color};font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;white-space:nowrap">${label}</span>
    </div>
    ${d.notes ? `<p style="font-size:12px;color:#64748b;margin-top:6px;background:#f8fafc;padding:8px 10px;border-radius:8px">${d.notes}</p>` : ''}
    ${d.maps_url ? `<a href="${d.maps_url}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#4f46e5;font-weight:600;margin-top:6px"><i class="fas fa-directions"></i>Get Directions</a>` : ''}
    ${responseButtons}
  </div>`
}

async function respondDispatch(id, response) {
  if (!currentWorker?.id) return
  try {
    const res  = await fetch('/api/dispatch/' + id + '/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_id: currentWorker.id, response })
    })
    const data = await res.json()
    if (data.success) {
      const labels = { accepted: '✅ Job accepted!', declined: 'Job declined.', arrived: '📍 Marked as arrived!' }
      showToast(labels[response] || 'Response sent', 'success')
      await loadWkDispatches()
      // Also refresh the dispatch banner on the clock tab
      await checkPendingDispatch()
    } else {
      showToast(data.error || 'Failed to respond', 'error')
    }
  } catch(e) {
    showToast('Connection error', 'error')
  }
}

// ── Pay Period History Tab ────────────────────────────────────────────────────
async function loadWkPayHistory() {
  if (!currentWorker?.id) return
  const periodLabel = document.getElementById('wk-hist-period-label')
  const hoursEl     = document.getElementById('wk-hist-hours')
  const grossEl     = document.getElementById('wk-hist-gross')
  const paydayEl    = document.getElementById('wk-hist-payday')
  const daysEl      = document.getElementById('wk-hist-days-left')
  const sessionsEl  = document.getElementById('wk-hist-sessions')
  const emptyEl     = document.getElementById('wk-hist-empty')
  if (!sessionsEl) return

  if (periodLabel) periodLabel.textContent = 'Loading…'
  sessionsEl.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;font-size:13px"><i class="fas fa-spinner fa-spin"></i> Loading...</div>'

  try {
    const res  = await fetch('/api/sessions/worker/' + currentWorker.id + '/period')
    const data = await res.json()
    const period   = data.period   || {}
    const totals   = data.totals   || {}
    const sessions = data.sessions || []
    const showPay  = data.show_pay !== false

    // Period label
    const fmt = (s) => {
      if (!s) return '–'
      const d = new Date(s + 'T00:00:00')
      return d.toLocaleDateString('en-CA',{month:'short',day:'numeric'})
    }
    if (periodLabel) periodLabel.textContent = fmt(period.start) + ' – ' + fmt(period.end) + '  ·  ' + (period.frequency || 'biweekly')

    // Summary card
    const hrs = parseFloat(totals.total_hours || 0)
    if (hoursEl) hoursEl.textContent = hrs.toFixed(1) + 'h'
    if (grossEl) {
      grossEl.textContent = showPay
        ? '$' + parseFloat(totals.total_earnings || 0).toFixed(2)
        : '—'
    }

    // Payday countdown
    const today   = new Date(); today.setHours(0,0,0,0)
    const payday  = period.next_payday ? new Date(period.next_payday + 'T00:00:00') : null
    const daysLeft = payday ? Math.max(0, Math.round((payday - today) / 86400000)) : '–'
    if (paydayEl) paydayEl.textContent = payday ? payday.toLocaleDateString('en-CA',{weekday:'short',month:'short',day:'numeric'}) : '–'
    if (daysEl)   daysEl.textContent   = daysLeft

    // Sessions list
    if (sessions.length === 0) {
      sessionsEl.innerHTML = ''
      if (emptyEl) emptyEl.style.display = 'block'
      return
    }
    if (emptyEl) emptyEl.style.display = 'none'

    sessionsEl.innerHTML = sessions.map(s => {
      const inTime  = s.clock_in_time  ? new Date(s.clock_in_time)  : null
      const outTime = s.clock_out_time ? new Date(s.clock_out_time) : null
      const dateStr = inTime ? inTime.toLocaleDateString('en-CA',{weekday:'short',month:'short',day:'numeric'}) : '–'
      const inStr   = inTime  ? inTime.toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit'}) : '–'
      const outStr  = outTime ? outTime.toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit'}) : 'Active'
      const hrs     = parseFloat(s.total_hours || 0).toFixed(1)
      const earn    = parseFloat(s.earnings    || 0).toFixed(2)
      const statusColor = s.status === 'active' ? '#f59e0b' : '#10b981'
      const editedBadge = s.edited ? '<span style="font-size:9px;background:#fef3c7;color:#d97706;padding:1px 5px;border-radius:10px;font-weight:700;margin-left:4px">EDITED</span>' : ''
      return `
      <div style="background:#fff;border-radius:14px;padding:12px 14px;box-shadow:0 1px 3px rgba(0,0,0,.06);margin-bottom:8px;border-left:3px solid ${statusColor}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px">
          <p style="font-size:13px;font-weight:800;color:#1e293b">${dateStr}${editedBadge}</p>
          <span style="font-size:12px;font-weight:700;color:#059669">${showPay ? '$'+earn : hrs+'h'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:11px;color:#64748b">
          <span><i class="fas fa-sign-in-alt mr-1" style="color:#10b981"></i>${inStr}</span>
          <span style="color:#d1d5db">→</span>
          <span><i class="fas fa-sign-out-alt mr-1" style="color:#ef4444"></i>${outStr}</span>
          <span style="margin-left:auto;font-weight:600;color:#1e293b">${hrs}h</span>
        </div>
        ${s.job_location ? `<p style="font-size:11px;color:#94a3b8;margin-top:4px"><i class="fas fa-map-marker-alt mr-1"></i>${s.job_location}</p>` : ''}
        ${s.edit_reason  ? `<p style="font-size:10px;color:#d97706;margin-top:4px"><i class="fas fa-edit mr-1"></i>${s.edit_reason}</p>` : ''}
      </div>`
    }).join('')
  } catch(e) {
    sessionsEl.innerHTML = '<p style="text-align:center;color:#ef4444;font-size:13px;padding:20px">Could not load pay history. Try refreshing.</p>'
  }
}

// ── Profile Tab ───────────────────────────────────────────────────────────────
async function loadWkProfile() {
  if (!currentWorker) return
  const nameEl     = document.getElementById('wk-profile-name')
  const phoneEl    = document.getElementById('wk-profile-phone')
  const rateEl     = document.getElementById('wk-profile-rate')
  const statusEl   = document.getElementById('wk-profile-status')
  const sessionsEl = document.getElementById('wk-profile-sessions')
  const hoursEl    = document.getElementById('wk-profile-hours')
  if (nameEl)   nameEl.textContent   = currentWorker.name  || '–'
  if (phoneEl)  phoneEl.textContent  = currentWorker.phone || '–'
  if (rateEl)   rateEl.textContent   = currentWorker.hourly_rate ? '$' + parseFloat(currentWorker.hourly_rate).toFixed(2) + '/hr' : '–'
  if (statusEl) statusEl.textContent = currentWorker.status ? currentWorker.status.charAt(0).toUpperCase() + currentWorker.status.slice(1) : '–'
  // Load lifetime stats
  try {
    const res  = await fetch('/api/stats/worker/' + currentWorker.id)
    const data = await res.json()
    const st   = data.stats || {}
    if (sessionsEl) sessionsEl.textContent = st.total_sessions ?? '–'
    if (hoursEl)    hoursEl.textContent    = st.total_hours ? parseFloat(st.total_hours).toFixed(1) + 'h' : '–'
  } catch(_) {}
}

