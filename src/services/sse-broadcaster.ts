import { EventEmitter } from 'events';

export type SSEClient = {
  agentId: string;
  res: import('express').Response;
};

class SSEBroadcaster extends EventEmitter {
  private clients: Map<string, SSEClient> = new Map();

  addClient(agentId: string, res: import('express').Response): void {
    this.clients.set(agentId, { agentId, res });
  }

  removeClient(agentId: string): void {
    this.clients.delete(agentId);
  }

  broadcast(eventName: string, data: object): void {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients.values()) {
      try {
        client.res.write(payload);
      } catch {
        // client disconnected, will be cleaned up on 'close'
      }
    }
  }

  getConnectedAgents(): string[] {
    return Array.from(this.clients.keys());
  }

  getConnectionCount(): number {
    return this.clients.size;
  }
}

export const sseBroadcaster = new SSEBroadcaster();
