import './style.css'
import AgoraRTC from 'agora-rtc-sdk-ng'

// ── Config ──────────────────────────────────────────────────────────────────
const appId   = import.meta.env.VITE_AGORA_APP_ID
const channel = import.meta.env.VITE_AGORA_CHANNEL || 'main'
const token   = import.meta.env.VITE_AGORA_TOKEN || null

if (!appId) {
  document.querySelector('#app').innerHTML =
    '<div style="color:#f87171;padding:40px;font-family:monospace">Missing VITE_AGORA_APP_ID — check your .env.local file.</div>'
  throw new Error('VITE_AGORA_APP_ID is not set')
}

// ── State ─────────────────────────────────────────────────────────────────────
const participants = new Map() // stringUid -> { name, role }

// ── Agora client ─────────────────────────────────────────────────────────────
const client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' })

let localAudioTrack = null
let localVideoTrack = null
let pollInterval    = null
let myStringUid     = null  // e.g. "Faizan|host"

// ── UID helpers ───────────────────────────────────────────────────────────────
function makeStringUid(name, role) {
  return `${name}|${role}`
}

function parseStringUid(stringUid) {
  const [name, role] = String(stringUid).split('|')
  return { name: name || `UID ${stringUid}`, role: role || 'audience' }
}

// ── DOM ───────────────────────────────────────────────────────────────────────
document.querySelector('#app').innerHTML = `
<div id="agora-app">
  <header id="agora-header">
    <h1>Agora Live Streaming</h1>
  </header>

  <div id="controls">
    <div id="name-input-wrap">
      <input id="input-name" type="text" placeholder="Enter your display name" maxlength="30" />
    </div>

    <div id="role-select">
      <label>
        <input type="radio" name="role" value="host" checked /> Host (streamer)
      </label>
      <label>
        <input type="radio" name="role" value="audience" /> Audience
      </label>
    </div>

    <div id="action-buttons">
      <button id="btn-join"  class="btn btn-primary">Join</button>
      <button id="btn-leave" class="btn btn-danger"  disabled>Leave</button>
    </div>

    <div id="status-bar">
      <span id="status-dot" class="dot disconnected"></span>
      <span id="status-text">Not connected</span>
    </div>
  </div>

  <div id="main-area">
    <div id="video-grid">
      <div id="local-panel" class="video-panel hidden">
        <div class="panel-label" id="local-label">You (local)</div>
        <div id="local-video"></div>
      </div>
    </div>

    <div id="participants-panel">
      <div id="participants-header">
        <span>Participants</span>
        <span id="participants-count" class="count-badge">0</span>
      </div>
      <ul id="participants-list"></ul>
    </div>
  </div>

  <div id="log-panel">
    <div id="log-list"></div>
  </div>
</div>
`

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const el = document.createElement('div')
  el.className = `log-entry log-${type}`
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
  document.getElementById('log-list').prepend(el)
}

function setStatus(text, state) {
  document.getElementById('status-text').textContent = text
  document.getElementById('status-dot').className = `dot ${state}`
}

function setButtonState(joined) {
  document.getElementById('btn-join').disabled   = joined
  document.getElementById('btn-leave').disabled  = !joined
  document.getElementById('input-name').disabled = joined
  document.querySelectorAll('input[name="role"]').forEach(r => r.disabled = joined)
}

function setParticipantsPanelVisible(visible) {
  document.getElementById('participants-panel').style.display = visible ? '' : 'none'
}

function getMyName() {
  const raw = document.getElementById('input-name').value.trim()
  // strip pipe character so it doesn't break our uid encoding
  return raw.replace(/\|/g, '') || `User${Math.floor(Math.random() * 9999)}`
}

// ── Participants panel ────────────────────────────────────────────────────────
function renderParticipants() {
  const list  = document.getElementById('participants-list')
  const count = document.getElementById('participants-count')

  count.textContent = participants.size
  list.innerHTML = ''

  participants.forEach(({ name, role, isMe }) => {
    const li = document.createElement('li')
    li.className = 'participant-item'
    li.innerHTML = `
      <span class="p-avatar">${name.charAt(0).toUpperCase()}</span>
      <span class="p-name">${name}${isMe ? ' (you)' : ''}</span>
      <span class="p-role ${role}">${role}</span>
    `
    list.appendChild(li)
  })
}

function addParticipant(stringUid, isMe = false) {
  const { name, role } = parseStringUid(stringUid)
  participants.set(stringUid, { name, role, isMe })
  renderParticipants()
}

function removeParticipant(stringUid) {
  participants.delete(stringUid)
  renderParticipants()
}

// ── Participant polling ───────────────────────────────────────────────────────
function startPolling() {
  pollInterval = setInterval(() => {
    const remoteUsers   = client.remoteUsers
    const remoteUidStrs = new Set(remoteUsers.map(u => String(u.uid)))

    remoteUsers.forEach(u => {
      const key = String(u.uid)
      if (!participants.has(key)) addParticipant(key)
    })

    participants.forEach((_, key) => {
      if (key !== myStringUid && !remoteUidStrs.has(key)) removeParticipant(key)
    })
  }, 2000)
}

function stopPolling() {
  clearInterval(pollInterval)
  pollInterval = null
}

// ── Join as host ──────────────────────────────────────────────────────────────
async function joinAsHost() {
  const name = getMyName()
  myStringUid = makeStringUid(name, 'host')

  client.setClientRole('host')
  await client.join(appId, channel, token, myStringUid)
  log('Joined channel as host', 'success')

  setParticipantsPanelVisible(true)
  addParticipant(myStringUid, true)
  document.getElementById('local-label').textContent = name

  startPolling()
  await createLocalMediaTracks()
  await publishLocalTracks()
  displayLocalVideo()
}

// ── Join as audience ──────────────────────────────────────────────────────────
async function joinAsAudience() {
  const name = getMyName()
  myStringUid = makeStringUid(name, 'audience')

  client.setClientRole('audience', { level: 2 })
  await client.join(appId, channel, token, myStringUid)
  log('Joined channel as audience', 'success')
}

// ── Local tracks ──────────────────────────────────────────────────────────────
async function createLocalMediaTracks() {
  localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack()
  localVideoTrack = await AgoraRTC.createCameraVideoTrack()
  log('Microphone and camera ready')
}

async function publishLocalTracks() {
  await client.publish([localAudioTrack, localVideoTrack])
  log('Local tracks published')
}

function displayLocalVideo() {
  document.getElementById('local-panel').classList.remove('hidden')
  localVideoTrack.play('local-video')
}

// ── Remote video ──────────────────────────────────────────────────────────────
function displayRemoteVideo(user) {
  const grid = document.getElementById('video-grid')
  const key  = String(user.uid)
  let panel  = document.getElementById(`remote-${key}`)
  if (!panel) {
    panel = document.createElement('div')
    panel.id = `remote-${key}`
    panel.className = 'video-panel'
    const { name } = parseStringUid(key)
    panel.innerHTML = `<div class="panel-label">${name}</div><div id="video-${key}"></div>`
    grid.appendChild(panel)
  }
  user.videoTrack.play(`video-${key}`)
}

// ── Event listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  client.on('user-published', async (user, mediaType) => {
    await client.subscribe(user, mediaType)
    const { name } = parseStringUid(String(user.uid))
    log(`Subscribed to ${mediaType} from ${name}`)

    const key = String(user.uid)
    if (!participants.has(key)) addParticipant(key)

    if (mediaType === 'video') displayRemoteVideo(user)
    if (mediaType === 'audio') user.audioTrack.play()
  })

  client.on('user-unpublished', (user) => {
    const key = String(user.uid)
    const panel = document.getElementById(`remote-${key}`)
    if (panel) panel.remove()
    const { name } = parseStringUid(key)
    log(`${name} stopped publishing`, 'warn')
  })

  client.on('user-left', (user) => {
    const key = String(user.uid)
    const panel = document.getElementById(`remote-${key}`)
    if (panel) panel.remove()
    removeParticipant(key)
    const { name } = parseStringUid(key)
    log(`${name} left the channel`, 'warn')
  })
}

// ── Leave channel ─────────────────────────────────────────────────────────────
async function leaveChannel() {
  if (localAudioTrack) { localAudioTrack.close(); localAudioTrack = null }
  if (localVideoTrack) { localVideoTrack.close(); localVideoTrack = null }

  document.getElementById('local-panel').classList.add('hidden')
  document.querySelectorAll('[id^="remote-"]').forEach(el => el.remove())

  stopPolling()
  participants.clear()
  renderParticipants()
  setParticipantsPanelVisible(false)
  myStringUid = null

  await client.leave()
  log('Left the channel')
}

// ── Button wiring ─────────────────────────────────────────────────────────────
setParticipantsPanelVisible(false)
setupEventListeners()

document.getElementById('btn-join').addEventListener('click', async () => {
  const role = document.querySelector('input[name="role"]:checked').value
  setStatus('Connecting…', 'connecting')
  try {
    if (role === 'host') await joinAsHost()
    else                 await joinAsAudience()

    setStatus(`Connected as ${role}`, 'connected')
    setButtonState(true)
  } catch (err) {
    log(`Join failed: ${err.message}`, 'error')
    setStatus('Connection failed', 'disconnected')
  }
})

document.getElementById('btn-leave').addEventListener('click', async () => {
  try {
    await leaveChannel()
    setStatus('Not connected', 'disconnected')
    setButtonState(false)
    log('Disconnected successfully')
  } catch (err) {
    log(`Leave failed: ${err.message}`, 'error')
  }
})
