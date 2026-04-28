import { io, type Socket } from 'socket.io-client';
import { useArgo } from './store.js';

let socket: Socket | null = null;

type ServerEvent =
  | { type: 'activity'; payload: import('../api/client.js').ActivityEntry }
  | {
      type: 'operation_status';
      operationId: string;
      status: import('../api/client.js').Operation['status'];
    }
  | {
      type: 'deploy_progress';
      operationId: string;
      evt: {
        phase: 'thinking' | 'generating_code' | 'quality_gate' | 'security_scan' | 'verifying' | 'testing' | 'creating_sandbox' | 'uploading_files' | 'installing_dependencies' | 'starting_process' | 'health_check' | 'ready';
        message: string;
        filesUploaded?: number;
        filesTotal?: number;
        publicUrl?: string;
        cycle?: number;
        filesGenerated?: number;
      };
    }
  | { type: 'map_updated'; operationId: string; version: number };

export function connectSocket(): Socket {
  if (socket && socket.connected) return socket;
  socket = io({
    path: '/socket.io',
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });

  socket.on('event', (raw: unknown) => {
    const event = raw as ServerEvent;
    const argo = useArgo.getState();
    if (event.type === 'activity') argo.pushActivity(event.payload);
    if (event.type === 'operation_status') {
      const existing = argo.operations.find((o) => o.id === event.operationId);
      if (existing) argo.upsertOperation({ ...existing, status: event.status });
    }
    if (event.type === 'deploy_progress') {
      const evt = event.evt;
      switch (evt.phase) {
        case 'thinking':
        case 'generating_code':
          argo.setDeploy({ phase: 'building', message: evt.message });
          break;
        case 'quality_gate':
        case 'security_scan':
        case 'verifying':
          argo.setDeploy({ phase: 'testing', message: evt.message });
          break;
        case 'testing':
          argo.setDeploy({ phase: 'testing', message: evt.message });
          break;
        case 'creating_sandbox':
        case 'installing_dependencies':
        case 'starting_process':
        case 'health_check':
          argo.setDeploy({ phase: 'deploying', message: evt.message });
          break;
        case 'uploading_files':
          argo.setDeploy({
            phase: 'deploying',
            message: evt.message,
            filesUploaded: evt.filesUploaded,
            filesTotal: evt.filesTotal,
          });
          break;
        case 'ready':
          argo.setDeploy({ phase: 'ready', publicUrl: evt.publicUrl ?? '' });
          break;
      }
    }
  });

  socket.on('disconnect', () => {
    // No-op; reconnect handled by socket.io.
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
