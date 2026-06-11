import { RawData, WebSocket } from "ws";
import IWsClient from "./IWsClient";

const rawDataToString = (data: RawData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString();
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString();
  }

  return data.toString();
};

export default class WsClient implements IWsClient {
  private ws: WebSocket;
  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on("open", () => {
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
      const text = rawDataToString(data);
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
