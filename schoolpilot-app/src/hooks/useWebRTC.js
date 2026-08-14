import { useRef, useCallback } from 'react';

// ICE servers configuration - STUN for most cases, TURN for restrictive networks
const getIceServers = () => {
  const servers = [
    // Google's public STUN servers (reliable, free)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // Only add TURN servers if credentials are configured
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  if (turnUsername && turnCredential) {
    servers.push({
      username: turnUsername,
      credential: turnCredential,
      urls: [
        'turn:us-turn7.xirsys.com:80?transport=udp',
        'turn:us-turn7.xirsys.com:3478?transport=udp',
        'turn:us-turn7.xirsys.com:80?transport=tcp',
        'turn:us-turn7.xirsys.com:3478?transport=tcp',
        'turns:us-turn7.xirsys.com:443?transport=tcp',
        'turns:us-turn7.xirsys.com:5349?transport=tcp'
      ]
    });
  }

  return servers;
};

const ICE_SERVERS = getIceServers();

export function useWebRTC(ws, onStreamStopped) {
  // Map of authorized studentId -> WebRTC connection. Raw device IDs never
  // cross the teacher-facing WebSocket contract.
  const connectionsRef = useRef(new Map());

  // Stop live view for a student
  // NOTE: The second parameter intentionally shadows the outer `ws` to match
  // ClassPilot's original behavior. When called without a ws argument (e.g. from
  // onconnectionstatechange), no stop-share message is sent.
  const stopLiveView = useCallback((studentId, wsArg) => {
    const connection = connectionsRef.current.get(studentId);
    if (!connection) {
      onStreamStopped?.(studentId);
      return;
    }

    console.log(`[WebRTC] Stopping live view for student ${studentId}`);

    // Remove the connection before closing it. Calling close() transitions the
    // peer to "closed" and may synchronously fire onconnectionstatechange;
    // deleting first prevents a recursive cleanup while still guaranteeing the
    // dashboard is told that this stream is no longer active.
    connectionsRef.current.delete(studentId);
    connection.peerConnection.onconnectionstatechange = null;

    try {
      // Stop all tracks
      if (connection.stream) {
        connection.stream.getTracks().forEach(track => track.stop());
      }

      // Close peer connection
      connection.peerConnection.close();

      // Tell student to stop sharing (only if ws is explicitly provided)
      if (wsArg && wsArg.readyState === WebSocket.OPEN) {
        wsArg.send(JSON.stringify({
          type: 'stop-share',
          studentId,
          teachingSessionId: connection.teachingSessionId,
        }));
        console.log(`[WebRTC] Sent stop-share for student ${studentId}`);
      }
    } finally {
      // UI cleanup must still happen if a track, peer, or WebSocket teardown
      // throws; otherwise a frozen MediaStream object can mask signal loss.
      onStreamStopped?.(studentId);
    }
  }, [onStreamStopped]);

  // Start live view for a student
  const startLiveView = useCallback(async (studentId, teachingSessionId, onStreamReceived) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[WebRTC] WebSocket not connected');
      return null;
    }

    // Guard against double invocation (React StrictMode in dev)
    if (connectionsRef.current.has(studentId)) {
      console.log(`[WebRTC] Already have connection for ${studentId}, skipping`);
      return connectionsRef.current.get(studentId);
    }

    console.log(`[WebRTC] Starting live view for student ${studentId}`);

    // Create peer connection
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const connection = {
      peerConnection: pc,
      stream: null,
      teachingSessionId,
      onStreamReceived
    };

    connectionsRef.current.set(studentId, connection);

    // Handle incoming stream
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received track from ${studentId}:`, event.track.kind);
      const [stream] = event.streams;
      if (stream) {
        connection.stream = stream;
        event.track.onended = () => stopLiveView(studentId);
        onStreamReceived(stream);
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ice',
          toStudentId: studentId,
          teachingSessionId,
          candidate: event.candidate.toJSON(),
        }));
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state for ${studentId}:`, pc.connectionState);
      if (
        pc.connectionState === 'failed'
        || pc.connectionState === 'disconnected'
        || pc.connectionState === 'closed'
      ) {
        stopLiveView(studentId);
      }
    };

    // Request screen share from student
    ws.send(JSON.stringify({
      type: 'request-stream',
      studentId,
      teachingSessionId,
    }));

    console.log(`[WebRTC] Requested stream from student ${studentId}`);

    // Send offer immediately (student will queue it if not ready yet)
    try {
      const offer = await pc.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: false,
      });
      await pc.setLocalDescription(offer);

      ws.send(JSON.stringify({
        type: 'offer',
        toStudentId: studentId,
        teachingSessionId,
        sdp: pc.localDescription?.toJSON(),
      }));

      console.log(`[WebRTC] Sent offer to student ${studentId}`);
    } catch (error) {
      console.error(`[WebRTC] Error creating/sending offer for ${studentId}:`, error);
    }

    return connection;
  }, [ws, stopLiveView]);

  // Handle answer from student
  const handleAnswer = useCallback(async (studentId, sdp) => {
    const connection = connectionsRef.current.get(studentId);
    if (!connection) {
      console.error(`[WebRTC] No connection found for ${studentId}`);
      return;
    }

    try {
      await connection.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      console.log(`[WebRTC] Set remote description for ${studentId}`);
    } catch (error) {
      console.error(`[WebRTC] Error setting remote description for ${studentId}:`, error);
    }
  }, []);

  // Handle ICE candidate from student
  const handleIceCandidate = useCallback(async (studentId, candidate) => {
    const connection = connectionsRef.current.get(studentId);
    if (!connection) {
      console.error(`[WebRTC] No connection found for ${studentId}`);
      return;
    }

    try {
      await connection.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log(`[WebRTC] Added ICE candidate for ${studentId}`);
    } catch (error) {
      console.error(`[WebRTC] Error adding ICE candidate for ${studentId}:`, error);
    }
  }, []);

  // Cleanup all connections
  const cleanup = useCallback(() => {
    console.log('[WebRTC] Cleaning up all connections');
    connectionsRef.current.forEach((_, studentId) => {
      stopLiveView(studentId);
    });
    connectionsRef.current.clear();
  }, [stopLiveView]);

  return {
    startLiveView,
    stopLiveView,
    handleAnswer,
    handleIceCandidate,
    cleanup,
  };
}
