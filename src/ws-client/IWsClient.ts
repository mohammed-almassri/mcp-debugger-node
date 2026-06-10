export default interface IWsClient {
  send: (data: string) => void;
  close: () => void;
  connect: () => Promise<void>;
  onMessage: (handler: (data: string) => void) => void;
  onClose: (handler: () => void) => void;
  onError: (handler: (error: Error) => void) => void;
}
