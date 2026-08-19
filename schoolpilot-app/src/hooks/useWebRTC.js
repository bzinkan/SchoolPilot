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

export function useWebRTC(wsSource, onStreamStopped) {
  // Map of authorized studentId -> WebRTC connection. Raw device IDs never
  // cross the teacher-facing WebSocket contract.
  const connectionsRef = useRef(new Map());
  const currentSocket = useCallback(() => wsSource?.current || wsSource || null, [wsSource]);

  // Stop live view for a student
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

      // Failure, track-end, and component-unmount cleanup call this helper
      // without an explicit socket. Use the current hook socket so the student
      // is always told to release capture while signaling remains available.
      const signalingSocket = wsArg || currentSocket();
      if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
        if (connection.negotiationId) {
          signalingSocket.send(JSON.stringify({
            type: 'stop-share',
            studentId,
            teachingSessionId: connection.teachingSessionId,
            negotiationId: connection.negotiationId,
          }));
          console.log(`[WebRTC] Sent stop-share for student ${studentId}`);
        }
      }
    } finally {
      // UI cleanup must still happen if a track, peer, or WebSocket teardown
      // throws; otherwise a frozen MediaStream object can mask signal loss.
      onStreamStopped?.(studentId);
    }
  }, [currentSocket, onStreamStopped]);

  // Start live view for a student
  const startLiveView = useCallback(async (studentId, teachingSessionId, onStreamReceived) => {
    const socket = currentSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
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
      negotiationId: null,
      pendingIce: [],
      onStreamReceived,
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
      const activeSocket = currentSocket();
      if (event.candidate && connection.negotiationId && activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({
          type: 'ice',
          toStudentId: studentId,
          teachingSessionId,
          negotiationId: connection.negotiationId,
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
    try {
      socket.send(JSON.stringify({
        type: 'request-stream',
        studentId,
        teachingSessionId,
      }));
    } catch (error) {
      console.error(`[WebRTC] Could not request stream from ${studentId}:`, error);
      stopLiveView(studentId);
      return null;
    }

    console.log(`[WebRTC] Requested stream from student ${studentId}`);

    return connection;
  }, [currentSocket, stopLiveView]);

  // The server serializes live-view ownership and returns an opaque negotiation
  // token only to the requesting staff user. Do not create an SDP offer before
  // that claim succeeds.
  const handleLiveViewRequested = useCallback(async (
    studentId,
    teachingSessionId,
    negotiationId,
  ) => {
    const connection = connectionsRef.current.get(studentId);
    const socket = currentSocket();
    if (
      !connection
      || connection.teachingSessionId !== teachingSessionId
      || !negotiationId
      || !socket
      || socket.readyState !== WebSocket.OPEN
    ) {
      // A server authorization can arrive after the 12-second UI timeout or a
      // teacher cancellation. Release that exact claim instead of leaving the
      // Chromebook/server busy until token expiry.
      if (negotiationId && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'stop-share',
          studentId,
          teachingSessionId,
          negotiationId,
        }));
      }
      return false;
    }
    if (connection.negotiationId && connection.negotiationId !== negotiationId) {
      socket.send(JSON.stringify({
        type: 'stop-share',
        studentId,
        teachingSessionId,
        negotiationId,
      }));
      return false;
    }
    if (
      connection.negotiationId === negotiationId
      && connection.peerConnection.localDescription
    ) return true;
    connection.negotiationId = negotiationId;

    try {
      const offer = await connection.peerConnection.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: false,
      });
      await connection.peerConnection.setLocalDescription(offer);
      const activeSocket = currentSocket();
      if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
        throw new Error('Teacher signaling connection closed before the offer was sent');
      }
      activeSocket.send(JSON.stringify({
        type: 'offer',
        toStudentId: studentId,
        teachingSessionId,
        negotiationId,
        sdp: connection.peerConnection.localDescription?.toJSON(),
      }));
      console.log(`[WebRTC] Sent offer to student ${studentId}`);
      return true;
    } catch (error) {
      console.error(`[WebRTC] Error creating/sending offer for ${studentId}:`, error);
      stopLiveView(studentId);
      return false;
    }
  }, [currentSocket, stopLiveView]);

  // Handle answer from student
  const handleAnswer = useCallback(async (studentId, sdp, negotiationId) => {
    const connection = connectionsRef.current.get(studentId);
    if (!connection || !negotiationId || connection.negotiationId !== negotiationId) {
      console.error(`[WebRTC] No connection found for ${studentId}`);
      return;
    }

    try {
      await connection.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      while (connection.pendingIce.length > 0) {
        await connection.peerConnection.addIceCandidate(
          new RTCIceCandidate(connection.pendingIce.shift()),
        );
      }
      console.log(`[WebRTC] Set remote description for ${studentId}`);
    } catch (error) {
      console.error(`[WebRTC] Error setting remote description for ${studentId}:`, error);
      stopLiveView(studentId);
    }
  }, [stopLiveView]);

  // Handle ICE candidate from student
  const handleIceCandidate = useCallback(async (studentId, candidate, negotiationId) => {
    const connection = connectionsRef.current.get(studentId);
    if (!connection || !negotiationId || connection.negotiationId !== negotiationId) {
      console.error(`[WebRTC] No connection found for ${studentId}`);
      return;
    }

    try {
      if (!connection.peerConnection.remoteDescription) {
        connection.pendingIce.push(candidate);
        return;
      }
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
    handleLiveViewRequested,
    handleAnswer,
    handleIceCandidate,
    cleanup,
  };
}
