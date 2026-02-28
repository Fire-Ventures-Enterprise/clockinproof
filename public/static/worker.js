let currentWorker = null
let activeSession = null
let currentLat = null
let currentLng = null
let currentAddress = null
let map = null
let marker = null
let durationTimer = null
let pingInterval = null
let recentLocations = []
// GPS fraud override state
let pendingOverrideId = null
let overridePollTimer = null
let fraudMap = null

// ── Init ──────────────────────────────────────────────────────────────────────
window.onload = async () => {
  const saved = localStorage.getItem('wt_worker')
  recentLocations = JSON.parse(localStorage.getItem('wt_recent_locations') || '[]')
  if (saved) {
    currentWorker = JSON.parse(saved)
    await initMain()
  } else {
    showScreen('register')
  }
  getLocation()
}

function showScreen(name) {
  ['register','login','main'].forEach(s => {
    document.getElementById('screen-' + s).classList.add('hidden')
  })
  document.getElementById('screen-' + name).classList.remove('hidden')
}
function showLogin() { showScreen('login') }
function showRegister() { showScreen('register') }

// ── Register ──────────────────────────────────────────────────────────────────
async function registerWorker() {
  const name = document.getElementById('reg-name').value.trim()
  const phone = document.getElementById('reg-phone').value.trim()
  const pin = document.getElementById('reg-pin').value.trim()
  if (!name || !phone) { showToast('Please enter name and phone', 'error'); return }
  if (pin && pin.length !== 4) { showToast('PIN must be 4 digits', 'error'); return }
  const btn = document.getElementById('reg-btn')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Please wait...'
  try {
    const res = await fetch('/api/workers/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, pin: pin || '0000', device_id: getDeviceId() })
    })
    const data = await res.json()
    if (data.worker) {
      currentWorker = data.worker
      localStorage.setItem('wt_worker', JSON.stringify(data.worker))
      showToast(data.isNew ? 'Registered! Welcome 🎉' : 'Welcome back!', 'success')
      await initMain()
    } else { showToast(data.error || 'Registration failed', 'error') }
  } catch(e) { showToast('Connection error', 'error') }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus mr-2"></i>Get Started'
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function loginWorker() {
  const phone = document.getElementById('login-phone').value.trim()
  if (!phone) { showToast('Enter your phone number', 'error'); return }
  const btn = document.getElementById('login-btn')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Signing in...'
  try {
    const res = await fetch('/api/workers/lookup/' + encodeURIComponent(phone))
    const data = await res.json()
    if (data.worker) {
      currentWorker = data.worker
      localStorage.setItem('wt_worker', JSON.stringify(data.worker))
      showToast('Welcome back, ' + data.worker.name + '!', 'success')
      await initMain()
    } else { showToast('Worker not found. Please register first.', 'error') }
  } catch(e) { showToast('Connection error', 'error') }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>Sign In'
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
  await checkStatus()
  await loadStats()
  await loadWorkLog()
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

  if (isClockedIn) {
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
  }
}

// ── Clock Button Handler ───────────────────────────────────────────────────────
function handleClockBtn() {
  if (!activeSession) {
    openJobModal()  // Show job details form before clocking in
  } else {
    clockOut()      // Clock out directly
  }
}

// ── Job Details Modal ─────────────────────────────────────────────────────────
function openJobModal() {
  const modal = document.getElementById('job-modal')
  modal.classList.remove('hidden')
  // Reset session type to regular on every open
  modal.dataset.sessionType = 'regular'
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
  // Load saved job sites from admin
  loadSavedSitesDropdown()
  setTimeout(() => document.getElementById('job-location-input').focus(), 300)
}

async function loadSavedSitesDropdown() {
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
        ? '<optgroup label="─── Saved Job Sites ───">' +
          sites.map(s => '<option value="' + s.address + '">' + s.name + ' — ' + s.address + '</option>').join('') +
          '</optgroup>'
        : '')
    row.classList.remove('hidden')
  } catch(_) {}
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

  // Normal saved site — fill address as before
  locInput.value = value
  locInput.placeholder = 'Start typing an address...'
  document.getElementById('location-suggestions').classList.add('hidden')
  document.getElementById('job-modal').dataset.sessionType = 'regular'
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
  if (!query || query.length < 4) return []
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=6&addressdetails=1&accept-language=en`
    const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } })
    const data = await res.json()
    return data.map(r => ({
      display: r.display_name,
      short:   [r.address?.road, r.address?.house_number, r.address?.city || r.address?.town || r.address?.village, r.address?.state, r.address?.country_code?.toUpperCase()].filter(Boolean).join(', '),
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon)
    }))
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
  if (!val || val.length < 4) {
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
        session_type: sessionType
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

// ── Clock Out ─────────────────────────────────────────────────────────────────
async function clockOut() {
  const btn = document.getElementById('clock-btn')
  btn.disabled = true
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
      hideAllBanners()
      setClockedInUI(false)
      showToast(`Clocked out! ${hrs}h worked · ${earned} earned 🎉`, 'success')
      await loadStats()
      await loadWorkLog()
    } else { showToast(data.error || 'Failed to clock out', 'error') }
  } catch(e) { showToast('Connection error', 'error') }
  btn.disabled = false
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
  if (!map) {
    map = L.map('map', { zoomControl: true, attributionControl: false })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map)
  }
  map.setView([lat, lng], 16)
  if (marker) marker.remove()
  marker = L.circleMarker([lat, lng], { color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.8, radius: 10 }).addTo(map)
  // Force Leaflet to recalculate size after reveal
  setTimeout(() => { if (map) map.invalidateSize() }, 50)
}

function toggleMap() {
  const wrapper = document.getElementById('map-wrapper')
  const btn = document.getElementById('toggle-map-btn')
  if (!wrapper) return
  if (wrapper.classList.contains('hidden')) {
    wrapper.classList.remove('hidden')
    btn.innerHTML = '<i class="fas fa-map mr-1"></i>Hide Map'
    if (currentLat && currentLng) renderMap(currentLat, currentLng)
  } else {
    closeMap()
  }
}

function closeMap() {
  const wrapper = document.getElementById('map-wrapper')
  const btn = document.getElementById('toggle-map-btn')
  if (wrapper) wrapper.classList.add('hidden')
  if (btn) btn.innerHTML = '<i class="fas fa-map mr-1"></i>View Map'
}

function startPingInterval() {
  clearInterval(pingInterval)
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
        // Session no longer active — was auto-clocked out by server
        clearInterval(watchdogTimer)
        clearInterval(durationTimer)
        clearInterval(pingInterval)
        activeSession = null
        setClockedInUI(false)
        hideAllBanners()
        showToast('You have been automatically clocked out by the system.', 'info')
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

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.className = `fixed bottom-6 left-1/2 transform -translate-x-1/2 px-5 py-3 rounded-xl shadow-xl z-50 text-sm font-medium text-white max-w-xs text-center
    ${type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-green-600' : 'bg-gray-800'}`
  t.classList.remove('hidden')
  setTimeout(() => t.classList.add('hidden'), 4000)
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

