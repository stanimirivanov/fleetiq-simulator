import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { once } from "node:events";

export async function withUdpPeer(
  handler: (bytes: Buffer, source: RemoteInfo, socket: Socket) => Promise<void>,
  verify: (port: number) => Promise<void>,
  host = "127.0.0.1",
) {
  const socket = createSocket(host === "::1" ? "udp6" : "udp4");
  const tasks: Promise<void>[] = [];
  const errors: unknown[] = [];
  socket.on("message", (bytes, source) =>
    tasks.push(
      handler(bytes, source, socket).catch((error) => {
        errors.push(error);
      }),
    ),
  );
  socket.bind(0, host);
  await once(socket, "listening");
  try {
    await verify(socket.address().port);
  } finally {
    socket.close();
    await once(socket, "close");
    await Promise.all(tasks);
  }
  if (errors.length) throw errors[0];
}
