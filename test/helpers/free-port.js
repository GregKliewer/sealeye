// A port nothing is listening on, chosen by the operating system. npm test runs the test
// files side by side, and several start an API of their own; a port picked at random
// from a fixed range could be one another file's API already holds, and then a test
// would read that API's answers as its own.
import net from "node:net";

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
