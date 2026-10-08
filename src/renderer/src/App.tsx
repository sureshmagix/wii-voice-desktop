import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { PeerInfo, DiscoveredRoom, SignalingMessage, Contact, CallHistoryItem, NetworkInterfaceInfo } from '../../protocol/types.ts';
import { AudioEngine } from './webrtc/AudioEngine.ts';
import { MeshCoordinator } from './webrtc/MeshCoordinator.ts';

const myDeviceId = uuidv4();

interface ActiveCallData {
  title: string;
  targetIp: string;
  targetPort: number;
  startedAt: number;
  isHost: boolean;
  isRoom?: boolean;
  isTest?: boolean;
}

interface IncomingCallData {
  callId: string;
  caller: PeerInfo;
  receivedAt: number;
}

interface OutgoingCallData {
  callId: string;
  targetName: string;
  targetIp: string;
  targetPort: number;
  status: 'connecting' | 'ringing' | 'declined';
  startedAt: number;
}

export default function App() {
  // Local identity state
  const [localIp, setLocalIp] = useState<string>('127.0.0.1');
  const [networkInterfaces, setNetworkInterfaces] = useState<NetworkInterfaceInfo[]>([]);
  const [isPluggedIn, setIsPluggedIn] = useState<boolean>(true);
  const [displayName, setDisplayName] = useState<string>(() => {
    return localStorage.getItem('wii_voice_display_name') || `User-${myDeviceId.slice(0, 4)}`;
  });
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(displayName);

  // Navigation tab
  const [activeTab, setActiveTab] = useState<'direct' | 'contacts' | 'rooms' | 'history'>('direct');

  // Direct Call Form state
  const [directName, setDirectName] = useState('');
  const [directIp, setDirectIp] = useState('');
  const [saveToContacts, setSaveToContacts] = useState(true);

  // Address book / Contacts state
  const [contacts, setContacts] = useState<Contact[]>(() => {
    try {
      const saved = localStorage.getItem('wii_voice_contacts');
      return saved ? JSON.parse(saved) : [
        { id: '1', name: 'Workstation 1', ip: '192.168.1.50', port: 5252, updatedAt: Date.now() },
        { id: '2', name: 'Conference Room', ip: '192.168.1.100', port: 5252, updatedAt: Date.now() }
      ];
    } catch {
      return [];
    }
  });
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactIp, setNewContactIp] = useState('');
  const [newContactPort, setNewContactPort] = useState('5252');

  // Call History state
  const [callHistory, setCallHistory] = useState<CallHistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem('wii_voice_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Standby & LAN Rooms state
  const [isStandbyActive, setIsStandbyActive] = useState(false);
  const [standbyPort, setStandbyPort] = useState<number>(5252);
  const [availableRooms, setAvailableRooms] = useState<DiscoveredRoom[]>([]);
  const [roomNameInput, setRoomNameInput] = useState('');

  // Call States: Incoming, Outgoing, Active
  const [incomingCall, setIncomingCall] = useState<IncomingCallData | null>(null);
  const [outgoingCall, setOutgoingCall] = useState<OutgoingCallData | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCallData | null>(null);

  const [participants, setParticipants] = useState<PeerInfo[]>([]);
  const [mutedPeers, setMutedPeers] = useState<Record<string, boolean>>({});
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showMutedSpeakingToast, setShowMutedSpeakingToast] = useState(false);
  const [copiedIp, setCopiedIp] = useState(false);

  // Real-time Audio Level State for Visualizers
  const [localAudioLevel, setLocalAudioLevel] = useState(0);
  const [remoteAudioLevels, setRemoteAudioLevels] = useState<Record<string, number>>({});

  // Call duration counter
  const [callDuration, setCallDuration] = useState(0);

  // Audio Devices & Permissions State
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>(() => {
    return localStorage.getItem('wii_voice_mic_id') || '';
  });
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>(() => {
    return localStorage.getItem('wii_voice_speaker_id') || '';
  });
  const [micPermission, setMicPermission] = useState<'granted' | 'prompt' | 'denied' | 'checking'>('checking');
  const [permissionErrorMsg, setPermissionErrorMsg] = useState<string | null>(null);
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const [isTestingSpeaker, setIsTestingSpeaker] = useState(false);

  // Microphone Voice Clip Test State
  const [isRecordingTestClip, setIsRecordingTestClip] = useState(false);
  const [testRecordingCountdown, setTestRecordingCountdown] = useState(5);
  const [testAudioUrl, setTestAudioUrl] = useState<string | null>(null);
  const [isPlayingTestClip, setIsPlayingTestClip] = useState(false);
  const [testClipDetectedAudio, setTestClipDetectedAudio] = useState<boolean | null>(null);
  const [testMicLevel, setTestMicLevel] = useState<number>(0);

  // Refs
  const socketRef = useRef<WebSocket | null>(null);
  const standbySocketRef = useRef<WebSocket | null>(null);
  const audioEngineRef = useRef<AudioEngine>(new AudioEngine());
  const meshRef = useRef<MeshCoordinator | null>(null);
  const audioMeterIntervalRef = useRef<number | null>(null);
  const callTimerRef = useRef<number | null>(null);
  const mutedToastTimeoutRef = useRef<number | null>(null);
  const activeCallRef = useRef<ActiveCallData | null>(null);
  const incomingCallRef = useRef<IncomingCallData | null>(null);
  const localInfoRef = useRef<PeerInfo | null>(null);
  const selectedSpeakerIdRef = useRef<string>(selectedSpeakerId);

  // Microphone Test Clip Refs
  const testRecorderRef = useRef<MediaRecorder | null>(null);
  const testStreamRef = useRef<MediaStream | null>(null);
  const testAudioElRef = useRef<HTMLAudioElement | null>(null);
  const testTimerRef = useRef<number | null>(null);
  const testLevelIntervalRef = useRef<number | null>(null);
  const testAnalyserRef = useRef<AnalyserNode | null>(null);
  const testAudioContextRef = useRef<AudioContext | null>(null);
  const testMaxLevelRef = useRef<number>(0);

  // Local PeerInfo
  const localInfo = useMemo<PeerInfo>(() => ({
    deviceId: myDeviceId,
    deviceName: displayName,
    platform: 'desktop',
    isPluggedIn,
    lanIp: localIp,
    signalingPort: standbyPort,
    joinedAt: Date.now()
  }), [displayName, isPluggedIn, localIp, standbyPort]);

  activeCallRef.current = activeCall;
  incomingCallRef.current = incomingCall;
  localInfoRef.current = localInfo;
  selectedSpeakerIdRef.current = selectedSpeakerId;

  // Split discovered items into actual Meeting Rooms and Standby Online Peers
  const lanRooms = useMemo(() => {
    return availableRooms.filter(r => r.isRoom && r.roomId !== myDeviceId);
  }, [availableRooms]);

  const discoveredPeers = useMemo(() => {
    return availableRooms.filter(r => !r.isRoom && r.roomId !== myDeviceId);
  }, [availableRooms]);

  // Persist contacts & history
  useEffect(() => {
    localStorage.setItem('wii_voice_contacts', JSON.stringify(contacts));
  }, [contacts]);

  useEffect(() => {
    localStorage.setItem('wii_voice_history', JSON.stringify(callHistory));
  }, [callHistory]);

  // Enumerate audio input and output devices
  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');

      const hasLabels = inputs.some(d => d.label && d.label.length > 0);
      if (hasLabels) {
        setMicPermission('granted');
      }

      setAudioInputs(inputs);
      setAudioOutputs(outputs);

      if (selectedMicId && !inputs.some(d => d.deviceId === selectedMicId)) {
        setSelectedMicId('');
        localStorage.removeItem('wii_voice_mic_id');
      }
      if (selectedSpeakerId && !outputs.some(d => d.deviceId === selectedSpeakerId)) {
        setSelectedSpeakerId('');
        localStorage.removeItem('wii_voice_speaker_id');
      }
    } catch (err) {
      console.warn('Failed to enumerate audio devices:', err);
    }
  }, [selectedMicId, selectedSpeakerId]);

  // Request Microphone Permission explicitly
  const requestMicPermission = useCallback(async (): Promise<boolean> => {
    setPermissionErrorMsg(null);
    try {
      if (window.voiceAPI?.requestMicrophonePermission) {
        const sysStatus = await window.voiceAPI.requestMicrophonePermission();
        if (sysStatus === 'denied') {
          setMicPermission('denied');
          setPermissionErrorMsg(
            'Microphone access is denied in macOS System Settings. Please click "Open System Settings" below to allow WiiVoice.'
          );
          return false;
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
      });
      stream.getTracks().forEach(t => t.stop());
      setMicPermission('granted');
      await refreshDevices();
      return true;
    } catch (err: any) {
      console.warn('Microphone permission request error:', err);
      setMicPermission('denied');
      setPermissionErrorMsg(
        'Microphone permission was denied. Please allow microphone access in system settings to use voice calling.'
      );
      return false;
    }
  }, [refreshDevices, selectedMicId]);

  // Auto re-check microphone permission when window receives focus
  useEffect(() => {
    const handleWindowFocus = async () => {
      if (micPermission !== 'granted' && window.voiceAPI?.getMicrophonePermissionStatus) {
        try {
          const sysStatus = await window.voiceAPI.getMicrophonePermissionStatus();
          if (sysStatus === 'granted') {
            setMicPermission('granted');
            setPermissionErrorMsg(null);
            await refreshDevices();
          }
        } catch {}
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, [micPermission, refreshDevices]);

  // =========================================================================
  // MICROPHONE VOICE CLIP TESTING & RECORDING
  // =========================================================================

  const cleanupTestAudio = useCallback(() => {
    if (testTimerRef.current) {
      clearInterval(testTimerRef.current);
      testTimerRef.current = null;
    }
    if (testLevelIntervalRef.current) {
      clearInterval(testLevelIntervalRef.current);
      testLevelIntervalRef.current = null;
    }
    if (testRecorderRef.current && testRecorderRef.current.state === 'recording') {
      try { testRecorderRef.current.stop(); } catch {}
    }
    testRecorderRef.current = null;

    if (testStreamRef.current) {
      testStreamRef.current.getTracks().forEach(t => t.stop());
      testStreamRef.current = null;
    }

    if (testAudioContextRef.current && testAudioContextRef.current.state !== 'closed') {
      testAudioContextRef.current.close().catch(() => {});
      testAudioContextRef.current = null;
    }
    testAnalyserRef.current = null;

    if (testAudioElRef.current) {
      testAudioElRef.current.pause();
      testAudioElRef.current = null;
    }
    setIsRecordingTestClip(false);
    setIsPlayingTestClip(false);
    setTestMicLevel(0);
  }, []);

  const startTestRecording = async () => {
    cleanupTestAudio();
    if (testAudioUrl) {
      URL.revokeObjectURL(testAudioUrl);
      setTestAudioUrl(null);
    }
    setTestClipDetectedAudio(null);
    testMaxLevelRef.current = 0;

    try {
      if (micPermission !== 'granted') {
        const ok = await requestMicPermission();
        if (!ok) return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true,
        video: false
      });
      testStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      testAudioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      testAnalyserRef.current = analyser;

      testLevelIntervalRef.current = window.setInterval(() => {
        if (testAnalyserRef.current) {
          const data = new Uint8Array(testAnalyserRef.current.frequencyBinCount);
          testAnalyserRef.current.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = sum / (data.length || 1);
          const lvl = Math.min(100, Math.round((avg / 128) * 100));
          setTestMicLevel(lvl);
          if (lvl > testMaxLevelRef.current) {
            testMaxLevelRef.current = lvl;
          }
        }
      }, 50);

      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const supportedType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';
      const recorder = new MediaRecorder(stream, supportedType ? { mimeType: supportedType } : undefined);
      testRecorderRef.current = recorder;
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        if (testLevelIntervalRef.current) {
          clearInterval(testLevelIntervalRef.current);
          testLevelIntervalRef.current = null;
        }
        setTestMicLevel(0);
        const finalBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const url = URL.createObjectURL(finalBlob);
        setTestAudioUrl(url);
        setIsRecordingTestClip(false);
        setTestClipDetectedAudio(testMaxLevelRef.current > 7);

        stream.getTracks().forEach(t => t.stop());
        testStreamRef.current = null;
        if (testAudioContextRef.current && testAudioContextRef.current.state !== 'closed') {
          testAudioContextRef.current.close().catch(() => {});
          testAudioContextRef.current = null;
        }
      };

      recorder.start(100);
      setIsRecordingTestClip(true);
      setTestRecordingCountdown(5);

      let countdown = 5;
      testTimerRef.current = window.setInterval(() => {
        countdown -= 1;
        setTestRecordingCountdown(countdown);
        if (countdown <= 0) {
          if (testTimerRef.current) {
            clearInterval(testTimerRef.current);
            testTimerRef.current = null;
          }
          if (recorder.state === 'recording') {
            recorder.stop();
          }
        }
      }, 1000);

    } catch (err) {
      console.warn('Failed to start test recording:', err);
      setIsRecordingTestClip(false);
      setPermissionErrorMsg('Failed to record from microphone. Please check permissions.');
    }
  };

  const stopTestRecording = () => {
    if (testTimerRef.current) {
      clearInterval(testTimerRef.current);
      testTimerRef.current = null;
    }
    if (testRecorderRef.current && testRecorderRef.current.state === 'recording') {
      testRecorderRef.current.stop();
    }
  };

  const playTestRecording = async () => {
    if (!testAudioUrl) return;
    if (isPlayingTestClip && testAudioElRef.current) {
      testAudioElRef.current.pause();
      setIsPlayingTestClip(false);
      return;
    }

    try {
      const audio = new Audio(testAudioUrl);
      testAudioElRef.current = audio;
      if (selectedSpeakerId && typeof (audio as any).setSinkId === 'function') {
        try {
          await (audio as any).setSinkId(selectedSpeakerId);
        } catch {}
      }
      setIsPlayingTestClip(true);
      audio.onended = () => {
        setIsPlayingTestClip(false);
        testAudioElRef.current = null;
      };
      audio.onerror = () => {
        setIsPlayingTestClip(false);
        testAudioElRef.current = null;
      };
      await audio.play();
    } catch (err) {
      console.warn('Failed to play test recording:', err);
      setIsPlayingTestClip(false);
    }
  };

  useEffect(() => {
    return () => {
      cleanupTestAudio();
    };
  }, [cleanupTestAudio]);

  // Initial permission check and devicechange event listener
  useEffect(() => {
    let isMounted = true;

    const initPermissionsAndDevices = async () => {
      try {
        if (window.voiceAPI?.getMicrophonePermissionStatus) {
          const sysStatus = await window.voiceAPI.getMicrophonePermissionStatus();
          if (!isMounted) return;
          if (sysStatus === 'denied') {
            setMicPermission('denied');
            setPermissionErrorMsg('Microphone access is disabled in system privacy settings.');
          } else if (sysStatus === 'granted') {
            setMicPermission('granted');
          } else {
            setMicPermission('prompt');
          }
        } else if (navigator.permissions?.query) {
          const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          if (!isMounted) return;
          setMicPermission(status.state as any);
          status.onchange = () => {
            if (isMounted) setMicPermission(status.state as any);
          };
        }
      } catch {
        setMicPermission('prompt');
      }

      if (isMounted) {
        await refreshDevices();
      }
    };

    initPermissionsAndDevices();

    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
      return () => {
        isMounted = false;
        navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
      };
    }
    return () => {
      isMounted = false;
    };
  }, [refreshDevices]);

  // Sync configured device IDs with AudioEngine
  useEffect(() => {
    audioEngineRef.current.setConfiguredDevices(selectedMicId, selectedSpeakerId);
  }, [selectedMicId, selectedSpeakerId]);

  // Switch microphone input during or outside call
  const handleMicChange = async (deviceId: string) => {
    setSelectedMicId(deviceId);
    localStorage.setItem('wii_voice_mic_id', deviceId);
    if (audioEngineRef.current) {
      const newTrack = await audioEngineRef.current.setInputDevice(deviceId);
      if (newTrack && meshRef.current) {
        await meshRef.current.replaceAudioTrack(newTrack);
      }
    }
  };

  // Switch speaker output during or outside call
  const handleSpeakerChange = async (deviceId: string) => {
    setSelectedSpeakerId(deviceId);
    localStorage.setItem('wii_voice_speaker_id', deviceId);
    if (audioEngineRef.current) {
      await audioEngineRef.current.setOutputDevice(deviceId);
    }
  };

  // Play speaker test sound
  const handleTestSpeaker = async () => {
    if (isTestingSpeaker) return;
    setIsTestingSpeaker(true);
    try {
      await audioEngineRef.current.playTestTone(selectedSpeakerId);
    } catch (err) {
      console.warn('Test tone error:', err);
    } finally {
      setTimeout(() => setIsTestingSpeaker(false), 700);
    }
  };

  // Compute active microphone and speaker display names
  const currentMicLabel = useMemo(() => {
    if (!selectedMicId) return 'Default Microphone';
    const found = audioInputs.find(d => d.deviceId === selectedMicId);
    return found?.label || 'Microphone (Selected)';
  }, [audioInputs, selectedMicId]);

  const currentSpeakerLabel = useMemo(() => {
    if (!selectedSpeakerId) return 'Default Speaker';
    const found = audioOutputs.find(d => d.deviceId === selectedSpeakerId);
    return found?.label || 'Speaker (Selected)';
  }, [audioOutputs, selectedSpeakerId]);

  // Save display name
  const saveName = () => {
    const trimmed = nameInput.trim();
    if (trimmed) {
      setDisplayName(trimmed);
      localStorage.setItem('wii_voice_display_name', trimmed);
    }
    setIsEditingName(false);
  };

  // Copy IP & Port helper
  const copyCallingAddress = (portToCopy: number = 5252) => {
    const addr = `${localIp}:${portToCopy}`;
    navigator.clipboard.writeText(addr);
    setCopiedIp(true);
    setTimeout(() => setCopiedIp(false), 2000);
  };

  // =========================================================================
  // CENTRALIZED INCOMING CALL HANDLER (DEDUPLICATED & PROMINENT)
  // =========================================================================

  const triggerIncomingCall = useCallback((caller: PeerInfo, callId: string) => {
    // If already in an active call, automatically decline with busy reason
    if (activeCallRef.current) {
      if (standbySocketRef.current?.readyState === WebSocket.OPEN && localInfoRef.current) {
        standbySocketRef.current.send(JSON.stringify({
          type: 'CALL_DECLINED',
          callId,
          recipient: localInfoRef.current,
          reason: 'User is busy on another call'
        }));
      }
      return;
    }

    // Avoid duplicate triggers for the same call
    if (incomingCallRef.current?.callId === callId) {
      return;
    }

    setIncomingCall({
      callId,
      caller,
      receivedAt: Date.now()
    });

    // Ring tone
    audioEngineRef.current.startIncomingRingtone(selectedSpeakerIdRef.current);

    // Make window immediately visible and focused
    if (window.voiceAPI?.bringToFront) {
      window.voiceAPI.bringToFront().catch(() => {});
    } else if (window.voiceAPI?.focusWindow) {
      window.voiceAPI.focusWindow().catch(() => {});
    }

    // Show native system notification
    if (window.voiceAPI?.showIncomingCallNotification) {
      window.voiceAPI.showIncomingCallNotification({
        callerName: caller.deviceName,
        callerIp: caller.lanIp
      }).catch(() => {});
    }

    // Acknowledge with CALL_RINGING to caller
    if (standbySocketRef.current?.readyState === WebSocket.OPEN && localInfoRef.current) {
      standbySocketRef.current.send(JSON.stringify({
        type: 'CALL_RINGING',
        callId,
        recipient: localInfoRef.current
      }));
    }
  }, []);

  // =========================================================================
  // STANDBY SOCKET & AUTO-LISTENING (READY FOR INCOMING DIRECT CALLS)
  // =========================================================================

  const connectStandbySocket = useCallback((port: number): Promise<WebSocket> => {
    return new Promise((resolve) => {
      if (standbySocketRef.current) {
        try { standbySocketRef.current.close(); } catch {}
        standbySocketRef.current = null;
      }

      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        standbySocketRef.current = ws;

        ws.onopen = () => {
          if (localInfoRef.current) {
            ws.send(JSON.stringify({ type: 'JOIN_REQUEST', peer: localInfoRef.current }));
          }
          resolve(ws);
        };

        ws.onmessage = async (evt) => {
          try {
            const msg: SignalingMessage = JSON.parse(String(evt.data));

            if (msg.type === 'CALL_INVITE') {
              triggerIncomingCall(msg.caller, msg.callId);
            } else if (msg.type === 'CALL_CANCELLED') {
              audioEngineRef.current.stopIncomingRingtone();
              window.voiceAPI?.clearNotificationAttention().catch(() => {});

              setIncomingCall(prev => {
                if (prev && prev.callId === msg.callId) {
                  setCallHistory(hist => [
                    {
                      id: uuidv4(),
                      peerName: msg.caller.deviceName,
                      peerIp: msg.caller.lanIp,
                      peerPort: msg.caller.signalingPort,
                      timestamp: Date.now(),
                      durationSeconds: 0,
                      callType: 'direct-incoming',
                      status: 'missed'
                    },
                    ...hist.slice(0, 49)
                  ]);
                  return null;
                }
                return prev;
              });
            } else if (msg.type === 'ROOM_STATE') {
              const currentCall = activeCallRef.current;
              const currentLocal = localInfoRef.current;
              if (currentCall && currentLocal) {
                const uniqueMap = new Map<string, PeerInfo>();
                uniqueMap.set(currentLocal.deviceId, currentLocal);
                msg.peers.forEach((peer) => uniqueMap.set(peer.deviceId, peer));
                setParticipants(Array.from(uniqueMap.values()));
                msg.peers.forEach((peer) => {
                  if (peer.deviceId !== currentLocal.deviceId) {
                    const shouldOffer = currentLocal.deviceId.localeCompare(peer.deviceId) > 0;
                    meshRef.current?.addPeer(peer, shouldOffer);
                  }
                });
              }
            } else if (msg.type === 'SDP_OFFER') {
              await meshRef.current?.handleOffer(msg.from, msg.sdp);
            } else if (msg.type === 'SDP_ANSWER') {
              await meshRef.current?.handleAnswer(msg.from, msg.sdp);
            } else if (msg.type === 'ICE_CANDIDATE') {
              await meshRef.current?.handleCandidate(msg.from, msg.candidate);
            } else if (msg.type === 'CALL_HANGUP') {
              if (activeCallRef.current && !activeCallRef.current.isTest) {
                endCallCleanly(false);
              }
            } else if (msg.type === 'PEER_LEFT') {
              meshRef.current?.dropPeer(msg.peerId);
              setParticipants(prev => {
                const updated = prev.filter(p => p.deviceId !== msg.peerId);
                if (activeCallRef.current && !activeCallRef.current.isTest && !activeCallRef.current.isRoom && updated.length <= 1) {
                  endCallCleanly(false);
                }
                return updated;
              });
            }
          } catch (err) {
            console.warn('Standby socket message parse error:', err);
          }
        };

        ws.onerror = (e) => {
          console.warn('Standby socket connection error:', e);
          resolve(ws);
        };
      } catch (err) {
        console.warn('Could not connect standby socket:', err);
      }
    });
  }, [triggerIncomingCall]);

  // Auto-start Standby Mode on launch so direct calls can be received automatically
  useEffect(() => {
    let isCancelled = false;

    const initNetworkAndStandby = async () => {
      try {
        const ip = await window.voiceAPI.getLocalIp();
        if (!isCancelled) setLocalIp(ip);

        if (window.voiceAPI.getNetworkInterfaces) {
          const ifaces = await window.voiceAPI.getNetworkInterfaces();
          if (!isCancelled) setNetworkInterfaces(ifaces);
        }

        const plugged = await window.voiceAPI.isPluggedIn();
        if (!isCancelled) setIsPluggedIn(plugged);

        // Auto-start hosting on 5252 (isRoom: false indicates standby node, not a meeting room)
        const { port } = await window.voiceAPI.startHosting({
          roomName: `${displayName}'s Standby Node`,
          hostInfo: {
            deviceId: myDeviceId,
            deviceName: displayName,
            platform: 'desktop',
            isPluggedIn: plugged,
            lanIp: ip,
            signalingPort: 5252,
            joinedAt: Date.now()
          },
          preferredPort: 5252,
          isRoom: false
        });

        if (!isCancelled) {
          setStandbyPort(port);
          setIsStandbyActive(true);
          await connectStandbySocket(port);
        }
      } catch (err) {
        console.error('Error starting auto-standby listener:', err);
      }
    };

    initNetworkAndStandby();

    // Listen for room & peer updates from discovery
    const unbindRooms = window.voiceAPI.onRoomsUpdated(setAvailableRooms);

    // Listen for incoming call notifications from IPC directly
    const unbindIncomingCall = window.voiceAPI.onIncomingCall(({ caller, callId }) => {
      triggerIncomingCall(caller, callId);
    });

    return () => {
      isCancelled = true;
      unbindRooms();
      unbindIncomingCall();
      if (!activeCallRef.current && standbySocketRef.current) {
        standbySocketRef.current.close();
        standbySocketRef.current = null;
      }
    };
  }, [displayName, connectStandbySocket, triggerIncomingCall]);

  // Toggle Standby Mode manually if desired
  const toggleStandby = async () => {
    if (isStandbyActive) {
      if (standbySocketRef.current) {
        standbySocketRef.current.close();
        standbySocketRef.current = null;
      }
      await window.voiceAPI.stopHosting();
      setIsStandbyActive(false);
    } else {
      try {
        const { port } = await window.voiceAPI.startHosting({
          roomName: `${displayName}'s Standby Node`,
          hostInfo: localInfo,
          preferredPort: 5252,
          isRoom: false
        });
        setStandbyPort(port);
        setIsStandbyActive(true);
        await connectStandbySocket(port);
      } catch (err) {
        console.error('Could not start Standby Mode:', err);
        setConnectionError('Could not start Standby listener on port 5252.');
      }
    }
  };

  // =========================================================================
  // CUTTING / DECLINING / ANSWERING CALLS
  // =========================================================================

  // PROVISION TO CUT INCOMING CALL (DECLINE)
  const declineIncomingCall = useCallback(() => {
    if (!incomingCall) return;
    audioEngineRef.current.stopIncomingRingtone();
    audioEngineRef.current.playCallDeclinedTone(selectedSpeakerId);
    window.voiceAPI?.clearNotificationAttention().catch(() => {});

    // Notify caller that call was declined
    if (standbySocketRef.current?.readyState === WebSocket.OPEN) {
      standbySocketRef.current.send(JSON.stringify({
        type: 'CALL_DECLINED',
        callId: incomingCall.callId,
        recipient: localInfo,
        reason: 'Call declined by user'
      }));
    }

    setCallHistory(prev => [
      {
        id: uuidv4(),
        peerName: incomingCall.caller.deviceName,
        peerIp: incomingCall.caller.lanIp,
        peerPort: incomingCall.caller.signalingPort,
        timestamp: Date.now(),
        durationSeconds: 0,
        callType: 'direct-incoming',
        status: 'declined'
      },
      ...prev.slice(0, 49)
    ]);

    setIncomingCall(null);
  }, [incomingCall, localInfo, selectedSpeakerId]);

  // ANSWER INCOMING CALL
  const answerIncomingCall = useCallback(async () => {
    if (!incomingCall) return;
    audioEngineRef.current.stopIncomingRingtone();
    window.voiceAPI?.clearNotificationAttention().catch(() => {});

    const caller = incomingCall.caller;
    const callId = incomingCall.callId;
    setIncomingCall(null);

    if (micPermission !== 'granted') {
      const ok = await requestMicPermission();
      if (!ok) {
        setConnectionError('Microphone permission required to answer call.');
        return;
      }
    }

    try {
      setIsConnecting(true);
      const stream = await audioEngineRef.current.getLocalStream(selectedMicId);

      const sendSignaling = (msg: SignalingMessage) => {
        if (standbySocketRef.current?.readyState === WebSocket.OPEN) {
          standbySocketRef.current.send(JSON.stringify(msg));
        }
      };

      const mesh = new MeshCoordinator(
        localInfo,
        sendSignaling,
        (peerId, remoteStream) => audioEngineRef.current.attachRemoteStream(peerId, remoteStream),
        (peerId) => {
          audioEngineRef.current.detachRemoteStream(peerId);
          setParticipants(prev => prev.filter(p => p.deviceId !== peerId));
        },
        (peerId, peerIsMuted) => {
          setMutedPeers(prev => ({ ...prev, [peerId]: peerIsMuted }));
        }
      );

      meshRef.current = mesh;
      mesh.setLocalStream(stream);

      // Notify caller that call was accepted
      if (standbySocketRef.current?.readyState === WebSocket.OPEN) {
        standbySocketRef.current.send(JSON.stringify({
          type: 'CALL_ACCEPTED',
          callId,
          recipient: localInfo
        }));
      }

      socketRef.current = standbySocketRef.current;
      setActiveCall({
        title: caller.deviceName,
        targetIp: caller.lanIp,
        targetPort: caller.signalingPort,
        startedAt: Date.now(),
        isHost: true,
        isRoom: false
      });

      setParticipants([localInfo, caller]);
      setIsConnecting(false);

      // Callee is the answerer in direct 1-to-1 call; do NOT initiate offer
      mesh.addPeer(caller, false);
    } catch (err) {
      console.error('Failed to answer incoming call:', err);
      setIsConnecting(false);
      setConnectionError('Microphone access is required to answer call.');
    }
  }, [incomingCall, localInfo, micPermission, requestMicPermission, selectedMicId]);

  // PROVISION TO CUT OUTGOING CALL (CANCEL WHILE RINGING)
  const cancelOutgoingCall = useCallback(() => {
    if (!outgoingCall) return;
    audioEngineRef.current.stopOutgoingRingtone();

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'CALL_CANCELLED',
        callId: outgoingCall.callId,
        caller: localInfo
      }));
      socketRef.current.close();
    }
    socketRef.current = null;

    setCallHistory(prev => [
      {
        id: uuidv4(),
        peerName: outgoingCall.targetName,
        peerIp: outgoingCall.targetIp,
        peerPort: outgoingCall.targetPort,
        timestamp: Date.now(),
        durationSeconds: 0,
        callType: 'direct-outgoing',
        status: 'missed'
      },
      ...prev.slice(0, 49)
    ]);

    setOutgoingCall(null);
  }, [outgoingCall, localInfo]);

  // PROVISION TO CUT ACTIVE LIVE CALL (HANG UP / LEAVE ROOM)
  const endCallCleanly = useCallback(async (notifyPeer: boolean = true) => {
    audioEngineRef.current.stopIncomingRingtone();
    audioEngineRef.current.stopOutgoingRingtone();
    audioEngineRef.current.playCallEndTone(selectedSpeakerId);
    window.voiceAPI?.clearNotificationAttention().catch(() => {});

    const prevCall = activeCall;
    const duration = callDuration;

    if (prevCall && !prevCall.isTest) {
      const historyEntry: CallHistoryItem = {
        id: uuidv4(),
        peerName: prevCall.title,
        peerIp: prevCall.targetIp,
        peerPort: prevCall.targetPort,
        timestamp: Date.now(),
        durationSeconds: duration,
        callType: prevCall.isRoom ? (prevCall.isHost ? 'hosted-room' : 'joined-room') : (prevCall.isHost ? 'direct-incoming' : 'direct-outgoing'),
        status: duration > 0 ? 'completed' : 'failed'
      };
      setCallHistory(prev => [historyEntry, ...prev.slice(0, 49)]);
    }

    // Send CALL_HANGUP or PEER_LEFT to peer if we are initiating the cut
    if (notifyPeer && socketRef.current?.readyState === WebSocket.OPEN && localInfoRef.current) {
      try {
        if (prevCall?.isRoom) {
          socketRef.current.send(JSON.stringify({
            type: 'PEER_LEFT',
            peerId: localInfoRef.current.deviceId
          }));
        } else {
          socketRef.current.send(JSON.stringify({
            type: 'CALL_HANGUP',
            callId: 'call-ended',
            peerId: localInfoRef.current.deviceId,
            reason: 'Call cut by user'
          }));
        }
      } catch {}
    }

    if (socketRef.current !== standbySocketRef.current) {
      socketRef.current?.close();
      socketRef.current = null;
    }

    meshRef.current?.cleanup();
    meshRef.current = null;
    audioEngineRef.current.cleanup();

    setActiveCall(null);
    setOutgoingCall(null);
    setIncomingCall(null);
    setParticipants([]);
    setMutedPeers({});
    setIsMuted(false);
    setIsDeafened(false);
    setIsConnecting(false);
    setShowDiagnostics(false);
    setShowMutedSpeakingToast(false);

    // If we were hosting a room, restart in Standby mode (isRoom: false)
    if (prevCall?.isRoom && prevCall.isHost) {
      try {
        const { port } = await window.voiceAPI.startHosting({
          roomName: `${displayName}'s Standby Node`,
          hostInfo: localInfoRef.current || localInfo,
          preferredPort: 5252,
          isRoom: false
        });
        setStandbyPort(port);
        setIsStandbyActive(true);
        await connectStandbySocket(port);
      } catch (err) {
        console.warn('Error resetting to standby after room end:', err);
      }
    } else {
      // Ensure standby socket is active for future calls
      if (isStandbyActive && (!standbySocketRef.current || standbySocketRef.current.readyState !== WebSocket.OPEN)) {
        await connectStandbySocket(standbyPort);
      }
    }
  }, [activeCall, callDuration, isStandbyActive, standbyPort, selectedSpeakerId, displayName, localInfo, connectStandbySocket]);

  // =========================================================================
  // MAKING DIRECT OUTGOING CALLS
  // =========================================================================

  const startDirectActiveCall = async (
    ws: WebSocket,
    targetIp: string,
    targetPort: number,
    callTitle: string,
    remotePeerInfo: PeerInfo
  ) => {
    try {
      const stream = await audioEngineRef.current.getLocalStream(selectedMicId);

      const sendSignaling = (msg: SignalingMessage) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      };

      const mesh = new MeshCoordinator(
        localInfo,
        sendSignaling,
        (peerId, remoteStream) => audioEngineRef.current.attachRemoteStream(peerId, remoteStream),
        (peerId) => {
          audioEngineRef.current.detachRemoteStream(peerId);
          setParticipants(prev => prev.filter(p => p.deviceId !== peerId));
        },
        (peerId, peerIsMuted) => {
          setMutedPeers(prev => ({ ...prev, [peerId]: peerIsMuted }));
        }
      );

      meshRef.current = mesh;
      mesh.setLocalStream(stream);

      setActiveCall({
        title: callTitle,
        targetIp,
        targetPort,
        startedAt: Date.now(),
        isHost: false,
        isRoom: false
      });

      setParticipants([localInfo, remotePeerInfo]);
      setIsConnecting(false);

      // Caller adds remote peer and initiates WebRTC offer
      mesh.addPeer(remotePeerInfo, true);
    } catch (err) {
      console.error('Error starting direct call audio:', err);
      endCallCleanly();
      setConnectionError('Microphone access is required for voice calling.');
    }
  };

  const handleDirectCall = async (targetIpStr?: string, targetNameStr?: string) => {
    const rawIp = (targetIpStr || directIp).trim();
    const name = (targetNameStr || directName).trim() || `Host-${rawIp.replace(/[^0-9]/g, '').slice(-4) || 'LAN'}`;
    if (!rawIp || isConnecting || outgoingCall || activeCall) return;

    let targetIp = rawIp;
    let targetPort = 5252;
    if (rawIp.includes(':')) {
      const parts = rawIp.split(':');
      targetIp = parts[0].trim();
      targetPort = parseInt(parts[1], 10) || 5252;
    }

    if (saveToContacts) {
      const exists = contacts.some(c => c.ip === targetIp && c.port === targetPort);
      if (!exists) {
        setContacts(prev => [
          { id: uuidv4(), name, ip: targetIp, port: targetPort, updatedAt: Date.now() },
          ...prev
        ]);
      }
    }

    if (micPermission !== 'granted') {
      const ok = await requestMicPermission();
      if (!ok) {
        setConnectionError('Microphone permission is required to make voice calls.');
        return;
      }
    }

    setConnectionError(null);
    const callId = uuidv4();

    setOutgoingCall({
      callId,
      targetName: name,
      targetIp,
      targetPort,
      status: 'connecting',
      startedAt: Date.now()
    });

    // Start playing soft outgoing ringback tone
    audioEngineRef.current.startOutgoingRingtone(selectedSpeakerId);

    try {
      const ws = new WebSocket(`ws://${targetIp}:${targetPort}`);
      socketRef.current = ws;

      ws.onopen = () => {
        setOutgoingCall(prev => prev ? { ...prev, status: 'ringing' } : null);
        ws.send(JSON.stringify({
          type: 'CALL_INVITE',
          callId,
          caller: localInfo
        }));
      };

      ws.onerror = () => {
        audioEngineRef.current.stopOutgoingRingtone();
        audioEngineRef.current.playCallDeclinedTone(selectedSpeakerId);
        setOutgoingCall(null);
        setConnectionError(`Could not reach ${targetIp}:${targetPort}. Make sure Wii Voice is open on their device.`);
      };

      ws.onclose = () => {
        audioEngineRef.current.stopOutgoingRingtone();
        if (activeCall) {
          endCallCleanly();
        } else if (outgoingCall) {
          setOutgoingCall(null);
        }
      };

      ws.onmessage = async (evt) => {
        try {
          const msg: SignalingMessage = JSON.parse(String(evt.data));
          switch (msg.type) {
            case 'CALL_RINGING':
              setOutgoingCall(prev => prev ? { ...prev, status: 'ringing' } : null);
              break;
            case 'CALL_DECLINED':
              audioEngineRef.current.stopOutgoingRingtone();
              audioEngineRef.current.playCallDeclinedTone(selectedSpeakerId);
              setConnectionError(`Call was cut/declined by ${name}.`);
              setCallHistory(prev => [
                {
                  id: uuidv4(),
                  peerName: name,
                  peerIp: targetIp,
                  peerPort: targetPort,
                  timestamp: Date.now(),
                  durationSeconds: 0,
                  callType: 'direct-outgoing',
                  status: 'declined'
                },
                ...prev.slice(0, 49)
              ]);
              setOutgoingCall(null);
              break;
            case 'CALL_ACCEPTED': {
              audioEngineRef.current.stopOutgoingRingtone();
              setOutgoingCall(null);
              await startDirectActiveCall(ws, targetIp, targetPort, name, msg.recipient);
              break;
            }
            case 'ROOM_STATE': {
              if (outgoingCall) {
                audioEngineRef.current.stopOutgoingRingtone();
                setOutgoingCall(null);
                const foundPeer = msg.peers.find(p => p.deviceId !== localInfo.deviceId) || {
                  deviceId: 'remote-peer',
                  deviceName: name,
                  platform: 'desktop',
                  isPluggedIn: true,
                  lanIp: targetIp,
                  signalingPort: targetPort,
                  joinedAt: Date.now()
                };
                await startDirectActiveCall(ws, targetIp, targetPort, name, foundPeer);
              }
              break;
            }
            case 'SDP_OFFER':
              await meshRef.current?.handleOffer(msg.from, msg.sdp);
              break;
            case 'SDP_ANSWER':
              await meshRef.current?.handleAnswer(msg.from, msg.sdp);
              break;
            case 'ICE_CANDIDATE':
              await meshRef.current?.handleCandidate(msg.from, msg.candidate);
              break;
            case 'CALL_HANGUP':
              endCallCleanly(false);
              break;
            case 'PEER_LEFT':
              meshRef.current?.dropPeer(msg.peerId);
              setParticipants(prev => {
                const updated = prev.filter(p => p.deviceId !== msg.peerId);
                if (activeCallRef.current && !activeCallRef.current.isTest && updated.length <= 1) {
                  endCallCleanly(false);
                }
                return updated;
              });
              break;
          }
        } catch (err) {
          console.error('Signaling error:', err);
        }
      };
    } catch (err) {
      audioEngineRef.current.stopOutgoingRingtone();
      setOutgoingCall(null);
      setConnectionError(`Unable to start call to ${targetIp}:${targetPort}.`);
    }
  };

  // Call from Saved Contacts or Discovered Peer
  const callContact = async (c: { name: string; ip: string; port: number }) => {
    if (activeCall || outgoingCall || incomingCall) return;
    setDirectName(c.name);
    setDirectIp(`${c.ip}:${c.port}`);
    await handleDirectCall(`${c.ip}:${c.port}`, c.name);
  };

  // Add Contact Manually
  const handleAddContactSubmit = () => {
    const name = newContactName.trim();
    const ip = newContactIp.trim();
    const port = parseInt(newContactPort.trim(), 10) || 5252;
    if (!name || !ip) return;

    setContacts(prev => [
      { id: uuidv4(), name, ip, port, updatedAt: Date.now() },
      ...prev
    ]);

    setNewContactName('');
    setNewContactIp('');
    setNewContactPort('5252');
    setShowAddContactModal(false);
  };

  // Delete Contact
  const deleteContact = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setContacts(prev => prev.filter(c => c.id !== id));
  };

  // Save Discovered Peer as Contact
  const saveDiscoveredPeerAsContact = (peer: DiscoveredRoom, e: React.MouseEvent) => {
    e.stopPropagation();
    const exists = contacts.some(c => c.ip === peer.hostIp && c.port === peer.hostPort);
    if (!exists) {
      setContacts(prev => [
        { id: uuidv4(), name: peer.hostName, ip: peer.hostIp, port: peer.hostPort, updatedAt: Date.now() },
        ...prev
      ]);
    }
  };

  // =========================================================================
  // LANDROOM: HOSTING & JOINING MULTI-PARTY LAN MEETING ROOMS
  // =========================================================================

  // Host a LAN Meeting Room
  const startHostedRoom = async () => {
    const roomName = roomNameInput.trim() || `${displayName}'s Meeting`;
    if (isConnecting || activeCall || outgoingCall || incomingCall) return;

    if (micPermission !== 'granted') {
      const ok = await requestMicPermission();
      if (!ok) {
        setConnectionError('Microphone permission required to host room.');
        return;
      }
    }

    setIsConnecting(true);
    setConnectionError(null);

    try {
      const { port } = await window.voiceAPI.startHosting({
        roomName,
        hostInfo: localInfo,
        preferredPort: 5252,
        isRoom: true
      });
      setStandbyPort(port);

      // Reconnect standby socket to the freshly created room signaling server
      const ws = await connectStandbySocket(port);
      socketRef.current = ws;

      const stream = await audioEngineRef.current.getLocalStream(selectedMicId);
      const mesh = new MeshCoordinator(
        localInfo,
        (msg) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
          }
        },
        (peerId, remoteStream) => audioEngineRef.current.attachRemoteStream(peerId, remoteStream),
        (peerId) => {
          audioEngineRef.current.detachRemoteStream(peerId);
          setParticipants(prev => prev.filter(p => p.deviceId !== peerId));
        },
        (peerId, peerIsMuted) => {
          setMutedPeers(prev => ({ ...prev, [peerId]: peerIsMuted }));
        }
      );
      meshRef.current = mesh;
      mesh.setLocalStream(stream);

      setActiveCall({
        title: roomName,
        targetIp: localInfo.lanIp,
        targetPort: port,
        startedAt: Date.now(),
        isHost: true,
        isRoom: true
      });

      setParticipants([localInfo]);
      setIsConnecting(false);
      setRoomNameInput('');
    } catch (err) {
      console.error('Unable to host room:', err);
      setIsConnecting(false);
      setConnectionError('Unable to host room on this network interface.');
    }
  };

  // Join a Discovered LAN Meeting Room directly via JOIN_REQUEST
  const joinDiscoveredRoom = async (room: DiscoveredRoom) => {
    if (activeCall || outgoingCall || incomingCall || isConnecting) return;

    if (micPermission !== 'granted') {
      const ok = await requestMicPermission();
      if (!ok) {
        setConnectionError('Microphone permission required to join room.');
        return;
      }
    }

    setIsConnecting(true);
    setConnectionError(null);

    try {
      const ws = new WebSocket(`ws://${room.hostIp}:${room.hostPort}`);
      socketRef.current = ws;

      ws.onopen = async () => {
        // Send JOIN_REQUEST to join room as participant
        ws.send(JSON.stringify({
          type: 'JOIN_REQUEST',
          peer: localInfo
        }));

        try {
          const stream = await audioEngineRef.current.getLocalStream(selectedMicId);
          const mesh = new MeshCoordinator(
            localInfo,
            (msg) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msg));
              }
            },
            (peerId, remoteStream) => audioEngineRef.current.attachRemoteStream(peerId, remoteStream),
            (peerId) => {
              audioEngineRef.current.detachRemoteStream(peerId);
              setParticipants(prev => prev.filter(p => p.deviceId !== peerId));
            },
            (peerId, peerIsMuted) => {
              setMutedPeers(prev => ({ ...prev, [peerId]: peerIsMuted }));
            }
          );
          meshRef.current = mesh;
          mesh.setLocalStream(stream);

          setActiveCall({
            title: room.roomName,
            targetIp: room.hostIp,
            targetPort: room.hostPort,
            startedAt: Date.now(),
            isHost: false,
            isRoom: true
          });

          setIsConnecting(false);
        } catch (err) {
          console.error('Error starting audio when joining room:', err);
          setIsConnecting(false);
          setConnectionError('Microphone access is required to join room.');
          ws.close();
        }
      };

      ws.onerror = () => {
        setIsConnecting(false);
        setConnectionError(`Could not connect to room at ${room.hostIp}:${room.hostPort}.`);
      };

      ws.onclose = () => {
        if (activeCallRef.current) {
          endCallCleanly(false);
        }
      };

      ws.onmessage = async (evt) => {
        try {
          const msg: SignalingMessage = JSON.parse(String(evt.data));
          if (msg.type === 'ROOM_STATE') {
            const currentLocal = localInfoRef.current;
            if (currentLocal) {
              const uniqueMap = new Map<string, PeerInfo>();
              uniqueMap.set(currentLocal.deviceId, currentLocal);
              msg.peers.forEach((peer) => uniqueMap.set(peer.deviceId, peer));
              setParticipants(Array.from(uniqueMap.values()));
              msg.peers.forEach((peer) => {
                if (peer.deviceId !== currentLocal.deviceId) {
                  const shouldOffer = currentLocal.deviceId.localeCompare(peer.deviceId) > 0;
                  meshRef.current?.addPeer(peer, shouldOffer);
                }
              });
            }
          } else if (msg.type === 'SDP_OFFER') {
            await meshRef.current?.handleOffer(msg.from, msg.sdp);
          } else if (msg.type === 'SDP_ANSWER') {
            await meshRef.current?.handleAnswer(msg.from, msg.sdp);
          } else if (msg.type === 'ICE_CANDIDATE') {
            await meshRef.current?.handleCandidate(msg.from, msg.candidate);
          } else if (msg.type === 'PEER_LEFT') {
            meshRef.current?.dropPeer(msg.peerId);
            setParticipants(prev => prev.filter(p => p.deviceId !== msg.peerId));
          } else if (msg.type === 'CALL_HANGUP') {
            endCallCleanly(false);
          }
        } catch (err) {
          console.warn('Room message parse error:', err);
        }
      };
    } catch (err) {
      setIsConnecting(false);
      setConnectionError(`Failed to connect to ${room.hostIp}:${room.hostPort}.`);
    }
  };

  // =========================================================================
  // AUDIO ECHO TEST
  // =========================================================================

  const startEchoTest = async () => {
    if (activeCall || outgoingCall || incomingCall) return;
    setConnectionError(null);
    setIsConnecting(true);

    if (micPermission !== 'granted') {
      const ok = await requestMicPermission();
      if (!ok) {
        setIsConnecting(false);
        setConnectionError('Microphone permission required for Audio Test.');
        return;
      }
    }

    try {
      await audioEngineRef.current.getLocalStream(selectedMicId);
      setIsConnecting(false);
      setActiveCall({
        title: 'Voice Call UI & Audio Preview (Echo Test)',
        targetIp: localIp,
        targetPort: 5252,
        startedAt: Date.now(),
        isHost: true,
        isTest: true
      });
      setParticipants([
        localInfo,
        {
          deviceId: 'preview-bot-id',
          deviceName: 'Echo Test Simulator',
          platform: 'desktop',
          isPluggedIn: true,
          lanIp: '127.0.0.1',
          signalingPort: 5252,
          joinedAt: Date.now()
        }
      ]);
    } catch (err) {
      setIsConnecting(false);
      setConnectionError('Microphone permission required for Audio Test.');
    }
  };

  // Toggle Microphone Mute
  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    audioEngineRef.current.setMicrophoneMute(next);
    meshRef.current?.broadcastMute(next);
    if (!next) setShowMutedSpeakingToast(false);
  };

  // Toggle Deafen / Speaker Mute
  const toggleDeafen = () => {
    const next = !isDeafened;
    setIsDeafened(next);
    audioEngineRef.current.setDeafened(next);
  };

  // Real-time audio VU meter polling
  useEffect(() => {
    const checkAudioLevels = () => {
      if (audioEngineRef.current) {
        const localLvl = audioEngineRef.current.getLocalAudioLevel();
        setLocalAudioLevel(localLvl);

        if (isMuted && localLvl > 12) {
          setShowMutedSpeakingToast(true);
          if (mutedToastTimeoutRef.current) clearTimeout(mutedToastTimeoutRef.current);
          mutedToastTimeoutRef.current = window.setTimeout(() => {
            setShowMutedSpeakingToast(false);
          }, 3000);
        }

        if (activeCall && !activeCall.isTest) {
          const levels: Record<string, number> = {};
          participants.forEach(p => {
            if (p.deviceId !== localInfo.deviceId) {
              levels[p.deviceId] = audioEngineRef.current.getRemoteAudioLevel(p.deviceId);
            }
          });
          setRemoteAudioLevels(levels);
        }
      }
    };

    audioMeterIntervalRef.current = window.setInterval(checkAudioLevels, 50);
    return () => {
      if (audioMeterIntervalRef.current) clearInterval(audioMeterIntervalRef.current);
    };
  }, [isMuted, activeCall, participants, localInfo.deviceId]);

  // Call duration counter effect
  useEffect(() => {
    if (activeCall) {
      setCallDuration(0);
      callTimerRef.current = window.setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    } else {
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
        callTimerRef.current = null;
      }
      setCallDuration(0);
    }
    return () => {
      if (callTimerRef.current) clearInterval(callTimerRef.current);
    };
  }, [activeCall]);

  // Global Keyboard shortcuts:
  // [Enter] to answer incoming call
  // [Esc] to decline incoming call, cancel outgoing call, or cut active call
  // [M] to mute/unmute
  // [D] to deafen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'Enter' && incomingCall) {
        e.preventDefault();
        answerIncomingCall();
      } else if (e.key === 'Escape') {
        if (incomingCall) {
          e.preventDefault();
          declineIncomingCall();
        } else if (outgoingCall) {
          e.preventDefault();
          cancelOutgoingCall();
        } else if (activeCall) {
          e.preventDefault();
          endCallCleanly(true);
        } else if (showDiagnostics) {
          setShowDiagnostics(false);
        } else if (showAudioSettings) {
          setShowAudioSettings(false);
        } else if (showAddContactModal) {
          setShowAddContactModal(false);
        }
      } else if ((e.key === 'm' || e.key === 'M') && activeCall) {
        e.preventDefault();
        toggleMute();
      } else if ((e.key === 'd' || e.key === 'D') && activeCall) {
        e.preventDefault();
        toggleDeafen();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [incomingCall, outgoingCall, activeCall, showDiagnostics, showAudioSettings, showAddContactModal, answerIncomingCall, declineIncomingCall, cancelOutgoingCall, endCallCleanly]);

  // Format Duration seconds to MM:SS or HH:MM:SS
  const formatDuration = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Helper for 5-bar dynamic voice visualizer
  const renderWaveformBars = (level: number) => {
    const normalized = Math.min(100, Math.max(0, level));
    const factor = normalized / 100;
    const heights = [
      Math.max(4, Math.round(10 + factor * 22)),
      Math.max(4, Math.round(14 + factor * 30)),
      Math.max(6, Math.round(20 + factor * 36)),
      Math.max(4, Math.round(14 + factor * 28)),
      Math.max(4, Math.round(8 + factor * 18))
    ];

    return (
      <div className="waveform-container">
        {heights.map((h, i) => (
          <div key={i} className="wave-bar" style={{ height: `${h}px` }} />
        ))}
      </div>
    );
  };

  const remotePeer = useMemo(() => {
    return participants.find(p => p.deviceId !== localInfo.deviceId) || null;
  }, [participants, localInfo.deviceId]);

  const remotePeerSpeaking = remotePeer
    ? (remoteAudioLevels[remotePeer.deviceId] || 0) > 10
    : activeCall?.isTest ? localAudioLevel > 10 : false;

  const remotePeerMuted = remotePeer ? !!mutedPeers[remotePeer.deviceId] : false;

  return (
    <div className="app-container">
      {/* ====================================================================
          INCOMING CALL NOTIFICATION: FULL SCREEN BLURRED MODAL
         ==================================================================== */}
      {incomingCall && (
        <div className="incoming-call-overlay">
          <div className="incoming-call-card">
            <div className="incoming-badge-pill">
              <span className="standby-dot" style={{ backgroundColor: '#10b981', boxShadow: '0 0 10px #10b981' }} />
              <span>Incoming Voice Call</span>
            </div>

            <div className="incoming-avatar-container">
              <div className="incoming-pulse-ring" />
              <div className="incoming-pulse-ring-2" />
              <div className="incoming-avatar">
                {incomingCall.caller.deviceName.slice(0, 2).toUpperCase()}
              </div>
            </div>

            <div className="incoming-caller-info">
              <div className="incoming-caller-name">{incomingCall.caller.deviceName}</div>
              <div className="incoming-caller-ip">
                {incomingCall.caller.lanIp}:{incomingCall.caller.signalingPort}
              </div>
            </div>

            <div style={{ fontSize: '0.82rem', color: '#94a3b8' }}>
              Ringing... Press <kbd style={{ background: '#1e293b', padding: '2px 6px', borderRadius: '4px', border: '1px solid #475569' }}>Enter</kbd> to Answer or <kbd style={{ background: '#1e293b', padding: '2px 6px', borderRadius: '4px', border: '1px solid #475569' }}>Esc</kbd> to Decline
            </div>

            <div className="incoming-actions-row">
              {/* DECLINE / CUT CALL BUTTON */}
              <button
                className="call-btn-decline"
                onClick={declineIncomingCall}
                title="Decline Call (Shortcut: [Esc])"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/>
                  <line x1="23" y1="1" x2="1" y2="23"/>
                </svg>
                <span>Decline [Esc]</span>
              </button>

              {/* ANSWER CALL BUTTON */}
              <button
                className="call-btn-answer"
                onClick={answerIncomingCall}
                title="Answer Call (Shortcut: [Enter])"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
                <span>Answer [Enter]</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          OUTGOING CALL RINGING OVERLAY
         ==================================================================== */}
      {outgoingCall && (
        <div className="incoming-call-overlay">
          <div className="outgoing-call-card">
            <div className="incoming-badge-pill" style={{ background: 'rgba(56, 189, 248, 0.15)', borderColor: 'rgba(56, 189, 248, 0.4)', color: '#38bdf8' }}>
              <span className="standby-dot" style={{ backgroundColor: '#38bdf8', boxShadow: '0 0 8px #38bdf8' }} />
              <span>{outgoingCall.status === 'ringing' ? 'Ringing Remote Peer...' : 'Connecting...'}</span>
            </div>

            <div className="incoming-avatar-container">
              <div className="outgoing-pulse-ring" />
              <div className="incoming-avatar" style={{ background: 'linear-gradient(135deg, #2563eb, #38bdf8)' }}>
                {outgoingCall.targetName.slice(0, 2).toUpperCase()}
              </div>
            </div>

            <div className="incoming-caller-info">
              <div className="incoming-caller-name">{outgoingCall.targetName}</div>
              <div className="incoming-caller-ip">
                {outgoingCall.targetIp}:{outgoingCall.targetPort}
              </div>
            </div>

            <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
              {outgoingCall.status === 'ringing' ? 'Waiting for recipient to answer...' : 'Establishing direct LAN peer connection...'}
            </div>

            {/* CANCEL / CUT CALL BUTTON */}
            <button
              className="call-btn-decline"
              style={{ width: '100%', maxWidth: '240px', marginTop: '10px' }}
              onClick={cancelOutgoingCall}
              title="Cancel Call (Shortcut: [Esc])"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/>
                <line x1="23" y1="1" x2="1" y2="23"/>
              </svg>
              <span>Cancel Call [Esc]</span>
            </button>
          </div>
        </div>
      )}

      {/* ====================================================================
          SIDEBAR
         ==================================================================== */}
      <div className="sidebar">
        {/* Branding */}
        <div className="brand-header">
          <div className="brand-logo">
            <div className="brand-icon-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" x2="12" y1="19" y2="22"/>
              </svg>
            </div>
            <span>WII VOICE</span>
          </div>
          <span className="brand-tag">Offline LAN</span>
        </div>

        {/* Local Profile / Identity Card */}
        <div className="profile-card">
          <div className="profile-user-row">
            <div className="profile-avatar">
              {displayName.slice(0, 2).toUpperCase()}
            </div>
            <div className="profile-details">
              {isEditingName ? (
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input
                    type="text"
                    value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveName()}
                    autoFocus
                    style={{
                      background: '#0a0f1d',
                      border: '1px solid #38bdf8',
                      color: '#fff',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '0.85rem'
                    }}
                  />
                  <button onClick={saveName} style={{ padding: '2px 8px', fontSize: '0.75rem' }}>Save</button>
                </div>
              ) : (
                <div className="profile-name-row">
                  <span className="profile-name-text" title={displayName}>{displayName}</span>
                  <button className="edit-btn" onClick={() => setIsEditingName(true)} title="Edit Display Name">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 20h9"/>
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                  </button>
                </div>
              )}
              <div
                className="profile-ip-badge"
                onClick={() => copyCallingAddress(standbyPort)}
                title="Click to copy calling address (IP:Port)"
              >
                <span>{localIp}:{standbyPort}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                {copiedIp && <span style={{ color: '#10b981', fontSize: '0.65rem' }}>Copied!</span>}
              </div>
            </div>
          </div>

          <div className="profile-status-bar">
            <span>{isPluggedIn ? '⚡ AC Power' : '🔋 Battery'}</span>
            <div className="standby-indicator" onClick={toggleStandby} style={{ cursor: 'pointer' }}>
              <div className="standby-dot" style={{ backgroundColor: isStandbyActive ? '#10b981' : '#64748b', boxShadow: isStandbyActive ? '0 0 8px #10b981' : 'none' }} />
              <span>{isStandbyActive ? 'Ready (Standby)' : 'Standby Off'}</span>
            </div>
          </div>
        </div>

        {/* Audio Devices & Configuration Summary Card */}
        <div
          className="audio-devices-card"
          onClick={() => setShowAudioSettings(true)}
          title="Click to configure microphone and speaker"
        >
          <div className="audio-devices-row">
            <div className="audio-devices-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
            </div>
            <div className="audio-devices-meta">
              <div className="audio-devices-title">Audio Devices</div>
              <div className="audio-devices-desc" title={`Mic: ${currentMicLabel} • Speaker: ${currentSpeakerLabel}`}>
                {currentMicLabel}
              </div>
            </div>
            <button
              className="icon-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowAudioSettings(true);
              }}
              title="Configure Audio Devices"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Live Mic VU Monitor in Sidebar */}
        <div className="mic-monitor-card">
          <div className="mic-monitor-header">
            <span>Microphone Input</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                style={{
                  background: 'rgba(56, 189, 248, 0.15)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  color: '#38bdf8',
                  fontSize: '0.68rem',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
                onClick={() => setShowAudioSettings(true)}
                title="Test your microphone with a voice clip"
              >
                Test Mic
              </button>
              <span style={{ color: isMuted ? '#ef4444' : '#10b981' }}>
                {isMuted ? 'Muted' : `${localAudioLevel}%`}
              </span>
            </div>
          </div>
          <div className="mic-level-track">
            <div className="mic-level-fill" style={{ width: `${isMuted ? 0 : localAudioLevel}%` }} />
          </div>
        </div>

        {/* Navigation Tabs (Direct, Contacts, LAN Rooms, History) */}
        <div className="nav-tabs">
          <button
            className={`nav-tab-btn ${activeTab === 'direct' ? 'active' : ''}`}
            onClick={() => setActiveTab('direct')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
            <span>Direct</span>
          </button>
          <button
            className={`nav-tab-btn ${activeTab === 'contacts' ? 'active' : ''}`}
            onClick={() => setActiveTab('contacts')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <span>Contacts</span>
          </button>
          <button
            className={`nav-tab-btn ${activeTab === 'rooms' ? 'active' : ''}`}
            onClick={() => setActiveTab('rooms')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="2" x2="22" y1="12" y2="12"/>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
            <span>Rooms</span>
          </button>
          <button
            className={`nav-tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            <span>History</span>
          </button>
        </div>

        {/* Sidebar Body */}
        <div className="sidebar-body">
          {connectionError && (
            <div style={{
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              color: '#fca5a5',
              borderRadius: '8px',
              padding: '10px 12px',
              fontSize: '0.8rem',
              lineHeight: 1.4
            }}>
              {connectionError}
            </div>
          )}

          {activeTab === 'direct' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
                Quick Saved Contacts
              </div>
              {contacts.length === 0 ? (
                <div style={{ color: '#64748b', fontSize: '0.82rem' }}>No contacts saved yet.</div>
              ) : (
                contacts.slice(0, 4).map(c => (
                  <div key={c.id} className="contact-card" style={{ padding: '8px 12px' }}>
                    <div className="contact-info">
                      <div className="contact-avatar" style={{ width: '32px', height: '32px', fontSize: '0.8rem' }}>
                        {c.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="contact-meta">
                        <div className="contact-name" style={{ fontSize: '0.82rem' }}>{c.name}</div>
                        <div className="contact-ip" style={{ fontSize: '0.7rem' }}>{c.ip}:{c.port}</div>
                      </div>
                    </div>
                    <button
                      className="quick-call-btn"
                      disabled={isConnecting || !!activeCall || !!outgoingCall}
                      onClick={() => callContact(c)}
                      title={`Call ${c.name}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'contacts' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
                  Contacts ({contacts.length})
                </span>
                <button
                  className="quick-call-btn"
                  style={{ width: '24px', height: '24px', borderRadius: '4px' }}
                  onClick={() => setShowAddContactModal(true)}
                  title="Add New Contact"
                >
                  +
                </button>
              </div>
              {contacts.map(c => (
                <div key={c.id} className="contact-card" style={{ padding: '8px 10px' }}>
                  <div className="contact-info">
                    <div className="contact-avatar" style={{ width: '30px', height: '30px', fontSize: '0.75rem' }}>
                      {c.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="contact-meta">
                      <div className="contact-name" style={{ fontSize: '0.8rem' }}>{c.name}</div>
                      <div className="contact-ip" style={{ fontSize: '0.68rem' }}>{c.ip}:{c.port}</div>
                    </div>
                  </div>
                  <div className="contact-actions">
                    <button className="quick-call-btn" onClick={() => callContact(c)} title="Call">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                      </svg>
                    </button>
                    <button className="icon-action-btn" onClick={(e) => deleteContact(c.id, e)} title="Remove contact">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18"/>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'rooms' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
                Discovered LAN Meetings ({lanRooms.length})
              </div>
              {lanRooms.length === 0 ? (
                <div style={{ color: '#64748b', fontSize: '0.8rem' }}>No meeting rooms hosted on LAN right now...</div>
              ) : (
                lanRooms.map(room => (
                  <div key={room.roomId} className="contact-card" style={{ padding: '10px' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{room.roomName}</div>
                      <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                        Host: {room.hostName} ({room.hostIp}:{room.hostPort})
                      </div>
                    </div>
                    <button
                      className="call-btn"
                      style={{ padding: '6px 12px', fontSize: '0.78rem' }}
                      disabled={isConnecting || !!activeCall || !!outgoingCall}
                      onClick={() => joinDiscoveredRoom(room)}
                    >
                      Join
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
                  Call History ({callHistory.length})
                </span>
                {callHistory.length > 0 && (
                  <button
                    style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '0.7rem', cursor: 'pointer' }}
                    onClick={() => setCallHistory([])}
                  >
                    Clear
                  </button>
                )}
              </div>
              {callHistory.slice(0, 10).map(h => (
                <div key={h.id} className="contact-card" style={{ padding: '8px 10px' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.8rem' }}>{h.peerName}</div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>
                      {h.status.toUpperCase()} • {formatDuration(h.durationSeconds)}
                    </div>
                  </div>
                  <button
                    className="quick-call-btn"
                    onClick={() => handleDirectCall(`${h.peerIp}:${h.peerPort}`, h.peerName)}
                    title="Redial"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ====================================================================
          MAIN DASHBOARD (When not in call)
         ==================================================================== */}
      {!activeCall && (
        <div className="content">
          <div className="dashboard-container">
            {/* Hero Header */}
            <div className="dashboard-hero">
              <div className="dashboard-title-group">
                <h1>Peer-to-Peer Voice Calling</h1>
                <p>Offline LAN voice calls and multi-party meeting rooms with zero external internet required.</p>
              </div>

              {/* Instant Call UI Preview Button */}
              <button className="echo-test-btn" onClick={startEchoTest} title="Preview the call UI and test your mic">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                <span>Preview Call UI / Echo Test</span>
              </button>
            </div>

            {/* Microphone Permission Required Alert Banner */}
            {micPermission !== 'granted' && (
              <div className={`permission-alert-banner ${micPermission === 'denied' ? 'denied' : 'prompt'}`}>
                <div className="permission-alert-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="22"/>
                  </svg>
                </div>
                <div className="permission-alert-content">
                  <div className="permission-alert-title">
                    {micPermission === 'denied' ? 'Microphone Permission Denied' : 'Microphone Access Required'}
                  </div>
                  <div className="permission-alert-desc">
                    {permissionErrorMsg || 'Wii Voice requires microphone access to transmit audio during peer-to-peer LAN calls.'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                  {micPermission === 'denied' && (
                    <button
                      className="permission-grant-btn"
                      style={{ background: '#3b82f6', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.4)' }}
                      onClick={() => window.voiceAPI?.openSystemMicrophoneSettings()}
                      title="Open macOS Privacy & Security Settings directly"
                    >
                      <span>⚙️ System Settings</span>
                    </button>
                  )}
                  <button className="permission-grant-btn" onClick={requestMicPermission}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    <span>{micPermission === 'denied' ? 'Retry' : 'Grant Access'}</span>
                  </button>
                </div>
              </div>
            )}

            {/* Direct Dial by Name & IP Panel */}
            <div className="panel">
              <div className="panel-title">
                <span className="panel-title-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                  </svg>
                </span>
                <span>Direct Voice Call by Name & IP Address</span>
              </div>

              <div className="direct-dial-form">
                <div className="input-row">
                  {/* Recipient Name */}
                  <div className="input-field-group">
                    <label>Recipient / Peer Name</label>
                    <div className="input-wrapper">
                      <span className="input-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                          <circle cx="12" cy="7" r="4"/>
                        </svg>
                      </span>
                      <input
                        type="text"
                        placeholder="e.g. Alice's MacBook, Office PC..."
                        value={directName}
                        onChange={e => setDirectName(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Destination IP Address & Port */}
                  <div className="input-field-group">
                    <label>Target IP Address (Port optional: default 5252)</label>
                    <div className="input-wrapper">
                      <span className="input-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
                          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
                          <line x1="6" y1="6" x2="6.01" y2="6"/>
                          <line x1="6" y1="18" x2="6.01" y2="18"/>
                        </svg>
                      </span>
                      <input
                        type="text"
                        placeholder="e.g. 192.168.1.100 or 192.168.1.100:5252"
                        value={directIp}
                        onChange={e => setDirectIp(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleDirectCall()}
                      />
                    </div>
                  </div>
                </div>

                <div className="form-actions-row">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={saveToContacts}
                      onChange={e => setSaveToContacts(e.target.checked)}
                    />
                    <span>Save to Address Book for 1-click calls</span>
                  </label>

                  <button
                    className="call-btn"
                    disabled={isConnecting || !directIp.trim()}
                    onClick={() => handleDirectCall()}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                    </svg>
                    <span>{isConnecting ? 'Connecting…' : 'Start Voice Call'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Discovered Online Peers on LAN */}
            {discoveredPeers.length > 0 && (
              <div className="panel">
                <div className="panel-title">
                  <span className="panel-title-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                  </span>
                  <span>Discovered Online Devices on LAN ({discoveredPeers.length})</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '10px' }}>
                  {discoveredPeers.map(peer => (
                    <div key={peer.roomId} className="contact-card" style={{ padding: '12px' }}>
                      <div className="contact-info">
                        <div className="contact-avatar" style={{ width: '36px', height: '36px' }}>
                          {peer.hostName.slice(0, 2).toUpperCase()}
                        </div>
                        <div className="contact-meta">
                          <div className="contact-name" style={{ fontSize: '0.9rem' }}>{peer.hostName}</div>
                          <div className="contact-ip">{peer.hostIp}:{peer.hostPort}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          className="quick-call-btn"
                          style={{ width: '32px', height: '32px' }}
                          onClick={() => handleDirectCall(`${peer.hostIp}:${peer.hostPort}`, peer.hostName)}
                          title={`Call ${peer.hostName}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                          </svg>
                        </button>
                        <button
                          className="icon-action-btn"
                          onClick={(e) => saveDiscoveredPeerAsContact(peer, e)}
                          title="Save as contact"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                            <polyline points="17 21 17 13 7 13 7 21"/>
                            <polyline points="7 3 7 8 15 8"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Standby / Share Calling Info Banner */}
            <div className="standby-banner">
              <div className="standby-banner-text">
                <div className="standby-banner-title">
                  <div className="standby-dot" style={{ backgroundColor: isStandbyActive ? '#10b981' : '#f59e0b' }} />
                  <span>
                    {isStandbyActive
                      ? `Ready to receive calls at: ${localIp}:${standbyPort}`
                      : `Receive Calls Mode (Standby listener on port ${standbyPort})`}
                  </span>
                </div>
                <div className="standby-banner-desc">
                  Share your Name <strong>({displayName})</strong> and IP <strong>({localIp}:{standbyPort})</strong> with anyone on this LAN to receive direct calls.
                  {networkInterfaces.length > 1 && (
                    <div style={{ marginTop: '4px', fontSize: '0.72rem', color: '#94a3b8' }}>
                      Detected Interfaces: {networkInterfaces.map(n => `${n.name} (${n.address})`).join(', ')}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="dock-btn"
                  style={{ padding: '8px 14px', fontSize: '0.8rem' }}
                  onClick={() => copyCallingAddress(standbyPort)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  <span>{copiedIp ? 'Copied!' : 'Copy Calling Address'}</span>
                </button>
                <button
                  className="call-btn"
                  style={{
                    padding: '8px 16px',
                    fontSize: '0.8rem',
                    background: isStandbyActive ? '#334155' : 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                    boxShadow: isStandbyActive ? 'none' : '0 4px 15px rgba(37, 99, 235, 0.4)'
                  }}
                  onClick={toggleStandby}
                >
                  {isStandbyActive ? 'Restart Standby' : 'Start Standby Listener'}
                </button>
              </div>
            </div>

            {/* Landroom: Host Multi-Party LAN Meeting Room */}
            <div className="panel">
              <div className="panel-title">
                <span className="panel-title-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                  </svg>
                </span>
                <span>Host Multi-Party LAN Room (Landroom)</span>
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <div className="input-wrapper" style={{ flex: 1 }}>
                  <input
                    type="text"
                    placeholder="Meeting Room Name (e.g. Team Standup, Design Review)..."
                    value={roomNameInput}
                    onChange={e => setRoomNameInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && startHostedRoom()}
                  />
                </div>
                <button
                  className="call-btn"
                  disabled={isConnecting}
                  onClick={startHostedRoom}
                >
                  Create & Host Room
                </button>
              </div>

              {/* Discovered LAN Rooms to Join */}
              {lanRooms.length > 0 && (
                <div style={{ marginTop: '14px' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8', marginBottom: '8px' }}>
                    Active LAN Meeting Rooms on Local Network:
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {lanRooms.map(room => (
                      <div key={room.roomId} className="contact-card" style={{ padding: '10px 14px' }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>{room.roomName}</div>
                          <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                            Hosted by <strong>{room.hostName}</strong> ({room.hostIp}:{room.hostPort})
                          </div>
                        </div>
                        <button
                          className="call-btn"
                          style={{ padding: '8px 16px', fontSize: '0.85rem' }}
                          onClick={() => joinDiscoveredRoom(room)}
                        >
                          Join Room
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Recent Calls History Preview */}
            {callHistory.length > 0 && (
              <div className="panel">
                <div className="panel-title">
                  <span className="panel-title-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                  </span>
                  <span>Recent Calls</span>
                </div>
                <div className="history-list">
                  {callHistory.slice(0, 5).map(h => (
                    <div key={h.id} className="history-item">
                      <div className="history-left">
                        <div className="history-icon-badge" style={{
                          background: h.status === 'declined' ? 'rgba(239, 68, 68, 0.15)' : h.status === 'missed' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(56, 189, 248, 0.15)'
                        }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={h.status === 'declined' ? '#ef4444' : h.status === 'missed' ? '#f59e0b' : '#38bdf8'} strokeWidth="2">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                          </svg>
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.88rem' }}>
                            {h.peerName}
                            <span style={{
                              marginLeft: '8px',
                              fontSize: '0.68rem',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: h.status === 'completed' ? 'rgba(16, 185, 129, 0.15)' : h.status === 'declined' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                              color: h.status === 'completed' ? '#10b981' : h.status === 'declined' ? '#ef4444' : '#f59e0b'
                            }}>
                              {h.status.toUpperCase()}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                            {h.peerIp}:{h.peerPort} • {new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • Duration: {formatDuration(h.durationSeconds)}
                          </div>
                        </div>
                      </div>
                      <button
                        className="quick-call-btn"
                        onClick={() => handleDirectCall(`${h.peerIp}:${h.peerPort}`, h.peerName)}
                        title={`Redial ${h.peerName}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ====================================================================
          ACTIVE CALL SCREEN
         ==================================================================== */}
      {activeCall && (
        <div className="active-call-viewport">
          {/* Top Bar Header */}
          <div className="call-header">
            <div className="call-header-left">
              <div className="live-beacon">
                <div className="beacon-pulse" />
                <span>{activeCall.isTest ? 'ECHO PREVIEW' : activeCall.isRoom ? 'LAN ROOM' : 'LIVE LAN P2P'}</span>
              </div>
              <div className="call-target-title">
                <span className="call-target-name">{activeCall.title}</span>
                <span className="call-target-ip-badge">{activeCall.targetIp}:{activeCall.targetPort}</span>
              </div>
            </div>

            <div className="call-header-center">
              <div className="call-timer-badge">
                {formatDuration(callDuration)}
              </div>
            </div>

            <div className="call-header-right">
              <div className="audio-codec-pill">Opus 48kHz • LAN Direct</div>
              <button
                className="dock-btn"
                style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                onClick={() => setShowDiagnostics(prev => !prev)}
                title="View Network & Call Diagnostics"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="16" x2="12" y2="12"/>
                  <line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <span>Stats</span>
              </button>
            </div>
          </div>

          {/* Speaking While Muted Warning Toast */}
          {showMutedSpeakingToast && (
            <div className="muted-warning-toast" role="alert">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="1" y1="1" x2="23" y2="23"/>
                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
              </svg>
              <span>Your microphone is muted. Click "Unmute" or press [M] to talk.</span>
            </div>
          )}

          {/* Call Main Stage */}
          <div className="call-stage">
            {/* If 1-on-1 Direct Call or Echo Test */}
            {participants.length <= 2 && !activeCall.isRoom ? (
              <div className="focal-peer-container">
                <div className="focal-avatar-wrapper">
                  <div className={`avatar-halo-ring ${remotePeerSpeaking ? 'speaking' : ''}`} />
                  <div className={`focal-avatar ${remotePeerSpeaking ? 'speaking' : ''}`}>
                    {remotePeer ? remotePeer.deviceName.slice(0, 2).toUpperCase() : activeCall.title.slice(0, 2).toUpperCase()}
                  </div>
                </div>

                {/* Animated Voice Waveform Visualizer */}
                {renderWaveformBars(remotePeerSpeaking ? (activeCall.isTest ? localAudioLevel : (remotePeer ? remoteAudioLevels[remotePeer.deviceId] || 25 : 20)) : 0)}

                <div className="focal-info">
                  <div className="focal-peer-name">
                    {remotePeer ? remotePeer.deviceName : activeCall.title}
                  </div>
                  <div className="focal-peer-ip">
                    {remotePeer ? `${remotePeer.lanIp}:${remotePeer.signalingPort || activeCall.targetPort}` : `${activeCall.targetIp}:${activeCall.targetPort}`}
                  </div>
                  <div className={`focal-peer-status-tag ${remotePeerMuted ? 'muted' : remotePeerSpeaking ? 'speaking' : 'silent'}`}>
                    {remotePeerMuted ? (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="1" y1="1" x2="23" y2="23"/>
                          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
                        </svg>
                        <span>Muted</span>
                      </>
                    ) : remotePeerSpeaking ? (
                      <>
                        <span className="standby-dot" />
                        <span>Speaking</span>
                      </>
                    ) : (
                      <span>Connected</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* Multi-Peer Grid for larger meetings or Landroom */
              <div className="call-grid">
                {participants.map(peer => {
                  const isLocal = peer.deviceId === localInfo.deviceId;
                  const isPeerSpeaking = isLocal
                    ? !isMuted && localAudioLevel > 10
                    : (remoteAudioLevels[peer.deviceId] || 0) > 10;
                  const peerMuted = isLocal ? isMuted : !!mutedPeers[peer.deviceId];

                  return (
                    <div key={peer.deviceId} className={`peer-grid-card ${isPeerSpeaking ? 'speaking' : ''}`}>
                      <div className="peer-grid-avatar">
                        {peer.deviceName.slice(0, 2).toUpperCase()}
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontWeight: 700, fontSize: '1.05rem', color: '#fff' }}>
                          {peer.deviceName} {isLocal && '(You)'}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: '#38bdf8', fontFamily: 'monospace' }}>
                          {peer.lanIp}
                        </div>
                      </div>

                      {renderWaveformBars(isPeerSpeaking ? (isLocal ? localAudioLevel : remoteAudioLevels[peer.deviceId] || 20) : 0)}

                      <div className={`focal-peer-status-tag ${peerMuted ? 'muted' : isPeerSpeaking ? 'speaking' : 'silent'}`}>
                        {peerMuted ? 'Muted' : isPeerSpeaking ? 'Speaking' : 'Connected'}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Local User Picture-In-Picture Mini Card */}
            {participants.length <= 2 && !activeCall.isRoom && (
              <div className="local-pip-card">
                <div className={`pip-avatar ${!isMuted && localAudioLevel > 10 ? 'speaking' : ''}`}>
                  {displayName.slice(0, 2).toUpperCase()}
                </div>
                <div className="pip-details">
                  <div className="pip-name">{displayName} (You)</div>
                  <div className="pip-status">
                    <span style={{ color: isMuted ? '#ef4444' : '#10b981' }}>
                      {isMuted ? 'Muted' : 'Mic Active'}
                    </span>
                    <span>• {localIp}</span>
                  </div>
                  {renderWaveformBars(!isMuted ? localAudioLevel : 0)}
                </div>
              </div>
            )}
          </div>

          {/* ==================================================================
              IN-CALL LIVE AUDIO DEVICE SELECTOR BAR
             ================================================================== */}
          <div className="in-call-device-bar">
            {/* Live Microphone Switcher */}
            <div className="in-call-device-item">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
              <span>Mic:</span>
              <select
                className="in-call-select"
                value={selectedMicId}
                onChange={e => handleMicChange(e.target.value)}
                title="Change microphone during live call"
              >
                <option value="">Default Microphone</option>
                {audioInputs.map((input, idx) => (
                  <option key={input.deviceId || idx} value={input.deviceId}>
                    {input.label || `Microphone ${idx + 1}`}
                  </option>
                ))}
              </select>
            </div>

            {/* Live Speaker Switcher */}
            <div className="in-call-device-item">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
              </svg>
              <span>Speaker:</span>
              <select
                className="in-call-select"
                value={selectedSpeakerId}
                onChange={e => handleSpeakerChange(e.target.value)}
                title="Change speaker during live call"
              >
                <option value="">Default Speaker</option>
                {audioOutputs.map((output, idx) => (
                  <option key={output.deviceId || idx} value={output.deviceId}>
                    {output.label || `Speaker ${idx + 1}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`in-call-test-btn ${isTestingSpeaker ? 'playing' : ''}`}
                onClick={handleTestSpeaker}
                title="Test speaker output sound"
              >
                {isTestingSpeaker ? 'Testing...' : 'Test'}
              </button>
            </div>
          </div>

          {/* ==================================================================
              FLOATING FROSTED DOCK (Call Control Center)
             ================================================================== */}
          <div className="call-control-dock">
            {/* MIC MUTE / UNMUTE BUTTON */}
            <div className="mic-control-group">
              <button
                className={`dock-btn mute-btn ${isMuted ? 'is-muted' : ''}`}
                onClick={toggleMute}
                title="Toggle Microphone Mute (Shortcut: [M])"
              >
                {isMuted ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="1" y1="1" x2="23" y2="23"/>
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
                    <line x1="12" y1="19" x2="12" y2="22"/>
                    <line x1="8" y1="22" x2="16" y2="22"/>
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="22"/>
                    <line x1="8" y1="22" x2="16" y2="22"/>
                  </svg>
                )}
                <span>{isMuted ? 'Unmute Mic' : 'Mute Mic'}</span>
                <span className="shortcut-hint">[M]</span>
              </button>

              {/* Real-time mini VU level bar */}
              <div className="dock-vu-meter" title={`Live Mic Level: ${isMuted ? 0 : localAudioLevel}%`}>
                <div className="dock-vu-fill" style={{ width: `${isMuted ? 0 : localAudioLevel}%` }} />
              </div>
            </div>

            {/* DEAFEN / SPEAKER MUTE BUTTON */}
            <button
              className={`dock-btn deafen-btn ${isDeafened ? 'is-deafened' : ''}`}
              onClick={toggleDeafen}
              title="Toggle Deafen / Speaker Mute (Shortcut: [D])"
            >
              {isDeafened ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <line x1="1" y1="1" x2="23" y2="23"/>
                  <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 14.34-7.2"/>
                  <path d="M21 14a9 9 0 0 0-.8-3.7"/>
                  <path d="M19 21h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3v5a2 2 0 0 1-2 2z"/>
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
                  <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
                </svg>
              )}
              <span>{isDeafened ? 'Undeafen' : 'Deafen'}</span>
              <span className="shortcut-hint">[D]</span>
            </button>

            {/* AUDIO DEVICES TOGGLE BUTTON */}
            <button
              className="dock-btn"
              onClick={() => setShowAudioSettings(true)}
              title="Change Microphone or Speaker"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
              <span>Devices</span>
            </button>

            {/* CALL DIAGNOSTICS TOGGLE */}
            <button
              className="dock-btn"
              onClick={() => setShowDiagnostics(prev => !prev)}
              title="View Real-Time Call Details"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
              <span>Info</span>
            </button>

            {/* PROVISION TO CUT CALL / LEAVE ROOM BUTTON */}
            <button
              className="dock-btn end-call-btn"
              onClick={() => endCallCleanly(true)}
              title="Cut Voice Call / Leave Room (Shortcut: [Esc])"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/>
                <line x1="23" y1="1" x2="1" y2="23"/>
              </svg>
              <span>{activeCall.isRoom ? 'Leave Room' : 'Cut Call'}</span>
            </button>
          </div>

          {/* Diagnostics Modal Dialog */}
          {showDiagnostics && (
            <div className="modal-backdrop" onClick={() => setShowDiagnostics(false)}>
              <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <div className="modal-title">Live Call Diagnostics</div>
                  <button className="modal-close-btn" onClick={() => setShowDiagnostics(false)}>✕</button>
                </div>

                <table className="diag-table">
                  <tbody>
                    <tr>
                      <td>Call Session</td>
                      <td>{activeCall.title}</td>
                    </tr>
                    <tr>
                      <td>Target IP & Port</td>
                      <td>{activeCall.targetIp}:{activeCall.targetPort}</td>
                    </tr>
                    <tr>
                      <td>Local Node IP</td>
                      <td>{localIp}:{standbyPort}</td>
                    </tr>
                    <tr>
                      <td>Participants</td>
                      <td>{participants.length} connected</td>
                    </tr>
                    <tr>
                      <td>Audio Codec</td>
                      <td>Opus 48 kHz / Stereo</td>
                    </tr>
                    <tr>
                      <td>Microphone State</td>
                      <td style={{ color: isMuted ? '#ef4444' : '#10b981' }}>{isMuted ? 'Muted' : 'Transmitting'}</td>
                    </tr>
                    <tr>
                      <td>Selected Microphone</td>
                      <td>{currentMicLabel}</td>
                    </tr>
                    <tr>
                      <td>Speaker State</td>
                      <td style={{ color: isDeafened ? '#f59e0b' : '#10b981' }}>{isDeafened ? 'Deafened' : 'Playing'}</td>
                    </tr>
                    <tr>
                      <td>Selected Speaker</td>
                      <td>{currentSpeakerLabel}</td>
                    </tr>
                    <tr>
                      <td>Session Duration</td>
                      <td>{formatDuration(callDuration)}</td>
                    </tr>
                    <tr>
                      <td>Network Protocol</td>
                      <td>WebSocket Signaling + WebRTC Audio Mesh</td>
                    </tr>
                  </tbody>
                </table>

                <button
                  className="call-btn"
                  style={{ alignSelf: 'flex-end', padding: '8px 16px', fontSize: '0.85rem' }}
                  onClick={() => setShowDiagnostics(false)}
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ====================================================================
          ADD CONTACT MODAL
         ==================================================================== */}
      {showAddContactModal && (
        <div className="modal-backdrop" onClick={() => setShowAddContactModal(false)}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div className="modal-header">
              <div className="modal-title">Add New Contact</div>
              <button className="modal-close-btn" onClick={() => setShowAddContactModal(false)}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '10px' }}>
              <div className="input-field-group">
                <label>Contact Name</label>
                <div className="input-wrapper">
                  <input
                    type="text"
                    placeholder="e.g. Alice's MacBook, Office PC"
                    value={newContactName}
                    onChange={e => setNewContactName(e.target.value)}
                    autoFocus
                  />
                </div>
              </div>
              <div className="input-field-group">
                <label>IP Address</label>
                <div className="input-wrapper">
                  <input
                    type="text"
                    placeholder="e.g. 192.168.1.50"
                    value={newContactIp}
                    onChange={e => setNewContactIp(e.target.value)}
                  />
                </div>
              </div>
              <div className="input-field-group">
                <label>Port (Default 5252)</label>
                <div className="input-wrapper">
                  <input
                    type="text"
                    placeholder="5252"
                    value={newContactPort}
                    onChange={e => setNewContactPort(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
                <button
                  className="dock-btn"
                  onClick={() => setShowAddContactModal(false)}
                >
                  Cancel
                </button>
                <button
                  className="call-btn"
                  style={{ padding: '8px 18px' }}
                  disabled={!newContactName.trim() || !newContactIp.trim()}
                  onClick={handleAddContactSubmit}
                >
                  Save Contact
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          AUDIO DEVICE & PERMISSION SETTINGS MODAL
         ==================================================================== */}
      {showAudioSettings && (
        <div className="modal-backdrop" onClick={() => setShowAudioSettings(false)}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div className="brand-icon-badge" style={{ width: '28px', height: '28px' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="22"/>
                  </svg>
                </div>
                <div className="modal-title">Audio & Device Settings</div>
              </div>
              <button className="modal-close-btn" onClick={() => setShowAudioSettings(false)}>✕</button>
            </div>

            {/* Permission Status Banner */}
            <div className="device-field-header" style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', border: micPermission === 'denied' ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid rgba(255,255,255,0.06)' }}>
              <div>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#cbd5e1' }}>Microphone Permission</div>
                {permissionErrorMsg && (
                  <div style={{ fontSize: '0.74rem', color: '#f87171', marginTop: '2px' }}>
                    {permissionErrorMsg}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className={`permission-chip ${micPermission}`}>
                  {micPermission === 'granted' ? '✓ Granted' : micPermission === 'denied' ? '✕ Denied' : '⚠️ Permission Needed'}
                </span>
                {micPermission === 'denied' ? (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      className="permission-grant-btn"
                      style={{ background: '#3b82f6', padding: '4px 10px', fontSize: '0.75rem' }}
                      onClick={() => window.voiceAPI?.openSystemMicrophoneSettings()}
                      title="Open macOS System Settings to enable Microphone for WiiVoice"
                    >
                      ⚙️ System Settings
                    </button>
                    <button
                      className="permission-grant-btn"
                      style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                      onClick={requestMicPermission}
                      title="Re-check microphone permission"
                    >
                      ↻
                    </button>
                  </div>
                ) : micPermission !== 'granted' ? (
                  <button
                    className="permission-grant-btn"
                    style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                    onClick={requestMicPermission}
                  >
                    Grant Access
                  </button>
                ) : null}
              </div>
            </div>

            {/* Microphone Selection */}
            <div className="device-field-group">
              <div className="device-field-header">
                <span className="device-field-label">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="22"/>
                  </svg>
                  Microphone (Input Device)
                </span>
                <span style={{ fontSize: '0.72rem', color: isMuted ? '#ef4444' : '#10b981' }}>
                  {isMuted ? 'Muted' : `${isRecordingTestClip ? testMicLevel : localAudioLevel}% Input`}
                </span>
              </div>

              <select
                className="device-select"
                value={selectedMicId}
                onChange={e => handleMicChange(e.target.value)}
              >
                <option value="">Default System Microphone</option>
                {audioInputs.map((input, idx) => (
                  <option key={input.deviceId || idx} value={input.deviceId}>
                    {input.label || `Microphone ${idx + 1}`}
                  </option>
                ))}
              </select>

              {/* Real-time microphone VU level indicator */}
              <div style={{ marginTop: '2px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#94a3b8', marginBottom: '4px' }}>
                  <span>Speak to test input sensitivity</span>
                  <span>{isMuted ? 'Muted' : `${isRecordingTestClip ? testMicLevel : localAudioLevel}%`}</span>
                </div>
                <div className="mic-level-track" style={{ height: '8px' }}>
                  <div className="mic-level-fill" style={{ width: `${isMuted ? 0 : (isRecordingTestClip ? testMicLevel : localAudioLevel)}%` }} />
                </div>
              </div>

              {/* MICROPHONE VOICE CLIP TEST & VERIFICATION PROVISION */}
              <div className="mic-test-card">
                <div className="mic-test-header">
                  <div className="mic-test-title">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="22"/>
                    </svg>
                    <span>Record & Test Microphone Voice Clip</span>
                  </div>
                  {isRecordingTestClip && (
                    <span className="permission-chip denied" style={{ animation: 'pulse-red 1s infinite' }}>
                      ● Recording ({testRecordingCountdown}s)
                    </span>
                  )}
                </div>

                <div className="mic-test-desc">
                  Record a short 5-second voice clip through <strong>{currentMicLabel}</strong> to verify audio pickup and listen to how you sound.
                </div>

                {/* Progress bar during recording */}
                {isRecordingTestClip && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#94a3b8', marginBottom: '3px' }}>
                      <span>Recording speech... ({testRecordingCountdown}s left)</span>
                      <span style={{ color: testMicLevel > 10 ? '#10b981' : '#f59e0b' }}>{testMicLevel}% level</span>
                    </div>
                    <div className="mic-test-progress-track">
                      <div
                        className="mic-test-progress-fill"
                        style={{ width: `${((5 - testRecordingCountdown) / 5) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Test Action Buttons */}
                <div className="mic-test-controls">
                  {!isRecordingTestClip ? (
                    <button
                      type="button"
                      className="mic-test-record-btn"
                      onClick={startTestRecording}
                      title="Record 5-second voice clip"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <circle cx="12" cy="12" r="10" fill="#fff" />
                      </svg>
                      <span>{testAudioUrl ? 'Record Again (5s)' : 'Record Test Clip (5s)'}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="mic-test-stop-btn"
                      onClick={stopTestRecording}
                      title="Finish recording and review"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="2" y="2" width="20" height="20" rx="2" />
                      </svg>
                      <span>Stop & Review</span>
                    </button>
                  )}

                  {testAudioUrl && !isRecordingTestClip && (
                    <button
                      type="button"
                      className={`mic-test-play-btn ${isPlayingTestClip ? 'playing' : ''}`}
                      onClick={playTestRecording}
                      title="Play back recorded clip through selected speaker"
                    >
                      {isPlayingTestClip ? (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="4" width="4" height="16" />
                            <rect x="14" y="4" width="4" height="16" />
                          </svg>
                          <span>Pause Playback</span>
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                          <span>Play Back Clip</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Audio Detection Result Status */}
                {testClipDetectedAudio !== null && !isRecordingTestClip && (
                  <div className={`mic-test-result-box ${testClipDetectedAudio ? 'success' : 'warning'}`}>
                    {testClipDetectedAudio ? (
                      <>
                        <span>✓</span>
                        <span>Clear voice audio captured successfully! Your microphone is functioning properly.</span>
                      </>
                    ) : (
                      <>
                        <span>⚠️</span>
                        <span>Low or no voice audio detected. Please check if your microphone is muted or increase volume in system settings.</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Speaker Selection */}
            <div className="device-field-group">
              <div className="device-field-header">
                <span className="device-field-label">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
                    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
                  </svg>
                  Speaker / Headphones (Output Device)
                </span>
                <button
                  type="button"
                  className={`test-sound-btn ${isTestingSpeaker ? 'playing' : ''}`}
                  onClick={handleTestSpeaker}
                  title="Play a test chime to verify speaker output"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                  </svg>
                  <span>{isTestingSpeaker ? 'Playing Chime...' : 'Test Speaker'}</span>
                </button>
              </div>

              <select
                className="device-select"
                value={selectedSpeakerId}
                onChange={e => handleSpeakerChange(e.target.value)}
              >
                <option value="">Default System Speaker</option>
                {audioOutputs.map((output, idx) => (
                  <option key={output.deviceId || idx} value={output.deviceId}>
                    {output.label || `Speaker / Output ${idx + 1}`}
                  </option>
                ))}
              </select>
            </div>

            {/* Audio Engine Processing Details */}
            <div className="audio-enhancements-box">
              <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', color: '#94a3b8' }}>
                Hardware & Audio Engine DSP
              </div>
              <div className="enhancement-item">
                <span>Acoustic Echo Cancellation</span>
                <span className="enhancement-status">Active (Browser DSP)</span>
              </div>
              <div className="enhancement-item">
                <span>Background Noise Suppression</span>
                <span className="enhancement-status">Active</span>
              </div>
              <div className="enhancement-item">
                <span>Automatic Gain Control</span>
                <span className="enhancement-status">Active</span>
              </div>
              <div className="enhancement-item">
                <span>Codec Quality</span>
                <span className="enhancement-status">Opus 48 kHz Ultra-HD</span>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
              <button
                className="call-btn"
                style={{ padding: '8px 20px', fontSize: '0.85rem' }}
                onClick={() => setShowAudioSettings(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
