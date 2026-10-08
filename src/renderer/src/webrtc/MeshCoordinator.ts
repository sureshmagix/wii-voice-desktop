import { PeerInfo, SignalingMessage, DataChannelMessage } from '../../../protocol/types.ts';

export interface PeerNode {
  info: PeerInfo;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isPolite: boolean;
  iceQueue: RTCIceCandidateInit[];
  missedPings: number;
}

export class MeshCoordinator {
  private peers = new Map<string, PeerNode>();
  private localStream: MediaStream | null = null;
  private localInfo: PeerInfo;
  private sendSignaling: (msg: SignalingMessage) => void;
  private onRemoteStream: (peerId: string, stream: MediaStream) => void;
  private onPeerDropped: (peerId: string) => void;
  private onPeerMuted?: (peerId: string, isMuted: boolean) => void;

  constructor(
    localInfo: PeerInfo,
    sendSignaling: (msg: SignalingMessage) => void,
    onRemoteStream: (peerId: string, stream: MediaStream) => void,
    onPeerDropped: (peerId: string) => void,
    onPeerMuted?: (peerId: string, isMuted: boolean) => void
  ) {
    this.localInfo = localInfo;
    this.sendSignaling = sendSignaling;
    this.onRemoteStream = onRemoteStream;
    this.onPeerDropped = onPeerDropped;
    this.onPeerMuted = onPeerMuted;
  }

  public setLocalStream(stream: MediaStream) {
    this.localStream = stream;
    this.peers.forEach(peer => {
      const senders = peer.pc.getSenders();
      const hasAudioSender = senders.some(s => s.track && s.track.kind === 'audio');
      if (!hasAudioSender) {
        this.localStream?.getAudioTracks().forEach(t => {
          try {
            peer.pc.addTrack(t, this.localStream!);
          } catch (e) {
            console.warn('[MeshCoordinator] Error adding track:', e);
          }
        });
      }
    });
  }

  public async replaceAudioTrack(newTrack: MediaStreamTrack) {
    if (this.localStream) {
      const oldTracks = this.localStream.getAudioTracks();
      oldTracks.forEach(t => {
        if (t !== newTrack) {
          this.localStream?.removeTrack(t);
          t.stop();
        }
      });
      if (!this.localStream.getAudioTracks().includes(newTrack)) {
        this.localStream.addTrack(newTrack);
      }
    }

    for (const [, peerNode] of this.peers) {
      const senders = peerNode.pc.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      if (audioSender) {
        try {
          await audioSender.replaceTrack(newTrack);
        } catch (err) {
          console.warn('Could not replaceTrack on peer:', peerNode.info.deviceId, err);
        }
      }
    }
  }

  public addPeer(info: PeerInfo, initiateOffer: boolean) {
    if (this.peers.has(info.deviceId)) return;

    const pc = new RTCPeerConnection({ iceServers: [] });
    const isPolite = this.localInfo.deviceId.localeCompare(info.deviceId) > 0;

    const node: PeerNode = {
      info,
      pc,
      channel: null,
      makingOffer: false,
      ignoreOffer: false,
      isPolite,
      iceQueue: [],
      missedPings: 0
    };

    this.peers.set(info.deviceId, node);
    this.bindConnection(node, initiateOffer);
  }

  private bindConnection(node: PeerNode, initiateOffer: boolean) {
    const { pc, info } = node;

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => pc.addTrack(t, this.localStream!));
    }

    pc.ontrack = (evt) => {
      const stream = (evt.streams && evt.streams[0]) ? evt.streams[0] : new MediaStream([evt.track]);
      this.onRemoteStream(info.deviceId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.dropPeer(info.deviceId);
      }
    };

    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        this.sendSignaling({
          type: 'ICE_CANDIDATE',
          from: this.localInfo.deviceId,
          to: info.deviceId,
          candidate: evt.candidate.toJSON()
        });
      }
    };

    if (initiateOffer) {
      const channel = pc.createDataChannel('meeting-control');
      this.setupDataChannel(node, channel);
    } else {
      pc.ondatachannel = (evt) => this.setupDataChannel(node, evt.channel);
    }

    pc.onnegotiationneeded = async () => {
      if (!initiateOffer && pc.signalingState === 'stable' && !pc.remoteDescription) {
        return;
      }
      try {
        node.makingOffer = true;
        await pc.setLocalDescription();
        this.sendSignaling({
          type: 'SDP_OFFER',
          from: this.localInfo.deviceId,
          to: info.deviceId,
          sdp: pc.localDescription!.sdp
        });
      } catch (err) {
        console.error('Negotiation error:', err);
      } finally {
        node.makingOffer = false;
      }
    };
  }

  private setupDataChannel(node: PeerNode, channel: RTCDataChannel) {
    node.channel = channel;
    channel.onmessage = (evt) => {
      try {
        const msg: DataChannelMessage = JSON.parse(evt.data);
        if (msg.type === 'PING') {
          channel.send(JSON.stringify({ type: 'PONG' }));
        } else if (msg.type === 'PONG') {
          node.missedPings = 0;
        } else if (msg.type === 'PEER_MUTED') {
          this.onPeerMuted?.(msg.peerId, msg.isMuted);
        }
      } catch (err) {
        console.warn('Failed to parse data channel message:', err);
      }
    };
  }

  public broadcastMute(isMuted: boolean) {
    const payload: DataChannelMessage = {
      type: 'PEER_MUTED',
      peerId: this.localInfo.deviceId,
      isMuted
    };
    const raw = JSON.stringify(payload);
    this.peers.forEach(peerNode => {
      if (peerNode.channel && peerNode.channel.readyState === 'open') {
        try {
          peerNode.channel.send(raw);
        } catch (e) {
          console.warn('Could not send mute message to peer', peerNode.info.deviceId, e);
        }
      }
    });
  }

  public async handleOffer(fromId: string, sdp: string, peerInfo?: PeerInfo) {
    let node = this.peers.get(fromId);
    if (!node) {
      const fallbackInfo: PeerInfo = peerInfo || {
        deviceId: fromId,
        deviceName: `Peer-${fromId.slice(0, 4)}`,
        platform: 'desktop',
        isPluggedIn: true,
        lanIp: '',
        signalingPort: 5252,
        joinedAt: Date.now()
      };
      this.addPeer(fallbackInfo, false);
      node = this.peers.get(fromId);
    }
    if (!node) return;

    const offerCollision = node.makingOffer || node.pc.signalingState !== 'stable';
    node.ignoreOffer = !node.isPolite && offerCollision;
    if (node.ignoreOffer) return;

    if (offerCollision && node.isPolite) {
      await node.pc.setLocalDescription({ type: 'rollback' });
    }

    await node.pc.setRemoteDescription({ type: 'offer', sdp });

    for (const c of node.iceQueue) {
      try {
        await node.pc.addIceCandidate(c);
      } catch (err) {
        console.warn('Error applying queued ICE candidate in offer:', err);
      }
    }
    node.iceQueue = [];

    await node.pc.setLocalDescription();
    this.sendSignaling({
      type: 'SDP_ANSWER',
      from: this.localInfo.deviceId,
      to: fromId,
      sdp: node.pc.localDescription!.sdp
    });
  }

  public async handleAnswer(fromId: string, sdp: string) {
    const node = this.peers.get(fromId);
    if (!node) return;
    await node.pc.setRemoteDescription({ type: 'answer', sdp });

    for (const c of node.iceQueue) {
      try {
        await node.pc.addIceCandidate(c);
      } catch (err) {
        console.warn('Error applying queued ICE candidate in answer:', err);
      }
    }
    node.iceQueue = [];
  }

  public async handleCandidate(fromId: string, candidate: RTCIceCandidateInit) {
    const node = this.peers.get(fromId);
    if (!node) return;

    // Candidates belong to an offer we deliberately ignored during a perfect-
    // negotiation collision, so they must not be added to our active offer.
    if (node.ignoreOffer) return;

    if (node.pc.remoteDescription?.type) {
      try {
        await node.pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn('[MeshCoordinator] Error adding candidate:', e);
      }
    } else {
      node.iceQueue.push(candidate);
    }
  }

  public dropPeer(peerId: string) {
    const node = this.peers.get(peerId);
    if (!node) return;

    this.peers.delete(peerId);
    node.channel?.close();
    node.pc.close();
    this.onPeerDropped(peerId);
  }

  public pingTick() {
    this.peers.forEach((node, peerId) => {
      if (node.channel?.readyState === 'open') {
        node.missedPings++;
        if (node.missedPings >= 3) {
          this.dropPeer(peerId);
        } else {
          node.channel.send(JSON.stringify({ type: 'PING' }));
        }
      }
    });
  }

  public cleanup() {
    [...this.peers.keys()].forEach(peerId => this.dropPeer(peerId));
  }
}
