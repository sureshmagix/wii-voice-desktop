import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { PeerInfo, SignalingMessage } from '../protocol/types.ts';

interface ClientSocket {
  ws: WebSocket;
  peerInfo?: PeerInfo;
}

export class SignalingServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientSocket>();
  private hostInfo: PeerInfo;
  private epoch = 1;
  public onIncomingCall?: (caller: PeerInfo, callId: string) => void;

  constructor(hostInfo: PeerInfo, onIncomingCall?: (caller: PeerInfo, callId: string) => void) {
    this.hostInfo = hostInfo;
    this.onIncomingCall = onIncomingCall;
  }

  public updateHostInfo(info: PeerInfo) {
    this.hostInfo = info;
  }

  public start(port: number = 5252): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryListen = (currentPort: number) => {
        const server = new WebSocketServer({ port: currentPort }, () => {
          this.wss = server;
          const boundPort = (server.address() as any).port;
          this.bindEvents();
          resolve(boundPort);
        });

        server.once('error', (err: any) => {
          if (err.code === 'EADDRINUSE' && currentPort !== 0) {
            console.warn(`[SignalingServer] Port ${currentPort} is already in use. Retrying with dynamic port 0.`);
            tryListen(0);
          } else {
            reject(err);
          }
        });
      };

      tryListen(port);
    });
  }

  private bindEvents() {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket, req: any) => {
      const client: ClientSocket = { ws };
      const ip = req?.socket?.remoteAddress || '';
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        client.peerInfo = this.hostInfo;
      }
      this.clients.add(client);

      ws.on('message', (raw: RawData) => {
        try {
          const msg: SignalingMessage = JSON.parse(raw.toString());
          this.handleMessage(client, msg);
        } catch (err) {
          console.error('[SignalingServer] Parse error:', err);
        }
      });

      ws.on('error', (err) => {
        console.error('[SignalingServer] Client socket error:', err);
      });

      ws.on('close', () => {
        this.clients.delete(client);
        if (client.peerInfo) {
          this.broadcast({ type: 'PEER_LEFT', peerId: client.peerInfo.deviceId });
          if (client.peerInfo.deviceId !== this.hostInfo.deviceId) {
            this.broadcastRoomState();
          }
        }
      });
    });
  }

  private handleMessage(client: ClientSocket, msg: SignalingMessage) {
    if (!client.peerInfo) {
      if ('peer' in msg && (msg as any).peer) {
        client.peerInfo = (msg as any).peer;
      } else if ('caller' in msg && (msg as any).caller) {
        client.peerInfo = (msg as any).caller;
      } else if ('recipient' in msg && (msg as any).recipient) {
        client.peerInfo = (msg as any).recipient;
      } else if ('from' in msg && (msg as any).from) {
        client.peerInfo = {
          deviceId: (msg as any).from,
          deviceName: 'LAN Peer',
          platform: 'desktop',
          isPluggedIn: true,
          lanIp: '',
          signalingPort: 5252,
          joinedAt: Date.now()
        };
      }
    }
    switch (msg.type) {
      case 'CALL_INVITE': {
        client.peerInfo = msg.caller;
        // Notify main process for OS notification & window focus
        this.onIncomingCall?.(msg.caller, msg.callId);
        // Forward call invite to other connected clients (e.g. host's renderer)
        this.broadcastExcept(client, msg);
        break;
      }
      case 'CALL_RINGING': {
        client.peerInfo = msg.recipient;
        this.broadcastExcept(client, msg);
        break;
      }
      case 'CALL_ACCEPTED': {
        client.peerInfo = msg.recipient;
        this.broadcastExcept(client, msg);
        this.broadcastRoomState();
        break;
      }
      case 'CALL_DECLINED': {
        this.broadcastExcept(client, msg);
        break;
      }
      case 'CALL_CANCELLED': {
        this.broadcastExcept(client, msg);
        break;
      }
      case 'CALL_HANGUP': {
        this.broadcastExcept(client, msg);
        break;
      }
      case 'JOIN_REQUEST': {
        client.peerInfo = msg.peer;
        this.broadcastRoomState();
        break;
      }
      case 'SDP_OFFER':
      case 'SDP_ANSWER':
      case 'ICE_CANDIDATE': {
        this.forwardTargeted(msg.to, msg, client);
        break;
      }
      case 'PING': {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ type: 'PONG' }));
        }
        break;
      }
      case 'PONG': {
        break;
      }
    }
  }

  private forwardTargeted(targetDeviceId: string, msg: SignalingMessage, sender?: ClientSocket) {
    for (const client of this.clients) {
      if (client.peerInfo?.deviceId === targetDeviceId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(msg));
        return;
      }
    }
    // If not found by deviceId, send to all other clients except sender as fallback
    for (const client of this.clients) {
      if (client !== sender && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(msg));
      }
    }
  }

  public broadcastExcept(sender: ClientSocket, msg: SignalingMessage) {
    const raw = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client !== sender && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(raw);
      }
    }
  }

  public broadcast(msg: SignalingMessage) {
    const raw = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(raw);
      }
    }
  }

  public broadcastRoomState() {
    const peersById = new Map<string, PeerInfo>([[this.hostInfo.deviceId, this.hostInfo]]);
    for (const client of this.clients) {
      if (client.peerInfo) peersById.set(client.peerInfo.deviceId, client.peerInfo);
    }

    const stateMsg: SignalingMessage = {
      type: 'ROOM_STATE',
      hostId: this.hostInfo.deviceId,
      epoch: this.epoch,
      peers: Array.from(peersById.values())
    };

    this.broadcast(stateMsg);
  }

  public stop() {
    if (this.wss) {
      for (const client of this.clients) {
        client.ws.close(1001, 'Meeting ended');
      }
      this.wss.close();
      this.wss = null;
      this.clients.clear();
    }
  }
}
