// A JSON-RPC error answer: the code and message go back as the response's
// error, with optional data.
export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
