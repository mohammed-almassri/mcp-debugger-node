import { WebSocket } from "ws";
import IWsClient from "./IWsClient";

export default class WsClient implements IWsClient {
  private ws: WebSocket;
  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on("open", async () => {
        resolve();
      });
      this.ws.on("error", (error) => {
        reject(error);
      });
    });
  }

  send(data: string): void {
    this.ws.send(data);
  }
  close(): void {
    this.ws.close();
  }
  onMessage(handler: (data: string) => void): void {
    this.ws.on("message", (data) => {
      const text = data.toString();
      handler(text);
    });
  }
  onClose(handler: () => void): void {
    this.ws.on("close", () => {
      handler();
    });
  }
  onError(handler: (error: Error) => void): void {
    this.ws.on("error", (error) => {
      handler(error);
    });
  }
}
