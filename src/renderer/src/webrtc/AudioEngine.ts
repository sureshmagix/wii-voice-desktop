export class AudioEngine {
  private localStream: MediaStream | null = null;
  private audioElements = new Map<string, HTMLAudioElement>();
  private audioContext: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localSourceNode: MediaStreamAudioSourceNode | null = null;
  private remoteAnalysers = new Map<string, AnalyserNode>();
  private _isMuted = false;
  private _isDeafened = false;
  private selectedInputDeviceId: string = '';
  private selectedOutputDeviceId: string = '';

  // Tone generator state
  private incomingRingInterval: number | null = null;
  private outgoingRingInterval: number | null = null;
  private ringAudioNodes: { stop: () => void }[] = [];

  private getAudioContext(): AudioContext {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
    return this.audioContext;
  }

  private initLocalAnalyser() {
    if (!this.localStream) return;
    try {
      const ctx = this.getAudioContext();
      if (this.localSourceNode) {
        try {
          this.localSourceNode.disconnect();
        } catch {}
        this.localSourceNode = null;
      }
      this.localSourceNode = ctx.createMediaStreamSource(this.localStream);
      this.localAnalyser = ctx.createAnalyser();
      this.localAnalyser.fftSize = 64;
      this.localAnalyser.smoothingTimeConstant = 0.5;
      this.localSourceNode.connect(this.localAnalyser);
    } catch (err) {
      console.warn('[AudioEngine] Could not initialize local analyser:', err);
    }
  }

  public setConfiguredDevices(inputDeviceId: string, outputDeviceId: string) {
    this.selectedInputDeviceId = inputDeviceId;
    this.selectedOutputDeviceId = outputDeviceId;
  }

  public getInputDevice(): string {
    return this.selectedInputDeviceId;
  }

  public getOutputDevice(): string {
    return this.selectedOutputDeviceId;
  }

  public async getLocalStream(deviceId?: string): Promise<MediaStream> {
    const targetDeviceId = deviceId || this.selectedInputDeviceId;

    if (!this.localStream) {
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      };

      try {
        this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        if (targetDeviceId) {
          console.warn('[AudioEngine] Requested microphone failed, falling back to default:', err);
          this.localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            },
            video: false
          });
        } else {
          throw err;
        }
      }

      this.initLocalAnalyser();
    }
    return this.localStream;
  }

  public async setInputDevice(deviceId: string): Promise<MediaStreamTrack | null> {
    this.selectedInputDeviceId = deviceId;
    if (this.localStream) {
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });

        const newTrack = newStream.getAudioTracks()[0];
        if (newTrack) {
          newTrack.enabled = !this._isMuted;
          const oldTracks = this.localStream.getAudioTracks();
          oldTracks.forEach(t => {
            this.localStream?.removeTrack(t);
            t.stop();
          });
          this.localStream.addTrack(newTrack);
          this.initLocalAnalyser();
          return newTrack;
        }
      } catch (err) {
        console.error('[AudioEngine] Error changing input device:', err);
      }
    }
    return null;
  }

  public async setOutputDevice(deviceId: string): Promise<void> {
    this.selectedOutputDeviceId = deviceId;
    for (const [, audio] of this.audioElements) {
      if (typeof (audio as any).setSinkId === 'function') {
        try {
          await (audio as any).setSinkId(deviceId);
        } catch (err) {
          console.warn('[AudioEngine] Failed to setSinkId on audio element:', err);
        }
      }
    }
    if (this.audioContext && typeof (this.audioContext as any).setSinkId === 'function') {
      try {
        await (this.audioContext as any).setSinkId(deviceId);
      } catch {}
    }
  }

  public async playTestTone(outputDeviceId?: string): Promise<void> {
    const targetSink = outputDeviceId || this.selectedOutputDeviceId;
    const ctx = this.getAudioContext();
    const dest = ctx.createMediaStreamDestination();
    const now = ctx.currentTime;

    // Chime Tone 1 (C5: 523.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(523.25, now);
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(dest);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Chime Tone 2 (E5: 659.25 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(659.25, now + 0.16);
    gain2.gain.setValueAtTime(0.001, now);
    gain2.gain.setValueAtTime(0.35, now + 0.16);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc2.connect(gain2);
    gain2.connect(dest);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.16);
    osc2.stop(now + 0.6);

    if (targetSink) {
      try {
        const audio = document.createElement('audio');
        if (typeof (audio as any).setSinkId === 'function') {
          await (audio as any).setSinkId(targetSink);
        }
        audio.srcObject = dest.stream;
        await audio.play();
        setTimeout(() => {
          audio.srcObject = null;
          audio.remove();
        }, 800);
      } catch (err) {
        console.warn('[AudioEngine] Could not play test chime to specific sink:', err);
      }
    }
  }

  // =========================================================================
  // RINGTONES & CALL AUDIO NOTIFICATIONS
  // =========================================================================

  /**
   * Continuous, pleasant, high-contrast incoming call ringtone
   */
  public startIncomingRingtone(outputDeviceId?: string) {
    this.stopIncomingRingtone();
    const targetSink = outputDeviceId || this.selectedOutputDeviceId;

    const playBurst = () => {
      try {
        const ctx = this.getAudioContext();
        const now = ctx.currentTime;
        const dest = ctx.createMediaStreamDestination();

        // Dual pleasant chime frequencies (G5: 784Hz + C6: 1046Hz, then G5 + E6: 1318Hz)
        const notes = [
          { f1: 784, f2: 1046.5, start: 0, dur: 0.35 },
          { f1: 784, f2: 1318.5, start: 0.18, dur: 0.55 }
        ];

        notes.forEach(note => {
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gain = ctx.createGain();

          osc1.type = 'sine';
          osc2.type = 'sine';
          osc1.frequency.setValueAtTime(note.f1, now + note.start);
          osc2.frequency.setValueAtTime(note.f2, now + note.start);

          gain.gain.setValueAtTime(0.001, now);
          gain.gain.setValueAtTime(0.28, now + note.start);
          gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.dur);

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(ctx.destination);
          gain.connect(dest);

          osc1.start(now + note.start);
          osc2.start(now + note.start);
          osc1.stop(now + note.start + note.dur);
          osc2.stop(now + note.start + note.dur);

          this.ringAudioNodes.push({
            stop: () => {
              try { osc1.stop(); osc2.stop(); } catch {}
            }
          });
        });

        if (targetSink) {
          const audio = document.createElement('audio');
          if (typeof (audio as any).setSinkId === 'function') {
            (audio as any).setSinkId(targetSink).catch(() => {});
          }
          audio.srcObject = dest.stream;
          audio.play().catch(() => {});
          setTimeout(() => {
            audio.srcObject = null;
            audio.remove();
          }, 1200);
        }
      } catch (err) {
        console.warn('[AudioEngine] Could not play incoming ring burst:', err);
      }
    };

    // Play immediately and repeat every 2.4 seconds
    playBurst();
    this.incomingRingInterval = window.setInterval(playBurst, 2400);
  }

  public stopIncomingRingtone() {
    if (this.incomingRingInterval !== null) {
      clearInterval(this.incomingRingInterval);
      this.incomingRingInterval = null;
    }
    this.ringAudioNodes.forEach(node => {
      try { node.stop(); } catch {}
    });
    this.ringAudioNodes = [];
  }

  /**
   * Soft, gentle dial tone / ringback tone while calling a peer
   */
  public startOutgoingRingtone(outputDeviceId?: string) {
    this.stopOutgoingRingtone();
    const targetSink = outputDeviceId || this.selectedOutputDeviceId;

    const playPulse = () => {
      try {
        const ctx = this.getAudioContext();
        const now = ctx.currentTime;
        const dest = ctx.createMediaStreamDestination();

        // Standard ringback chord (440Hz + 480Hz)
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'sine';
        osc2.type = 'sine';
        osc1.frequency.setValueAtTime(440, now);
        osc2.frequency.setValueAtTime(480, now);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.08);
        gain.gain.setValueAtTime(0.12, now + 1.1);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.25);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);
        gain.connect(dest);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 1.25);
        osc2.stop(now + 1.25);

        this.ringAudioNodes.push({
          stop: () => {
            try { osc1.stop(); osc2.stop(); } catch {}
          }
        });

        if (targetSink) {
          const audio = document.createElement('audio');
          if (typeof (audio as any).setSinkId === 'function') {
            (audio as any).setSinkId(targetSink).catch(() => {});
          }
          audio.srcObject = dest.stream;
          audio.play().catch(() => {});
          setTimeout(() => {
            audio.srcObject = null;
            audio.remove();
          }, 1500);
        }
      } catch (err) {
        console.warn('[AudioEngine] Could not play outgoing ring pulse:', err);
      }
    };

    playPulse();
    this.outgoingRingInterval = window.setInterval(playPulse, 3200);
  }

  public stopOutgoingRingtone() {
    if (this.outgoingRingInterval !== null) {
      clearInterval(this.outgoingRingInterval);
      this.outgoingRingInterval = null;
    }
    this.ringAudioNodes.forEach(node => {
      try { node.stop(); } catch {}
    });
    this.ringAudioNodes = [];
  }

  /**
   * Brief 3-pulse hangup tone when call is ended / cut
   */
  public playCallEndTone(outputDeviceId?: string) {
    try {
      const ctx = this.getAudioContext();
      const now = ctx.currentTime;
      const targetSink = outputDeviceId || this.selectedOutputDeviceId;
      const dest = ctx.createMediaStreamDestination();

      [0, 0.12, 0.24].forEach(t => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(480, now + t);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.setValueAtTime(0.2, now + t);
        gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.08);

        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.connect(dest);
        osc.start(now + t);
        osc.stop(now + t + 0.08);
      });

      if (targetSink) {
        const audio = document.createElement('audio');
        if (typeof (audio as any).setSinkId === 'function') {
          (audio as any).setSinkId(targetSink).catch(() => {});
        }
        audio.srcObject = dest.stream;
        audio.play().catch(() => {});
        setTimeout(() => {
          audio.srcObject = null;
          audio.remove();
        }, 600);
      }
    } catch {}
  }

  /**
   * Rapid busy tone when call is declined
   */
  public playCallDeclinedTone(outputDeviceId?: string) {
    try {
      const ctx = this.getAudioContext();
      const now = ctx.currentTime;
      const targetSink = outputDeviceId || this.selectedOutputDeviceId;
      const dest = ctx.createMediaStreamDestination();

      [0, 0.2, 0.4].forEach(t => {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        osc1.type = 'sine';
        osc2.type = 'sine';
        osc1.frequency.setValueAtTime(480, now + t);
        osc2.frequency.setValueAtTime(620, now + t);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.setValueAtTime(0.2, now + t);
        gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.12);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);
        gain.connect(dest);
        osc1.start(now + t);
        osc2.start(now + t);
        osc1.stop(now + t + 0.12);
        osc2.stop(now + t + 0.12);
      });

      if (targetSink) {
        const audio = document.createElement('audio');
        if (typeof (audio as any).setSinkId === 'function') {
          (audio as any).setSinkId(targetSink).catch(() => {});
        }
        audio.srcObject = dest.stream;
        audio.play().catch(() => {});
        setTimeout(() => {
          audio.srcObject = null;
          audio.remove();
        }, 800);
      }
    } catch {}
  }

  public setMicrophoneMute(isMuted: boolean) {
    this._isMuted = isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
  }

  public isMuted(): boolean {
    return this._isMuted;
  }

  public setDeafened(isDeafened: boolean) {
    this._isDeafened = isDeafened;
    this.audioElements.forEach(audio => {
      audio.muted = isDeafened;
    });
  }

  public isDeafened(): boolean {
    return this._isDeafened;
  }

  public getLocalAudioLevel(): number {
    if (!this.localAnalyser || this._isMuted) return 0;
    const data = new Uint8Array(this.localAnalyser.frequencyBinCount);
    this.localAnalyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    const avg = sum / (data.length || 1);
    return Math.min(100, Math.round((avg / 128) * 100));
  }

  public getRemoteAudioLevel(peerId: string): number {
    if (this._isDeafened) return 0;
    const analyser = this.remoteAnalysers.get(peerId);
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    const avg = sum / (data.length || 1);
    return Math.min(100, Math.round((avg / 128) * 100));
  }

  public attachRemoteStream(peerId: string, stream: MediaStream) {
    let audio = this.audioElements.get(peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      (audio as any).playsInline = true;
      audio.muted = this._isDeafened;
      if (this.selectedOutputDeviceId && typeof (audio as any).setSinkId === 'function') {
        (audio as any).setSinkId(this.selectedOutputDeviceId).catch(console.warn);
      }
      this.audioElements.set(peerId, audio);
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(console.error);

    try {
      const ctx = this.getAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      this.remoteAnalysers.set(peerId, analyser);
    } catch (err) {
      console.warn('[AudioEngine] Could not initialize remote analyser for', peerId, err);
    }
  }

  public detachRemoteStream(peerId: string) {
    const audio = this.audioElements.get(peerId);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      this.audioElements.delete(peerId);
    }
    this.remoteAnalysers.delete(peerId);
  }

  public cleanup() {
    this.stopIncomingRingtone();
    this.stopOutgoingRingtone();

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this.audioElements.forEach(audio => {
      audio.srcObject = null;
      audio.remove();
    });
    this.audioElements.clear();
    this.remoteAnalysers.clear();
    if (this.localSourceNode) {
      try { this.localSourceNode.disconnect(); } catch {}
      this.localSourceNode = null;
    }
    this.localAnalyser = null;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this._isMuted = false;
    this._isDeafened = false;
  }
}
