import { once } from "node:events";
import { createServer, type Socket } from "node:net";

export async function withPeer(
  handler: (socket: Socket, attempt: number) => Promise<void>,
  verify: (port: number) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  const tasks: Promise<void>[] = [];
  const errors: unknown[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setNoDelay(true);
    tasks.push(
      handler(socket, tasks.length + 1).catch((error) => {
        errors.push(error);
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing-peer");
  try {
    await verify(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(tasks);
  }
  if (errors.length) throw errors[0];
}

export function reader(socket: Socket) {
  const chunks = socket.iterator({ destroyOnReturn: false });
  let buffered = Buffer.alloc(0);
  return async (size: number) => {
    while (buffered.length < size) {
      const chunk = await chunks.next();
      if (chunk.done) throw new Error("unexpected-client-close");
      buffered = Buffer.concat([buffered, chunk.value]);
    }
    const result = buffered.subarray(0, size);
    buffered = buffered.subarray(size);
    return result;
  };
}
