// =============================================
// JamSync - WebRTC Room Logic
// =============================================

(function () {
  'use strict';

  // --- Configuration ---
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
  ];

  // --- Parse URL ---
  const pathParts = window.location.pathname.split('/');
  const roomId = pathParts[pathParts.length - 1];
  const urlParams = new URLSearchParams(window.location.search);
  const username = urlParams.get('username') || 'Anonymous';

  if (!roomId) {
    window.location.href = '/';
    return;
  }

  // --- State ---
  let localStream = null;
  let screenStream = null;
  let isAudioMuted = false;
  let isVideoOff = false;
  let isScreenSharing = false;
  let isChatOpen = false;
  let unreadMessages = 0;

  // Map of peerId -> { connection, dataChannel, username, videoElement }
  const peers = new Map();

  // --- DOM Elements ---
  const localVideo = document.getElementById('local-video');
  const localName = document.getElementById('local-name');
  const localAvatar = document.getElementById('local-avatar');
  const localPlaceholder = document.getElementById('local-placeholder');
  const localIndicators = document.getElementById('local-indicators');
  const videoGrid = document.getElementById('video-grid');
  const roomIdDisplay = document.getElementById('room-id-display');
  const roomIdBadge = document.getElementById('room-id-badge');
  const participantCountText = document.getElementById('participant-count-text');

  const micBtn = document.getElementById('mic-btn');
  const cameraBtn = document.getElementById('camera-btn');
  const screenBtn = document.getElementById('screen-btn');
  const chatBtn = document.getElementById('chat-btn');
  const leaveBtn = document.getElementById('leave-btn');

  const chatPanel = document.getElementById('chat-panel');
  const chatCloseBtn = document.getElementById('chat-close-btn');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send-btn');

  // --- Initialize ---
  roomIdDisplay.textContent = roomId;
  localName.textContent = username;
  localAvatar.textContent = username.charAt(0).toUpperCase();
  document.title = `JamSync | Room ${roomId}`;

  // --- Socket.IO Connection ---
  const socket = io("http://192.168.8.159:3000");
  // --- Get Local Media ---
  async function initLocalStream() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      localVideo.srcObject = localStream;
      showToast('Camera and microphone ready', 'fa-check-circle');
    } catch (err) {
      console.error('Failed to get media:', err);
      showToast('Could not access camera/mic', 'fa-exclamation-triangle');
      // Try audio only
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localVideo.srcObject = localStream;
        isVideoOff = true;
        updateVideoUI();
      } catch (audioErr) {
        console.error('No media devices available:', audioErr);
        // Create empty stream so we can still join
        localStream = new MediaStream();
      }
    }

    // Join the room after getting media
    socket.emit('join-room', { roomId, username });
  }

  // --- WebRTC Peer Connection ---
  function createPeerConnection(peerId, peerUsername, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add local tracks to the connection
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    // ICE candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          to: peerId,
          candidate: event.candidate
        });
      }
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      console.log(`Connection with ${peerUsername}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        removePeer(peerId);
      }
    };

    // Remote track handler
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      if (remoteStream) {
        addRemoteVideo(peerId, peerUsername, remoteStream);
      }
    };

    // Data channel for chat
    if (isInitiator) {
      const dataChannel = pc.createDataChannel('chat', { ordered: true });
      setupDataChannel(dataChannel, peerId, peerUsername);
      peers.get(peerId).dataChannel = dataChannel;
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel, peerId, peerUsername);
        if (peers.has(peerId)) {
          peers.get(peerId).dataChannel = event.channel;
        }
      };
    }

    return pc;
  }

  function setupDataChannel(channel, peerId, peerUsername) {
    channel.onopen = () => {
      console.log(`Data channel open with ${peerUsername}`);
    };

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'chat') {
          addChatMessage(data.username, data.message, false);
        }
      } catch (err) {
        console.error('Failed to parse data channel message:', err);
      }
    };

    channel.onclose = () => {
      console.log(`Data channel closed with ${peerUsername}`);
    };
  }

  // --- Signaling via Socket.IO ---

  // When existing users are already in the room
  socket.on('existing-users', async (users) => {
    console.log('Existing users in room:', users);
    for (const user of users) {
      await connectToPeer(user.userId, user.username, true);
    }
  });

  // When a new user joins
  socket.on('user-joined', async ({ userId, username: peerUsername }) => {
    console.log(`${peerUsername} joined the room`);
    showToast(`${peerUsername} joined the room`, 'fa-user-plus');
    addSystemMessage(`${peerUsername} joined the room`);
    // Wait for them to send us an offer (they are the initiator for existing users)
  });

  // Receive an offer
  socket.on('offer', async ({ from, username: peerUsername, offer }) => {
    console.log(`Received offer from ${peerUsername}`);

    // Create peer connection as answerer
    await connectToPeer(from, peerUsername, false);

    const peer = peers.get(from);
    if (!peer) return;

    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);

      socket.emit('answer', { to: from, answer });
    } catch (err) {
      console.error('Error handling offer:', err);
    }
  });

  // Receive an answer
  socket.on('answer', async ({ from, answer }) => {
    const peer = peers.get(from);
    if (!peer) return;

    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error('Error handling answer:', err);
    }
  });

  // Receive ICE candidate
  socket.on('ice-candidate', async ({ from, candidate }) => {
    const peer = peers.get(from);
    if (!peer) return;

    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  });

  // User left
  socket.on('user-left', ({ userId, username: peerUsername }) => {
    console.log(`${peerUsername} left the room`);
    showToast(`${peerUsername} left the room`, 'fa-user-minus');
    addSystemMessage(`${peerUsername} left the room`);
    removePeer(userId);
  });

  // Fallback chat via server
  socket.on('chat-message', ({ username: senderName, message }) => {
    addChatMessage(senderName, message, false);
  });

  // --- Peer Management ---
  async function connectToPeer(peerId, peerUsername, isInitiator) {
    if (peers.has(peerId)) return;

    // Register peer
    peers.set(peerId, {
      connection: null,
      dataChannel: null,
      username: peerUsername,
      videoElement: null
    });

    const pc = createPeerConnection(peerId, peerUsername, isInitiator);
    peers.get(peerId).connection = pc;

    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { to: peerId, offer });
      } catch (err) {
        console.error('Error creating offer:', err);
      }
    }

    updateParticipantCount();
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;

    // Close connection
    if (peer.connection) {
      peer.connection.close();
    }

    // Remove video tile
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      tile.remove();
    }

    peers.delete(peerId);
    updateParticipantCount();
    updateGridLayout();
  }

  // --- Remote Video ---
  function addRemoteVideo(peerId, peerUsername, stream) {
    // Check if tile already exists
    let tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      const video = tile.querySelector('video');
      if (video) video.srcObject = stream;
      return;
    }

    // Create new tile
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${peerId}`;

    const initial = peerUsername.charAt(0).toUpperCase();

    tile.innerHTML = `
            <video autoplay playsinline></video>
            <div class="video-tile-overlay">
                <div class="video-tile-name">
                    <span>${escapeHtml(peerUsername)}</span>
                </div>
                <div class="video-tile-indicators"></div>
            </div>
            <div class="video-tile-placeholder" style="display: none;">
                <div class="placeholder-avatar">${initial}</div>
                <div class="placeholder-name">Camera Off</div>
            </div>
        `;

    const video = tile.querySelector('video');
    video.srcObject = stream;

    // Save reference
    if (peers.has(peerId)) {
      peers.get(peerId).videoElement = video;
    }

    videoGrid.appendChild(tile);
    updateGridLayout();

    // Animate in
    tile.style.animation = 'fadeInUp 0.4s ease';
  }

  // --- Grid Layout ---
  function updateGridLayout() {
    const count = videoGrid.children.length;
    videoGrid.setAttribute('data-count', Math.min(count, 6));
  }

  function updateParticipantCount() {
    const count = peers.size + 1; // +1 for self
    participantCountText.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
  }

  // --- Media Controls ---

  // Mute/Unmute
  micBtn.addEventListener('click', () => {
    isAudioMuted = !isAudioMuted;

    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !isAudioMuted;
      });
    }

    micBtn.innerHTML = isAudioMuted
      ? '<i class="fas fa-microphone-slash"></i>'
      : '<i class="fas fa-microphone"></i>';

    micBtn.classList.toggle('muted', isAudioMuted);
    updateLocalIndicators();
  });

  // Camera Toggle
  cameraBtn.addEventListener('click', () => {
    isVideoOff = !isVideoOff;

    if (localStream) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = !isVideoOff;
      });
    }

    cameraBtn.innerHTML = isVideoOff
      ? '<i class="fas fa-video-slash"></i>'
      : '<i class="fas fa-video"></i>';

    cameraBtn.classList.toggle('muted', isVideoOff);
    updateVideoUI();
  });

  function updateVideoUI() {
    localPlaceholder.style.display = isVideoOff ? 'flex' : 'none';
    updateLocalIndicators();
  }

  function updateLocalIndicators() {
    let html = '';
    if (isAudioMuted) {
      html += '<div class="indicator" title="Mic Muted"><i class="fas fa-microphone-slash"></i></div>';
    }
    if (isVideoOff) {
      html += '<div class="indicator" title="Camera Off"><i class="fas fa-video-slash"></i></div>';
    }
    localIndicators.innerHTML = html;
  }

  // Screen Share
  screenBtn.addEventListener('click', async () => {
    if (isScreenSharing) {
      stopScreenShare();
      return;
    }

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always'
        },
        audio: false
      });

      const screenTrack = screenStream.getVideoTracks()[0];

      // Replace video track in all peer connections
      peers.forEach((peer) => {
        const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          sender.replaceTrack(screenTrack);
        }
      });

      // Show screen share in local video
      localVideo.srcObject = screenStream;
      isScreenSharing = true;
      screenBtn.classList.add('active');
      screenBtn.innerHTML = '<i class="fas fa-stop"></i>';
      showToast('Screen sharing started', 'fa-desktop');

      // Handle user stopping screen share via browser UI
      screenTrack.onended = () => {
        stopScreenShare();
      };
    } catch (err) {
      console.error('Screen share failed:', err);
      if (err.name !== 'NotAllowedError') {
        showToast('Screen share failed', 'fa-exclamation-triangle');
      }
    }
  });

  function stopScreenShare() {
    if (!isScreenSharing) return;

    // Stop screen tracks
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
    }

    // Replace with camera track
    const videoTrack = localStream ? localStream.getVideoTracks()[0] : null;

    peers.forEach((peer) => {
      const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && videoTrack) {
        sender.replaceTrack(videoTrack);
      }
    });

    // Restore local video
    localVideo.srcObject = localStream;
    isScreenSharing = false;
    screenBtn.classList.remove('active');
    screenBtn.innerHTML = '<i class="fas fa-desktop"></i>';
    showToast('Screen sharing stopped', 'fa-desktop');
  }

  // --- Chat ---
  function toggleChat() {
    isChatOpen = !isChatOpen;
    chatPanel.classList.toggle('hidden', !isChatOpen);
    chatBtn.classList.toggle('active', isChatOpen);

    if (isChatOpen) {
      unreadMessages = 0;
      updateChatBadge();
      chatInput.focus();
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  chatBtn.addEventListener('click', toggleChat);
  chatCloseBtn.addEventListener('click', toggleChat);

  function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message) return;

    // Send via data channels
    const chatData = JSON.stringify({
      type: 'chat',
      username: username,
      message: message
    });

    let sentViaDC = false;
    peers.forEach((peer) => {
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        peer.dataChannel.send(chatData);
        sentViaDC = true;
      }
    });

    // Fallback: send via server if no data channels are open
    if (!sentViaDC && peers.size > 0) {
      socket.emit('chat-message', { roomId, message, username });
    }

    // Show locally
    addChatMessage(username, message, true);
    chatInput.value = '';
  }

  chatSendBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  function addChatMessage(name, message, isSelf) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg';

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgDiv.innerHTML = `
            <div class="chat-msg-header">
                <span class="chat-msg-name" style="${isSelf ? 'color: var(--accent-cyan);' : ''}">${escapeHtml(name)}${isSelf ? ' (You)' : ''}</span>
                <span class="chat-msg-time">${time}</span>
            </div>
            <div class="chat-msg-text">${escapeHtml(message)}</div>
        `;

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (!isSelf && !isChatOpen) {
      unreadMessages++;
      updateChatBadge();
    }
  }

  function addSystemMessage(text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg system';
    msgDiv.innerHTML = `<div class="chat-msg-text">${escapeHtml(text)}</div>`;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function updateChatBadge() {
    const existing = chatBtn.querySelector('.badge');
    if (existing) existing.remove();

    if (unreadMessages > 0 && !isChatOpen) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = unreadMessages > 9 ? '9+' : unreadMessages;
      chatBtn.appendChild(badge);
    }
  }

  // --- Leave Room ---
  leaveBtn.addEventListener('click', () => {
    leaveRoom();
  });

  function leaveRoom() {
    // Stop all local tracks
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
    }

    // Close all peer connections
    peers.forEach((peer, id) => {
      if (peer.connection) peer.connection.close();
    });
    peers.clear();

    // Disconnect socket
    socket.disconnect();

    // Redirect to lobby
    window.location.href = '/';
  }

  // --- Copy Room ID ---
  roomIdBadge.addEventListener('click', () => {
    const fullUrl = window.location.href;
    navigator.clipboard.writeText(fullUrl).then(() => {
      showToast('Room link copied to clipboard!', 'fa-check');
    }).catch(() => {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = fullUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      showToast('Room link copied!', 'fa-check');
    });
  });

  // --- Toast Notifications ---
  function showToast(message, icon = 'fa-info-circle') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i class="fas ${icon}"></i> ${escapeHtml(message)}`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  // --- Utility ---
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // --- Handle page unload ---
  window.addEventListener('beforeunload', () => {
    leaveRoom();
  });

  // --- Start ---
  initLocalStream();

})();
